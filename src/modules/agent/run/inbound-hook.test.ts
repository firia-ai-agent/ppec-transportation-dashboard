import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { Db } from "@/db/exec";
import { ingestInbound } from "@/modules/messaging/inbound";
import { FakeOutboxTransport } from "@/modules/outbox/transport";
import { TEST_NOW } from "@/test/clock";
import { F1_NUMBER, PEPPER, UNKNOWN_NUMBER, seedPersona } from "@/test/messaging";
import { freshDb, SITE } from "@/test/pglite";
import { SIM_CENTER_NUMBER } from "@/modules/messaging/sim-numbers";
import { agentRunInboundHook, configuredRouting } from "./inbound-hook";
import type { AgentWake } from "./queue";
import { runWakeKey } from "./queue";

/**
 * The §11.1 `msg.inbound` trigger, through the real webhook ingest (PRD l.924, MSG-01, MSG-03,
 * AT-09).
 *
 * Driven through `ingestInbound` rather than by calling the hook directly, because the claims
 * worth holding are all about *when* the webhook calls it: once per message, never for an unknown
 * sender, never for our own echo, and with the wake-up published only after the transaction that
 * wrote both rows has committed.
 */

let pg: PGlite;
let db: Db;
let outbox: FakeOutboxTransport;
let published: { msg: AgentWake; key: string }[];

const transport = {
  publish: async (msg: AgentWake, opts: { idempotencyKey: string }) => {
    published.push({ msg, key: opts.idempotencyKey });
  },
};

const ROUTING = { model: "test-model", provider: "test-vendor" };

async function post(body: string, opts: { from?: string; sid?: string } = {}) {
  return ingestInbound(
    db,
    { pepper: PEPPER, transport: outbox, hook: agentRunInboundHook(transport, ROUTING), clock: () => TEST_NOW },
    "raw",
    {
      MessageSid: opts.sid ?? "SM-run-1",
      From: opts.from ?? F1_NUMBER,
      To: SIM_CENTER_NUMBER,
      Body: body,
      SimSentAt: TEST_NOW,
    },
  );
}

async function runs() {
  const r = await db.query<{ id: string; site_id: string; trigger_type: string; trigger_id: string; state: string; model: string; provider_routed: string }>(
    "SELECT id, site_id, trigger_type, trigger_id, state, model, provider_routed FROM ops.agent_run ORDER BY created_at, id",
    [],
  );
  return r.rows;
}

beforeEach(async () => {
  ({ pg, db } = await freshDb());
  outbox = new FakeOutboxTransport();
  published = [];
  await seedPersona(db, F1_NUMBER, { siteId: SITE, now: TEST_NOW });
});

afterEach(async () => {
  await pg.close();
});

describe("an inbound family message starts one agent run", () => {
  it("writes the run with the message as its trigger, and wakes it after the commit", async () => {
    const r = await post("will the van be late today");
    expect(r.status).toBe(200);

    const rows = await runs();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      site_id: SITE,
      trigger_type: "msg.inbound",
      trigger_id: r.body.messageId,
      state: "QUEUED",
      model: ROUTING.model,
      provider_routed: ROUTING.provider,
    });
    expect(published).toEqual([
      { msg: { runId: rows[0].id, siteId: SITE }, key: runWakeKey(rows[0].id) },
    ]);
  });

  it("makes one run out of a redelivered webhook (MSG-01: same provider id, no second effect)", async () => {
    await post("will the van be late today");
    const again = await post("will the van be late today");
    expect(again.body.duplicate).toBe(true);
    expect(await runs()).toHaveLength(1);
    expect(published).toHaveLength(1);
  });

  it("starts a second run for a second message, each keyed on its own row", async () => {
    await post("first", { sid: "SM-run-1" });
    await post("second", { sid: "SM-run-2" });
    const rows = await runs();
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((x) => x.trigger_id)).size).toBe(2);
    expect(published).toHaveLength(2);
  });

  it("starts no run for a sender this site does not know (AT-09)", async () => {
    const r = await post("text my new number instead", { from: UNKNOWN_NUMBER });
    expect(r.body.known).toBe(false);
    expect(await runs()).toHaveLength(0);
    expect(published).toEqual([]);
  });

  it("starts no run for our own echo (MSG-03)", async () => {
    const r = await post("PPEC: your child's van is on the way", { from: SIM_CENTER_NUMBER });
    expect(r.body.echo).toBe(true);
    expect(await runs()).toHaveLength(0);
    expect(published).toEqual([]);
  });

  it("records the configured routing, so a run says which vendor it was started for", () => {
    const routing = configuredRouting({});
    expect(routing.model.length).toBeGreaterThan(0);
    expect(routing.provider.length).toBeGreaterThan(0);
  });
});
