/**
 * The run as a **queue job** (PRD §11.1 l.924), end to end through the publisher and the consumer:
 * one trigger makes one run and one message, and one delivery drives it under the lease.
 *
 * The route is the thin half of this (`src/app/api/queues/agent/route.ts` and its own suite); what
 * is asserted here is everything the route hands over: the payload contract, the Queues-side
 * idempotency key, the refusals that are a no-op-and-ack, and the delivery knobs that have to agree
 * with the lease or the recovery story does not hold.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { Db } from "@/db/exec";
import { MAX_DELIVERIES } from "@/modules/jobs/scheduler";
import { TEST_NOW } from "@/test/clock";
import { SITE, freshDb } from "@/test/pglite";
import { AGENT_RUN_LEASE_SECONDS, acquireRunLease } from "./lease";
import { AT01_EXECUTORS, AT01_FACTS, AT01_SCRIPT, at01Policy, runHarness } from "./harness";
import {
  AGENT_QUEUE_RETRY_AFTER_SECONDS,
  AGENT_QUEUE_VISIBILITY_TIMEOUT_SECONDS,
  AGENT_RUN_MAX_DURATION_SECONDS,
  AGENT_TOPIC,
  type AgentWake,
  type AgentWakeTransport,
  agentRetryDirective,
  agentWakeLog,
  enqueueRun,
  handleAgentWake,
  runWakeKey,
} from "./queue";
import { loadRun, toolCalls } from "./store";
import type { Trigger } from "./triggers";

const TRIGGER: Trigger = { type: "msg.inbound", id: "MSG-1", siteId: SITE };
const ROUTING = { model: "anthropic/claude-sonnet", provider: "openrouter" };
const OTHER_SITE = "00000000-0000-7000-8000-0000000000ff";

/** What Queues is handed, in order. Fails on demand, like `FakeOutboxTransport`. */
class FakeAgentTransport implements AgentWakeTransport {
  sent: { msg: AgentWake; idempotencyKey: string }[] = [];
  failNext = 0;
  async publish(msg: AgentWake, opts: { idempotencyKey: string }) {
    if (this.failNext > 0) { this.failNext--; throw new Error("fake publish failure"); }
    this.sent.push({ msg, idempotencyKey: opts.idempotencyKey });
  }
}

let pg: PGlite;
let db: Db;
let now: Date;
const open: PGlite[] = [];

beforeEach(async () => {
  ({ pg, db } = await freshDb());
  open.push(pg);
  now = new Date(TEST_NOW);
}, 60_000);

afterEach(async () => {
  await Promise.all(open.splice(0).map((h) => h.close().catch(() => {})));
});

const at01 = (offset = 0) =>
  runHarness({
    db, script: AT01_SCRIPT, facts: AT01_FACTS, policy: at01Policy(),
    overrides: AT01_EXECUTORS, now: () => now,
  }).deps(offset);

const runs = async () =>
  (await db.query<{ id: string }>("SELECT id FROM ops.agent_run ORDER BY created_at", [])).rows;

describe("§11.1 a trigger makes one run and one wake-up", () => {
  it("enqueueRun writes the run and publishes one message for it, keyed on the run", async () => {
    const transport = new FakeAgentTransport();
    const { runId, created } = await enqueueRun(db, transport, TRIGGER, ROUTING);

    expect(created).toBe(true);
    expect((await loadRun(db, runId))!.state).toBe("QUEUED");
    expect(transport.sent).toEqual([{ msg: { runId, siteId: SITE }, idempotencyKey: runWakeKey(runId) }]);
    // Nothing was driven: the run is the queue's work now, not the caller's.
    expect(await toolCalls(db, runId)).toEqual([]);
  });

  it("a duplicate trigger is the same run and the same message key, so a redelivery collapses", async () => {
    const transport = new FakeAgentTransport();
    const first = await enqueueRun(db, transport, TRIGGER, ROUTING);
    const again = await enqueueRun(db, transport, TRIGGER, ROUTING);

    expect([first.runId, again.runId, again.created]).toEqual([first.runId, first.runId, false]);
    expect(await runs()).toHaveLength(1);
    // Two publishes, one key: Queues' own idempotency is what makes the second one free, and the
    // second publish is deliberate — the run that already exists may be one whose driver died.
    expect(transport.sent.map((s) => s.idempotencyKey)).toEqual([runWakeKey(first.runId), runWakeKey(first.runId)]);
  });

  it("a failed publish throws rather than leaving a run nobody was told about", async () => {
    const transport = new FakeAgentTransport();
    transport.failNext = 1;
    await expect(enqueueRun(db, transport, TRIGGER, ROUTING)).rejects.toThrow("fake publish failure");

    // The row is there, QUEUED, and `startRun` is idempotent — so the caller's own retry publishes
    // for the same run instead of making a second one. That is the recovery; there is no
    // agent-side sweeper that would notice a QUEUED run on its own.
    const [row] = await runs();
    expect((await loadRun(db, row.id))!.state).toBe("QUEUED");
    const retried = await enqueueRun(db, transport, TRIGGER, ROUTING);
    expect([retried.runId, retried.created]).toEqual([row.id, false]);
    expect(transport.sent).toHaveLength(1);
  });
});

