/**
 * B-08 slice 4, §11.2 `request_provider_capability` — "capability UNKNOWN at T−90 or on
 * substitution → signed dispatcher link; state REQUESTED".
 *
 * This is also where the **dispatcher egress path** is proved end to end: a provider's dispatcher is
 * `identity.external_person_identity` rather than a guardian contact, so the outbox's send-time
 * check has to recognize them (`outbox/policy.recipientKind` → "dispatcher") and still refuse them
 * when they have texted STOP. Before slice 4 such a message could only queue and then be blocked,
 * which is why `send_followup` refused the audience outright.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { Db } from "@/db/exec";
import { freshDb } from "@/test/pglite";
import {
  type AgentScenario,
  type ProviderRoute,
  seedAgentScenario,
  seedProviderRoute,
} from "@/test/agent-state";
import type { PolicyContext } from "../../policy";
import { toolCall } from "../../providers/fake";
import type { ProviderResponseBody } from "../../providers/provider";
import type { TierFacts } from "../context";
import { toolCalls } from "../store";
import { AGENT_AWAIT_TASK_CATEGORY, awaitTimerKey } from "../timers";
import type { Trigger } from "../triggers";
import {
  CAPABILITY_LINK_PURPOSE,
  CAPABILITY_REPLY_SECONDS,
  CAPABILITY_REQUEST_PURPOSE,
  CAPABILITY_TASK_CATEGORY,
  LINK_CREATED,
  LINK_INTENT_RECORDED,
} from "./capability";
import type { DispatcherLinkSigner } from "./effects";
import { PREDICATE_CAPABILITY_REPORTED } from "./predicate";
import { type LiveHarness, liveHarness } from "./live-harness";

let pg: PGlite;
let db: Db;
let now: Date;
let sc: AgentScenario;
let route: ProviderRoute;
const open: PGlite[] = [];

/** A route that starts an hour from now: inside §11.2's ninety-minute lead. */
const ROUTE_START = new Date("2026-10-15T13:00:00.000Z");

beforeEach(async () => {
  ({ pg, db } = await freshDb());
  open.push(pg);
  now = new Date("2026-10-15T12:00:00.000Z");
}, 60_000);

afterEach(async () => {
  await Promise.all(open.splice(0).map((h) => h.close().catch(() => {})));
});

/** A test-only signer. P1 configures none, which is the `INTENT_RECORDED` path below. */
const signer: DispatcherLinkSigner = {
  sign: async (a) => ({ tokenHash: `hash-of-${a.linkId}` }),
};

const trigger = (): Trigger => ({ type: "operational.event", id: "EV-CAPABILITY", siteId: sc.siteId });

const facts = (): TierFacts => ({
  t1: `site=${sc.siteId} family=${sc.familyGroupId}`,
  t2: `service_date=${sc.serviceDate}`,
  t3: [],
  t4: "channel=SMS locale=en-US",
});

/** Vehicles, providers and routes are `scope.shared`: this site's fleet, not a family's. */
const policy = (): PolicyContext => ({
  scope: { ...sc.scope, shared: new Set([route.vehicleId, route.providerId, route.manifestId]) },
  sendableSubjects: new Set([route.providerId]),
  sourceMessageId: null,
});

const harness = (script: readonly ProviderResponseBody[], deps: { linkSigner?: DispatcherLinkSigner } = {}): LiveHarness =>
  liveHarness({ db, script, facts: facts(), policy: policy(), now: () => now, ...deps });

const requestCall = (over: Record<string, unknown> = {}) =>
  toolCall("request_provider_capability", {
    vehicle_token: route.vehicleId,
    provider_token: route.providerId,
    route_token: route.manifestId,
    required: ["WHEELCHAIR_SECUREMENT", "LIFT_OR_RAMP"],
    ...over,
  });

const outbound = async () =>
  (await db.query<{
    id: string; purpose: string; recipient_rule: string; recipient_token: string; channel: string;
    template_id: string; vars: Record<string, unknown>; child_token: string | null; state: string;
    idempotency_key: string; not_after: Date; block_reason: string | null;
  }>(
    `SELECT id, purpose, recipient_rule, recipient_token, channel, template_id, vars, child_token, state,
       idempotency_key, not_after, block_reason
     FROM ops.outbound_message ORDER BY created_at`, [])).rows;
const capability = async () =>
  (await db.query<{ state: string; version: number }>(
    "SELECT state, version FROM ops.vehicle_capability_day WHERE id = $1", [route.capabilityId])).rows[0];
const links = async () =>
  (await db.query<{ id: string; provider_id: string; vehicle_id: string; purpose: string; token_hash: string; expires_at: Date; used_at: Date | null }>(
    "SELECT id, provider_id, vehicle_id, purpose, token_hash, expires_at, used_at FROM ops.dispatcher_link ORDER BY created_at", [])).rows;
