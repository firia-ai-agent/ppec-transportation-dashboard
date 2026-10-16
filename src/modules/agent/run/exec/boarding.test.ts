/**
 * B-08 slice 4, §11.2 `report_boarding` — "guardian reply or stationary tap → BOARDED_REPORTED
 * only", and the AT-10-shaped half of it: nothing the agent can do reaches BOARDED_VERIFIED.
 *
 * Both sources are evidence that is *checked*: a guardian's reply only counts when this run
 * resolved the sender to one authorized child (the cancel bar), and a driver's tap only counts
 * while the vehicle's own newest bound position says it is standing still.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { uuidv7 } from "uuidv7";
import type { Db } from "@/db/exec";
import { GPS_STALE_SECONDS } from "@/domain/location/freshness";
import { TEST_NOW } from "@/test/clock";
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
import type { Trigger } from "../triggers";
import { BOARDING_STATE } from "./boarding";
import { type LiveHarness, liveHarness } from "./live-harness";

let pg: PGlite;
let db: Db;
let now: Date;
let sc: AgentScenario;
let route: ProviderRoute;
const open: PGlite[] = [];

beforeEach(async () => {
  ({ pg, db } = await freshDb());
  open.push(pg);
  now = new Date(TEST_NOW);
}, 60_000);

afterEach(async () => {
  await Promise.all(open.splice(0).map((h) => h.close().catch(() => {})));
});

const trigger = (): Trigger => ({ type: "msg.inbound", id: sc.messageId, siteId: sc.siteId });

const facts = (): TierFacts => ({
  t1: `site=${sc.siteId} family=${sc.familyGroupId}`,
  t2: `service_date=${sc.serviceDate}`,
  t3: ["hes on the van"],
  t4: "channel=SMS locale=en-US",
});

const policy = (): PolicyContext => ({
  scope: { ...sc.scope, shared: new Set([route.vehicleId, route.providerId, route.manifestId]) },
  sendableSubjects: new Set([sc.threadId, ...sc.children]),
  sourceMessageId: sc.messageId,
});

const harness = (script: readonly ProviderResponseBody[]): LiveHarness =>
  liveHarness({ db, script, facts: facts(), policy: policy(), now: () => now });

const legId = () => sc.legs[sc.children[0]].AM;

const boardingCall = (over: Record<string, unknown> = {}) =>
  toolCall("report_boarding", {
    leg_id: legId(),
    source: "GUARDIAN_REPLY",
    state: BOARDING_STATE,
    expected_version: 2,
    ...over,
  });

const leg = async () =>
  (await db.query<{ state: string; version: number }>(
    "SELECT state, version FROM ops.trip_leg WHERE id = $1", [legId()])).rows[0];

/** The leg as it is when a van has arrived at the stop: ARRIVED_PICKUP, at version 2. */
const atPickup = async () => {
  route = await seedProviderRoute(db, {
    siteId: sc.siteId,
    serviceDate: sc.serviceDate,
    windowStart: new Date(TEST_NOW),
    legIds: [legId()],
  });
  await db.query(
    "UPDATE ops.trip_leg SET state = 'ARRIVED_PICKUP', version = 2 WHERE id = $1",
    [legId()],
  );
};

/** One bound position for the route's vehicle. */
const seedPoint = async (a: { speedMps: number | null; ageSeconds: number; bound?: boolean }) => {
  await db.query(
    `INSERT INTO ops.telemetry_point (site_id, device_id, vehicle_id, recorded_at, lat, lng, speed_mps, bound, source_mode)
     VALUES ($1,$2,$3,$4,26.64,-80.14,$5,$6,'SIMULATED')`,
    [sc.siteId, uuidv7(), route.vehicleId, new Date(now.getTime() - a.ageSeconds * 1000).toISOString(),
      a.speedMps, a.bound ?? true],
  );
};