describe("one delivery drives one run", () => {
  it("drives the run the message names, under the lease, and reports what it did", async () => {
    const transport = new FakeAgentTransport();
    const { runId } = await enqueueRun(db, transport, TRIGGER, ROUTING);

    const r = await handleAgentWake(db, transport.sent[0].msg, { deps: at01() });

    expect(r).toMatchObject({ ok: true, runId, reclaimed: false });
    if (!r.ok) throw new Error("unreachable");
    expect([r.result.state, r.result.steps]).toEqual(["SUCCEEDED", 3]);
    expect(agentWakeLog(r)).toBe(`run=${runId} SUCCEEDED steps=3`);
    expect((await toolCalls(db, runId)).map((c) => c.status)).toEqual(["EXECUTED", "EXECUTED", "EXECUTED"]);
  });

  it("a duplicate delivery of the same message is a no-op: the run is already finished", async () => {
    const transport = new FakeAgentTransport();
    const { runId } = await enqueueRun(db, transport, TRIGGER, ROUTING);
    const message = transport.sent[0].msg;

    const first = await handleAgentWake(db, message, { deps: at01() });
    expect(first).toMatchObject({ ok: true });
    const second = await handleAgentWake(db, message, { deps: at01(3) });

    expect(second).toEqual({ ok: false, refused: "finished", runId });
    expect(agentWakeLog(second)).toBe(`refused finished run=${runId}`);
    // Three calls, not six: the second delivery executed nothing.
    expect(await toolCalls(db, runId)).toHaveLength(3);
  });

  it("a delivery for a run another driver holds is refused, and takes no model turn", async () => {
    const transport = new FakeAgentTransport();
    const { runId } = await enqueueRun(db, transport, TRIGGER, ROUTING);
    const held = await acquireRunLease(db, runId, { siteId: SITE, now });
    expect(held.ok).toBe(true);

    const deps = at01();
    const r = await handleAgentWake(db, transport.sent[0].msg, { deps });

    expect(r).toEqual({ ok: false, refused: "leased", runId });
    expect(deps.gateway.auditLog).toEqual([]);
    expect(await toolCalls(db, runId)).toEqual([]);
  });

  it("a message naming another tenant's run is refused `wrong-site` and drives nothing (F3)", async () => {
    const transport = new FakeAgentTransport();
    const { runId } = await enqueueRun(db, transport, TRIGGER, ROUTING);
    const before = await loadRun(db, runId);

    const deps = at01();
    const r = await handleAgentWake(db, { runId, siteId: OTHER_SITE }, { deps });

    expect(r).toEqual({ ok: false, refused: "wrong-site", runId });
    expect(await loadRun(db, runId)).toEqual(before);
    expect(deps.gateway.auditLog).toEqual([]);
  });

  /**
   * At-least-once and unordered means a payload from another environment or an older deployment can
   * arrive here. It is acked, not thrown back: with no DLQ, a throw is a hot loop on a message that
   * will never parse. The detail names the fields and never their values — they came from outside.
   */
  it.each([
    ["not an object", 42, "(root)"],
    ["no site", { runId: "00000000-0000-7000-8000-00000000000a" }, "siteId"],
    ["ids that are not ids", { runId: "MSG-1", siteId: "S1" }, "runId,siteId"],
  ])("a %s payload is refused `malformed`, naming the fields", async (_why, message, fields) => {
    const deps = at01();
    const r = await handleAgentWake(db, message, { deps });

    expect(r).toEqual({ ok: false, refused: "malformed", detail: fields });
    expect(agentWakeLog(r)).toBe(`refused malformed fields=${fields}`);
    expect(deps.gateway.auditLog).toEqual([]);
    expect(await runs()).toEqual([]);
  });

  it("a drive that throws propagates, so the delivery is retried rather than acked", async () => {
    const transport = new FakeAgentTransport();
    const { runId } = await enqueueRun(db, transport, TRIGGER, ROUTING);
    const deps = runHarness({
      db, script: AT01_SCRIPT, facts: AT01_FACTS, policy: at01Policy(), now: () => now,
      overrides: { ...AT01_EXECUTORS, get_leg_state: async () => { throw new Error("process died"); } },
      isFatal: (e) => e instanceof Error && e.message === "process died",
    }).deps(0);

    await expect(handleAgentWake(db, transport.sent[0].msg, { deps })).rejects.toThrow("process died");
    // The run is left as it was found, for the redelivery to reclaim once the lease lapses.
    expect((await loadRun(db, runId))!.state).toBe("RUNNING");
  });
});

describe("the delivery knobs agree with the lease", () => {
  /**
   * Not style: each of these is a number the recovery story rests on.
   *
   * The lease is longer than the invocation, so a live driver cannot lose its claim; the visibility
   * timeout and the retry delay are longer than the lease, so the first redelivery after a crash
   * finds a run it can actually reclaim rather than spending a delivery on a `leased` refusal.
   */
  it("lease > maxDuration, and both redelivery intervals > lease", () => {
    expect(AGENT_RUN_LEASE_SECONDS).toBeGreaterThan(AGENT_RUN_MAX_DURATION_SECONDS);
    expect(AGENT_QUEUE_VISIBILITY_TIMEOUT_SECONDS).toBeGreaterThan(AGENT_RUN_LEASE_SECONDS);
    expect(AGENT_QUEUE_RETRY_AFTER_SECONDS).toBe(AGENT_RUN_LEASE_SECONDS);
    expect(AGENT_TOPIC).toBe("ppec-agent");
  });

  it("the retry directive waits out the lease, then acknowledges at MAX_DELIVERIES", () => {
    expect(agentRetryDirective(1)).toEqual({ afterSeconds: AGENT_RUN_LEASE_SECONDS });
    expect(agentRetryDirective(MAX_DELIVERIES - 1)).toEqual({ afterSeconds: AGENT_RUN_LEASE_SECONDS });
    expect(agentRetryDirective(MAX_DELIVERIES)).toEqual({ acknowledge: true });
    expect(agentRetryDirective(MAX_DELIVERIES + 50)).toEqual({ acknowledge: true });
  });
});