const tasks = async () =>
  (await db.query<{ category: string; severity: string; completion_predicate: string }>(
    "SELECT category, severity, completion_predicate FROM ops.task ORDER BY created_at", [])).rows;

const seedRoute = async (over: Parameters<typeof seedProviderRoute>[1] | null = null) => {
  route = await seedProviderRoute(db, over ?? {
    siteId: sc.siteId,
    serviceDate: sc.serviceDate,
    windowStart: ROUTE_START,
    legIds: [sc.legs[sc.children[0]].AM],
  });
};

describe("§11.2 the capability question: at T−90, to the dispatcher, state REQUESTED", () => {
  it("moves UNKNOWN → REQUESTED, writes the signed link and queues the dispatcher's notice", async () => {
    sc = await seedAgentScenario(db);
    await seedRoute();
    const h = harness([requestCall()], { linkSigner: signer });
    const r = await h.start(trigger());

    // §11.2's failure column is "no reply → escalate", so the run waits rather than finishing.
    expect([r.state, r.steps]).toEqual(["WAITING_TOOL", 1]);
    expect(r.awaiting).toMatchObject({
      jobKey: awaitTimerKey(r.runId, 0),
      dueAt: new Date(now.getTime() + CAPABILITY_REPLY_SECONDS * 1000),
    });
    expect(await capability()).toEqual({ state: "REQUESTED", version: 2 });

    // The link: single use, hashed, expiring at route start (sooner than four hours).
    const [link] = await links();
    expect(link).toMatchObject({
      provider_id: route.providerId,
      vehicle_id: route.vehicleId,
      purpose: CAPABILITY_LINK_PURPOSE,
      used_at: null,
    });
    expect(link.token_hash).toBe(`hash-of-${link.id}`);
    expect(new Date(link.expires_at).toISOString()).toBe(ROUTE_START.toISOString());

    // The notice: fixed copy, no vars, no child reference — a capability question is about a van.
    const [msg] = await outbound();
    expect(msg).toMatchObject({
      purpose: CAPABILITY_REQUEST_PURPOSE,
      recipient_rule: "provider_dispatcher",
      recipient_token: route.dispatcherToken,
      channel: "SMS_1TO1",
      template_id: "generic.notice",
      child_token: null,
      state: "QUEUED",
      idempotency_key: `agent:${r.runId}:0`,
    });
    expect(msg.vars).toEqual({});

    // The dispatcher egress path: the outbox recognizes an external person and sends.
    expect(await h.drainOutbox()).toEqual(["SENT"]);
    expect(h.provider.sent.map((m) => m.recipientToken)).toEqual([route.dispatcherToken]);

    expect(await tasks()).toEqual([
      expect.objectContaining({
        category: AGENT_AWAIT_TASK_CATEGORY,
        severity: "GREEN",
        completion_predicate: PREDICATE_CAPABILITY_REPORTED,
      }),
    ]);
    expect((await toolCalls(db, r.runId))[0].result).toMatchObject({
      capability_state: "REQUESTED",
      link_state: LINK_CREATED,
      required: ["WHEELCHAIR_SECUREMENT", "LIFT_OR_RAMP"],
    });
  });

  it("with no signer configured the link is an intent, and the dispatcher is still asked", async () => {
    sc = await seedAgentScenario(db);
    await seedRoute();
    const h = harness([requestCall()]);
    const r = await h.start(trigger());

    expect(r.state).toBe("WAITING_TOOL");
    expect(await links()).toEqual([]);
    expect((await toolCalls(db, r.runId))[0].result).toMatchObject({ link_state: LINK_INTENT_RECORDED });
    expect(await capability()).toEqual({ state: "REQUESTED", version: 2 });
    expect(await outbound()).toHaveLength(1);
  });

  it("before T−90 nothing is asked, and nothing is written", async () => {
    sc = await seedAgentScenario(db);
    await seedRoute({
      siteId: sc.siteId, serviceDate: sc.serviceDate,
      windowStart: new Date("2026-10-15T18:00:00.000Z"),
      legIds: [sc.legs[sc.children[0]].AM],
    });
    const h = harness([requestCall()], { linkSigner: signer });
    const r = await h.start(trigger());

    expect(r.state).toBe("FAILED");
    expect((await toolCalls(db, r.runId))[0].result).toMatchObject({
      error_code: "NOT_YET_DUE", lead_minutes: 90, minutes_until_route: 360,
    });
    expect(await capability()).toEqual({ state: "UNKNOWN", version: 1 });
    expect(await outbound()).toEqual([]);
    expect(await links()).toEqual([]);
  });

  it("a substitution is asked about at once, whatever the clock says", async () => {
    sc = await seedAgentScenario(db);
    // A vehicle swapped in: its capability row went * → CHANGED → UNKNOWN, so it is above version 1.
    await seedRoute({
      siteId: sc.siteId, serviceDate: sc.serviceDate,
      windowStart: new Date("2026-10-15T18:00:00.000Z"),
      legIds: [sc.legs[sc.children[0]].AM],
      capabilityVersion: 3,
    });
    const h = harness([requestCall()], { linkSigner: signer });
    const r = await h.start(trigger());

    expect(r.state).toBe("WAITING_TOOL");
    expect(await capability()).toEqual({ state: "REQUESTED", version: 4 });
    expect((await toolCalls(db, r.runId))[0].result).toMatchObject({ substitution: true });
    // Six hours out, so the four-hour cap is what the link expires on, not route start.
    expect(new Date((await links())[0].expires_at).toISOString()).toBe("2026-10-15T16:00:00.000Z");
  });

  it("a capability that is not UNKNOWN is left alone, and one already REQUESTED is a no-op", async () => {
    sc = await seedAgentScenario(db);
    await seedRoute({
      siteId: sc.siteId, serviceDate: sc.serviceDate, windowStart: ROUTE_START,
      legIds: [sc.legs[sc.children[0]].AM], capabilityState: "REPORTED",
    });
    const reported = harness([requestCall()], { linkSigner: signer });
    const r = await reported.start(trigger());
    expect((await toolCalls(db, r.runId))[0].result).toMatchObject({
      error_code: "CAPABILITY_NOT_UNKNOWN", capability_state: "REPORTED",
    });
    expect(await outbound()).toEqual([]);

    await db.query("UPDATE ops.vehicle_capability_day SET state = 'REQUESTED' WHERE id = $1", [route.capabilityId]);
    const again = harness([requestCall()], { linkSigner: signer });
    const r2 = await again.start({ ...trigger(), id: "EV-AGAIN" });
    expect([r2.state]).toEqual(["WAITING_TOOL"]);
    expect((await toolCalls(db, r2.runId))[0].result).toMatchObject({
      capability_state: "REQUESTED", idempotent: true,
    });
    expect(await outbound()).toEqual([]);
  });

  it("a provider with nobody to ask is refused by name, and a person is asked instead", async () => {
    sc = await seedAgentScenario(db);
    await seedRoute({
      siteId: sc.siteId, serviceDate: sc.serviceDate, windowStart: ROUTE_START,
      legIds: [sc.legs[sc.children[0]].AM], withDispatcher: false,
    });
    const h = harness([requestCall()], { linkSigner: signer });
    const r = await h.start(trigger());

    expect(r.state).toBe("FAILED");
    expect((await toolCalls(db, r.runId))[0].result).toMatchObject({
      error_code: "NO_DISPATCHER_CONTACT", task_raised: true,
    });
    // The row stays UNKNOWN: no question was put, so none is recorded.
    expect(await capability()).toEqual({ state: "UNKNOWN", version: 1 });
    expect(await outbound()).toEqual([]);
    expect((await tasks()).map((t) => [t.category, t.severity])).toEqual([[CAPABILITY_TASK_CATEGORY, "AMBER"]]);
  });

  it("a route that is not this vehicle's is refused, and another site's ids are NOT_FOUND", async () => {
    sc = await seedAgentScenario(db);
    await seedRoute();
    await db.query("UPDATE ops.manifest SET vehicle_id = NULL, provider_id = NULL WHERE id = $1", [route.manifestId]);
    // With the manifest claiming neither, the three arguments still agree about the site.
    const loose = harness([requestCall()], { linkSigner: signer });
    expect((await loose.start(trigger())).state).toBe("WAITING_TOOL");

    sc = await seedAgentScenario(db, { number: "+15615550103" });
    const second = await seedProviderRoute(db, {
      siteId: sc.siteId, serviceDate: sc.serviceDate, windowStart: ROUTE_START,
    });
    // A vehicle of the other provider's route: the manifest names a different vehicle.
    route = { ...second, vehicleId: route.vehicleId };
    const mismatched = harness([requestCall()], { linkSigner: signer });
    const r = await mismatched.start({ ...trigger(), id: "EV-MISMATCH" });
    expect((await toolCalls(db, r.runId))[0].result).toMatchObject({ error_code: "ROUTE_NOT_THIS_VEHICLE" });
  });

  it("a dispatcher who has texted STOP is blocked at egress, with zero sends", async () => {
    sc = await seedAgentScenario(db);
    await seedRoute();
    await db.query(
      `INSERT INTO identity.consent_event (id, site_id, contact_token, kind, channel, at, source_mode)
       VALUES ($1,$2,$3,'STOP','SMS_1TO1',$4,'SIMULATED')`,
      ["0199e5f0-0000-7000-8000-00000000c001", sc.siteId, route.dispatcherToken, now.toISOString()],
    );
    const h = harness([requestCall()], { linkSigner: signer });
    await h.start(trigger());

    expect(await h.drainOutbox()).toEqual(["BLOCKED_EGRESS"]);
    expect(h.provider.sent).toEqual([]);
  });
});