describe("§11.2 report_boarding: reported, never verified", () => {
  it("a guardian's reply, on a run that resolved them to one child, reports the boarding", async () => {
    sc = await seedAgentScenario(db, { body: "hes on the van" });
    await atPickup();
    const h = harness([toolCall("resolve_sender", { message_id: sc.messageId }), boardingCall()]);
    const r = await h.start(trigger());

    expect(await leg()).toEqual({ state: BOARDING_STATE, version: 3 });
    const [, call] = await toolCalls(db, r.runId);
    expect([call.tool, call.status]).toEqual(["report_boarding", "EXECUTED"]);
    expect(call.result).toMatchObject({
      leg_state: BOARDING_STATE,
      source: "GUARDIAN_REPLY",
      reported_by_actor: "G",
    });
    // Nothing above the reported state, and nothing sent.
    expect(JSON.stringify(call.result)).not.toContain("BOARDED_VERIFIED");
    expect((await db.query("SELECT 1 FROM ops.outbound_message", [])).rows).toEqual([]);
  });

  it("a shared number with two siblings on it reports nothing", async () => {
    sc = await seedAgentScenario(db, { children: 2, body: "hes on the van" });
    await atPickup();
    const h = harness([toolCall("resolve_sender", { message_id: sc.messageId }), boardingCall()]);
    const r = await h.start(trigger());

    expect(r.state).toBe("FAILED");
    expect((await toolCalls(db, r.runId))[1].result).toMatchObject({
      error_code: "AMBIGUOUS_SENDER", candidate_count: 2,
    });
    expect(await leg()).toEqual({ state: "ARRIVED_PICKUP", version: 2 });
  });

  it("a run that never resolved a sender cannot report a guardian's reply", async () => {
    sc = await seedAgentScenario(db);
    await atPickup();
    const h = harness([boardingCall()]);
    const r = await h.start({ type: "operational.event", id: "EV-NO-SENDER", siteId: sc.siteId });

    expect((await toolCalls(db, r.runId))[0].result).toMatchObject({
      error_code: "UNVERIFIED_GUARDIAN", reason_code: "SENDER_NOT_RESOLVED",
    });
    expect(await leg()).toEqual({ state: "ARRIVED_PICKUP", version: 2 });
  });

  it("a stationary driver's tap reports it as the provider", async () => {
    sc = await seedAgentScenario(db);
    await atPickup();
    await seedPoint({ speedMps: 0, ageSeconds: 20 });
    const h = harness([boardingCall({ source: "STATIONARY_TAP" })]);
    const r = await h.start({ type: "operational.event", id: "EV-TAP", siteId: sc.siteId });

    expect(await leg()).toEqual({ state: BOARDING_STATE, version: 3 });
    expect((await toolCalls(db, r.runId))[0].result).toMatchObject({
      source: "STATIONARY_TAP",
      reported_by_actor: "P",
      evidence: { vehicle_token: route.vehicleId, speed_mps: 0, age_seconds: 20 },
    });
  });

  it("a tap from a moving vehicle is refused: stationary-only (PRD §4.4)", async () => {
    sc = await seedAgentScenario(db);
    await atPickup();
    await seedPoint({ speedMps: 9, ageSeconds: 10 });
    const h = harness([boardingCall({ source: "STATIONARY_TAP" })]);
    const r = await h.start({ type: "operational.event", id: "EV-MOVING", siteId: sc.siteId });

    expect((await toolCalls(db, r.runId))[0].result).toMatchObject({
      error_code: "VEHICLE_NOT_STATIONARY", speed_mps: 9, max_speed_mps: 2,
    });
    expect(await leg()).toEqual({ state: "ARRIVED_PICKUP", version: 2 });
  });

  it("a tap with no fresh position behind it is refused", async () => {
    sc = await seedAgentScenario(db);
    await atPickup();
    await seedPoint({ speedMps: 0, ageSeconds: GPS_STALE_SECONDS + 60 });
    const h = harness([boardingCall({ source: "STATIONARY_TAP" })]);
    const r = await h.start({ type: "operational.event", id: "EV-STALE", siteId: sc.siteId });

    expect((await toolCalls(db, r.runId))[0].result).toMatchObject({
      error_code: "NO_LOCATION_EVIDENCE",
      stale_after_seconds: GPS_STALE_SECONDS,
      age_seconds: GPS_STALE_SECONDS + 60,
    });
    expect(await leg()).toEqual({ state: "ARRIVED_PICKUP", version: 2 });

    // An unbound position is not evidence either (LOC-01: it is shown nowhere and moves nothing).
    await seedPoint({ speedMps: 0, ageSeconds: 10, bound: false });
    const unbound = harness([boardingCall({ source: "STATIONARY_TAP" })]);
    const r2 = await unbound.start({ type: "operational.event", id: "EV-UNBOUND", siteId: sc.siteId });
    expect((await toolCalls(db, r2.runId))[0].result).toMatchObject({ error_code: "NO_LOCATION_EVIDENCE" });
  });

  it("a leg that has not arrived yet, and a version that moved, are both refused", async () => {
    sc = await seedAgentScenario(db);
    await atPickup();
    await db.query("UPDATE ops.trip_leg SET state = 'SCHEDULED' WHERE id = $1", [legId()]);
    const early = harness([boardingCall({ source: "STATIONARY_TAP" })]);
    const r = await early.start({ type: "operational.event", id: "EV-EARLY", siteId: sc.siteId });
    expect((await toolCalls(db, r.runId))[0].result).toMatchObject({
      error_code: "LEG_NOT_AT_PICKUP", leg_state: "SCHEDULED",
    });

    // Back at the stop, but staff edited the leg after the model read its version.
    await db.query("UPDATE ops.trip_leg SET state = 'ARRIVED_PICKUP', version = 7 WHERE id = $1", [legId()]);
    await seedPoint({ speedMps: 0, ageSeconds: 10 });
    const stale = harness([boardingCall({ source: "STATIONARY_TAP" })]);
    const r2 = await stale.start({ type: "operational.event", id: "EV-STALE-VERSION", siteId: sc.siteId });
    expect((await toolCalls(db, r2.runId))[0].result).toMatchObject({
      error_code: "VERSION_CONFLICT", http_status: 412, expected_version: 2,
    });
    expect(await leg()).toEqual({ state: "ARRIVED_PICKUP", version: 7 });
  });

  it("a boarding already reported is idempotent, whatever the version argument says", async () => {
    sc = await seedAgentScenario(db);
    await atPickup();
    await db.query("UPDATE ops.trip_leg SET state = $2, version = 5 WHERE id = $1", [legId(), BOARDING_STATE]);
    const h = harness([boardingCall({ source: "STATIONARY_TAP" })]);
    const r = await h.start({ type: "operational.event", id: "EV-AGAIN", siteId: sc.siteId });

    expect((await toolCalls(db, r.runId))[0].result).toMatchObject({
      idempotent: true, leg_state: BOARDING_STATE, leg_version: 5,
    });
    expect(await leg()).toEqual({ state: BOARDING_STATE, version: 5 });
  });
});
