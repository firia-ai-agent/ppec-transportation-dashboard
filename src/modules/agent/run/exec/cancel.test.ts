/**
 * B-08 slice 3, §11.2 `cancel_attendance_or_leg` on real state — **AT-07** (leg vs full-day) and
 * **AT-08** (version check / canceled_stale).
 *
 * AT-07 is the whole of the first two suites: the same tool, the same child, the same day, and two
 * genuinely different outcomes — one leg canceled as *transport* with the child still expected by
 * car, or the day canceled as *attendance* with both legs following it. AT-08 is the third: a
 * version that moved under the agent writes nothing, says 412, and leaves a message already queued
 * about that ride to go CANCELED_STALE at send time instead of out.
 *
 * Every cancel here goes through the loop, because the guards are only true end to end: the
 * gateway accepts the call, the policy engine allows it, the row is persisted before it executes,
 * and the executor takes its authority from the committed `resolve_sender` result.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { uuidv7 } from "uuidv7";
import type { PGlite } from "@electric-sql/pglite";
import type { Db } from "@/db/exec";
import { TEST_NOW } from "@/test/clock";
import { freshDb } from "@/test/pglite";
import { type AgentScenario, seedAgentScenario } from "@/test/agent-state";
import { F2_NUMBER } from "@/test/messaging";
import { drain, enqueue } from "@/modules/outbox/outbox";
import type { PolicyContext } from "../../policy";
import { toolCall } from "../../providers/fake";
import type { ProviderResponseBody } from "../../providers/provider";
import type { TierFacts } from "../context";
import type { ToolExecution } from "../executors";
import { type CommittedCall, toolCalls } from "../store";
import type { Trigger } from "../triggers";
import { cancelAttendanceOrLegExecutor } from "./cancel";
import { effectId } from "./effects";
import { type LiveHarness, liveHarness } from "./live-harness";

let pg: PGlite;
let db: Db;
let now: Date;
let sc: AgentScenario;
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

/** T1/T2/T4 are tokens; T3 is the body as received, wrapped by the assembler. */
const facts = (): TierFacts => ({
  t1: `site=${sc.siteId} family=${sc.familyGroupId} scopes=RECEIVE_TRANSPORT_UPDATES`,
  t2: `service_date=${sc.serviceDate}`,
  t3: ["wont need the AM van, dropping at 9:30"],
  t4: "channel=SMS locale=en-US",
});

const policy = (over: Partial<PolicyContext> = {}): PolicyContext => ({
  scope: sc.scope,
  sendableSubjects: new Set([sc.threadId, ...sc.children]),
  sourceMessageId: sc.messageId,
  ...over,
});

/**
 * The run ends with a staff note, which is the §11.1 shape (read, write, note) and is also what
 * ends the run: `summarize_thread_for_staff` has no live executor in slice 3 (the staff-note row is
 * B-12), so this suite gives it one that records nothing and says the run is done. Every other tool
 * in the script is the real one.
 */
const NOTE_TURN = () => toolCall("summarize_thread_for_staff", { thread_id: sc.threadId, summary: "Guardian canceled a ride" });
const NOTE_EXECUTOR = { summarize_thread_for_staff: async () => ({ data: { note: "stored" }, done: true }) };

const harness = (script: readonly ProviderResponseBody[]): LiveHarness =>
  liveHarness({
    db, script: [...script, NOTE_TURN()], facts: facts(), policy: policy(),
    overrides: NOTE_EXECUTOR, now: () => now,
  });

/** The §11.1 shape of a write: resolve the sender, read the leg with its version, then cancel. */
const resolveThenRead = (legId: string): ProviderResponseBody[] => [
  toolCall("resolve_sender", { message_id: sc.messageId }),
  toolCall("get_leg_state", { leg_id: legId }),
];

const cancelCall = (over: Record<string, unknown> = {}) =>
  toolCall("cancel_attendance_or_leg", {
    child_token: sc.children[0],
    date: sc.serviceDate,
    day_part: "AM",
    reason_code: "FAMILY_DROPOFF",
    expected_self_arrival: "09:30",
    expected_version: 1,
    ...over,
  });

/**
 * One cancel, called straight on the executor with a chosen idempotency key and a committed
 * `resolve_sender` result standing in for the step before it — which is how the same call can be
 * driven twice, the way the loop drives a call it found PENDING after a crash.
 */
const directCancel = async (key: string, over: Record<string, unknown> = {}): Promise<ToolExecution> => {
  const h = harness([]);
  const resolved: CommittedCall = {
    seq: 0,
    tool: "resolve_sender",
    status: "EXECUTED",
    argsHash: "",
    promptFacts: { sender_known: true, sender_child_count: 1, sender_child_token: sc.children[0] },
  };
  return cancelAttendanceOrLegExecutor(h.execDeps)({
    runId: "0199e5f0-0000-7000-8000-00000000c001",
    callId: "0199e5f0-0000-7000-8000-00000000c002",
    siteId: sc.siteId,
    seq: 2,
    tool: "cancel_attendance_or_leg",
    args: {
      child_token: sc.children[0], date: sc.serviceDate, day_part: "AM",
      reason_code: "FAMILY_DROPOFF", expected_self_arrival: "09:30", expected_version: 1, ...over,
    },
    idempotencyKey: key,
    trigger: trigger(),
    now,
    committed: [resolved],
  });
};

const leg = async (id: string) =>
  (await db.query<{ state: string; version: number; plan_version: number }>(
    "SELECT state, version, plan_version FROM ops.trip_leg WHERE id = $1", [id])).rows[0];
const attendance = async (childToken: string) =>
  (await db.query<{ state: string; version: number }>(
    "SELECT state, version FROM ops.attendance_day WHERE child_token = $1", [childToken])).rows[0];
const exceptions = async () =>
  (await db.query<{ child_token: string; scope: string; reason: string; expected_self_arrival: string | null }>(
    `SELECT child_token, scope, reason, expected_self_arrival FROM ops.attendance_exception
     ORDER BY created_at`, [])).rows;

describe("AT-07 one leg: transport is canceled, attendance is not", () => {
  it("cancels the AM leg, moves the day to AM_SELF_DROP, and records the exception", async () => {
    sc = await seedAgentScenario(db);
    const child = sc.children[0];
    const h = harness([...resolveThenRead(sc.legs[child].AM), cancelCall()]);
    const r = await h.start(trigger());

    expect([r.state, r.steps]).toEqual(["SUCCEEDED", 4]);
    expect(await leg(sc.legs[child].AM)).toEqual({ state: "CANCELED_TRANSPORT", version: 3, plan_version: 2 });
    // The PM leg is untouched: this is a leg cancel, not a day (AT-07).
    expect(await leg(sc.legs[child].PM)).toEqual({ state: "SCHEDULED", version: 1, plan_version: 1 });
    // The child is still expected — by car, at the time the family named (demo step 2).
    expect(await attendance(child)).toEqual({ state: "AM_SELF_DROP", version: 2 });
    expect(await exceptions()).toEqual([
      { child_token: child, scope: "AM", reason: "FAMILY_DROPOFF", expected_self_arrival: "09:30" },
    ]);

    const [, , call] = await toolCalls(db, r.runId);
    expect([call.tool, call.status]).toEqual(["cancel_attendance_or_leg", "EXECUTED"]);
    expect(call.result).toMatchObject({
      day_part: "AM",
      leg_state: "CANCELED_TRANSPORT",
      prompt_facts: { leg_state: "CANCELED_TRANSPORT", attendance_state: "AM_SELF_DROP" },
    });
  });

  it("a PM cancel leaves the attendance day alone (there is no PM self-drop state)", async () => {
    sc = await seedAgentScenario(db);
    const child = sc.children[0];
    const h = harness([
      ...resolveThenRead(sc.legs[child].PM),
      cancelCall({ day_part: "PM", expected_self_arrival: "15:30", reason_code: "FAMILY_REQUEST" }),
    ]);
    const r = await h.start(trigger());

    expect(r.state).toBe("SUCCEEDED");
    expect((await leg(sc.legs[child].PM)).state).toBe("CANCELED_TRANSPORT");
    expect((await leg(sc.legs[child].AM)).state).toBe("SCHEDULED");
    expect(await attendance(child)).toEqual({ state: "SCHEDULED", version: 1 });
    // The pickup time the family named is on the record even though no state carries it.
    expect((await exceptions())[0]).toMatchObject({ scope: "PM", expected_self_arrival: "15:30" });
  });

  it("without a named drop-off the ride is canceled and the day is left for staff", async () => {
    sc = await seedAgentScenario(db);
    const child = sc.children[0];
    const h = harness([
      ...resolveThenRead(sc.legs[child].AM),
      cancelCall({ expected_self_arrival: null, reason_code: "FAMILY_REQUEST" }),
    ]);
    expect((await h.start(trigger())).state).toBe("SUCCEEDED");
    expect((await leg(sc.legs[child].AM)).state).toBe("CANCELED_TRANSPORT");
    expect(await attendance(child)).toEqual({ state: "SCHEDULED", version: 1 });
  });

  it("a leg past boarding is refused by the machine, and nothing else in the call happens", async () => {
    sc = await seedAgentScenario(db);
    const child = sc.children[0];
    await db.query(
      "UPDATE ops.trip_leg SET state = 'BOARDED_REPORTED', version = version + 1 WHERE id = $1",
      [sc.legs[child].AM],
    );
    const h = harness([...resolveThenRead(sc.legs[child].AM), cancelCall({ expected_version: 2 })]);
    const r = await h.start(trigger());

    expect(r.state).toBe("FAILED");
    expect((await leg(sc.legs[child].AM)).state).toBe("BOARDED_REPORTED");
    expect(await attendance(child)).toEqual({ state: "SCHEDULED", version: 1 });
    expect(await exceptions()).toEqual([]);
    const [, , call] = await toolCalls(db, r.runId);
    expect([call.status, call.result]).toEqual([
      "FAILED",
      {
        error_code: "ILLEGAL_TRANSITION",
        reason: "trip_leg: BOARDED_REPORTED -> CANCELED_TRANSPORT not allowed for A",
        prompt_facts: { error_code: "ILLEGAL_TRANSITION" },
      },
    ]);
  });
});

describe("AT-07 full day: the day is canceled and both legs follow it", () => {
  it("moves the day to ABSENT_FULL_DAY, cascades both legs, and writes one exception", async () => {
    sc = await seedAgentScenario(db, { body: "staying home sick" });
    const child = sc.children[0];
    const h = harness([
      ...resolveThenRead(sc.legs[child].AM),
      cancelCall({ day_part: "FULL_DAY", reason_code: "ILLNESS", expected_self_arrival: null }),
    ]);
    const r = await h.start(trigger());

    expect([r.state, r.steps]).toEqual(["SUCCEEDED", 4]);
    expect(await attendance(child)).toEqual({ state: "ABSENT_FULL_DAY", version: 2 });
    // Both legs, and as CANCELED_ATTENDANCE (the system following the day) rather than transport.
    expect(await leg(sc.legs[child].AM)).toEqual({ state: "CANCELED_ATTENDANCE", version: 3, plan_version: 2 });
    expect(await leg(sc.legs[child].PM)).toEqual({ state: "CANCELED_ATTENDANCE", version: 3, plan_version: 2 });
    expect(await exceptions()).toEqual([
      { child_token: child, scope: "FULL_DAY", reason: "ILLNESS", expected_self_arrival: null },
    ]);
  });

  it("the full-day version check is the attendance day's, not a leg's", async () => {
    sc = await seedAgentScenario(db, { body: "staying home sick" });
    const child = sc.children[0];
    // A staff edit moved the day; the leg versions are untouched, so a leg-versioned call would pass.
    await db.query(
      "UPDATE ops.attendance_day SET state = 'EXPECTED_LATE', version = version + 1 WHERE child_token = $1",
      [child],
    );
    const h = harness([
      ...resolveThenRead(sc.legs[child].AM),
      cancelCall({ day_part: "FULL_DAY", reason_code: "ILLNESS", expected_self_arrival: null, expected_version: 1 }),
    ]);
    const r = await h.start(trigger());

    expect(r.state).toBe("FAILED");
    expect(await attendance(child)).toEqual({ state: "EXPECTED_LATE", version: 2 });
    expect((await leg(sc.legs[child].AM)).state).toBe("SCHEDULED");
  });

  it("a full-day absence that also names a drop-off time is refused as contradictory", async () => {
    sc = await seedAgentScenario(db);
    const child = sc.children[0];
    const h = harness([
      ...resolveThenRead(sc.legs[child].AM),
      cancelCall({ day_part: "FULL_DAY", expected_self_arrival: "09:30" }),
    ]);
    const r = await h.start(trigger());
    expect(r.state).toBe("FAILED");
    const [, , call] = await toolCalls(db, r.runId);
    expect(call.result).toEqual({
      error_code: "CONTRADICTORY_ARGUMENTS",
      reason_code: "SELF_ARRIVAL_ON_FULL_DAY",
      prompt_facts: { error_code: "CONTRADICTORY_ARGUMENTS" },
    });
    expect(await attendance(child)).toEqual({ state: "SCHEDULED", version: 1 });
  });

  it("a leg already boarded is left where it is while the rest of the day cascades", async () => {
    sc = await seedAgentScenario(db);
    const child = sc.children[0];
    await db.query(
      "UPDATE ops.trip_leg SET state = 'BOARDED_REPORTED', version = version + 1 WHERE id = $1",
      [sc.legs[child].AM],
    );
    const h = harness([
      ...resolveThenRead(sc.legs[child].PM),
      cancelCall({ day_part: "FULL_DAY", reason_code: "ILLNESS", expected_self_arrival: null }),
    ]);
    const r = await h.start(trigger());

    expect(r.state).toBe("SUCCEEDED");
    expect((await leg(sc.legs[child].AM)).state).toBe("BOARDED_REPORTED");
    expect((await leg(sc.legs[child].PM)).state).toBe("CANCELED_ATTENDANCE");
    const [, , call] = await toolCalls(db, r.runId);
    expect(call.result).toMatchObject({
      canceled_leg_ids: [sc.legs[child].PM],
      skipped_leg_ids: [sc.legs[child].AM],
    });
  });
});

describe("AT-08 the version check, and what canceled_stale means downstream", () => {
  it("a version that moved under the agent writes nothing and answers 412", async () => {
    sc = await seedAgentScenario(db);
    const child = sc.children[0];
    const h = harness([
      // The read sees version 1…
      ...resolveThenRead(sc.legs[child].AM),
      cancelCall({ expected_version: 1 }),
    ]);
    // …and staff move the leg between the read and the write.
    const staffMoved = async () => {
      await db.query(
        "UPDATE ops.trip_leg SET state = 'PROVISIONAL_ASSIGNED', version = version + 1 WHERE id = $1",
        [sc.legs[child].AM],
      );
    };
    await staffMoved();
    const r = await h.start(trigger());

    expect(r.state).toBe("FAILED");
    const [, , call] = await toolCalls(db, r.runId);
    expect([call.status, call.result]).toEqual([
      "FAILED",
      {
        error_code: "VERSION_CONFLICT",
        http_status: 412,
        outcome: "canceled_stale",
        expected_version: 1,
        prompt_facts: { error_code: "VERSION_CONFLICT" },
      },
    ]);
    // Nothing moved, nothing was recorded: the staff edit stands.
    expect(await leg(sc.legs[child].AM)).toEqual({ state: "PROVISIONAL_ASSIGNED", version: 2, plan_version: 1 });
    expect(await attendance(child)).toEqual({ state: "SCHEDULED", version: 1 });
    expect(await exceptions()).toEqual([]);
  });

  it("a message queued about the old plan goes CANCELED_STALE once the leg is canceled", async () => {
    sc = await seedAgentScenario(db);
    const child = sc.children[0];
    // An ETA notice queued while the ride was still on, against plan version 1.
    const queued = await db.tx((tx, afterCommit) =>
      enqueue(tx, afterCommit, { async publish() {} }, {
        siteId: sc.siteId, purpose: "PICKUP_UPDATE", recipientRule: "guardian",
        recipientToken: sc.contactToken, channel: "SMS_1TO1", templateId: "pickup.eta",
        vars: { eta: "08:12" }, childToken: child, tripLegId: sc.legs[child].AM,
        planVersionBasis: 1, notAfter: new Date(now.getTime() + 3_600_000),
        idempotencyKey: uuidv7(), by: "test",
      }),
    );

    const h = harness([...resolveThenRead(sc.legs[child].AM), cancelCall()]);
    expect((await h.start(trigger())).state).toBe("SUCCEEDED");

    // The cancel bumped the leg's plan version, so the send-time check refuses the old message.
    expect(await drain(db, queued.id, h.drainDeps)).toBe("CANCELED_STALE");
    expect(h.provider.sent).toEqual([]);
    const row = (await db.query<{ state: string; block_reason: string }>(
      "SELECT state, block_reason FROM ops.outbound_message WHERE id = $1", [queued.id])).rows[0];
    expect([row.state, row.block_reason]).toEqual(["CANCELED_STALE", "plan_version 2 != basis 1"]);
  });

  it("the same call driven twice cancels once: the version guard and the derived row id", async () => {
    sc = await seedAgentScenario(db);
    const child = sc.children[0];
    const first = await directCancel("agent:r:2", { expected_version: 1 });
    expect(first.status).toBe("executed");

    // Exactly what the loop does for a call it finds PENDING after a crash: the same arguments,
    // the same idempotency key, driven again. The exception row written under that key is the
    // call's receipt, so the answer is the state the first attempt left — not a second attempt,
    // and not a failure.
    const second = await directCancel("agent:r:2", { expected_version: 1 });
    expect(second.status).toBe("executed");
    expect(second.data).toMatchObject({ idempotent: true, leg_state: "CANCELED_TRANSPORT", leg_version: 3 });
    expect(second.promptFacts).toMatchObject({ leg_state: "CANCELED_TRANSPORT", attendance_state: "AM_SELF_DROP" });

    // A *different* call with the same stale version is still a conflict: it has no receipt.
    const other = await directCancel("agent:r:9", { expected_version: 1 });
    expect(other.data).toMatchObject({ error_code: "ILLEGAL_TRANSITION" });

    expect(await leg(sc.legs[child].AM)).toEqual({ state: "CANCELED_TRANSPORT", version: 3, plan_version: 2 });
    expect(await attendance(child)).toEqual({ state: "AM_SELF_DROP", version: 2 });
    const rows = await exceptions();
    expect(rows).toHaveLength(1);
    const [row] = (await db.query<{ id: string }>("SELECT id FROM ops.attendance_exception", [])).rows;
    expect(row.id).toBe(effectId("agent:r:2", "attendance-exception"));
  });
});

describe("AT-06 the guard in front of every cancel: a verified, unambiguous guardian", () => {
  it("two siblings on one number: the cancel is refused and nothing moves", async () => {
    sc = await seedAgentScenario(db, { children: 2, body: "staying home sick" });
    const child = sc.children[0];
    const h = harness([
      toolCall("resolve_sender", { message_id: sc.messageId }),
      cancelCall({ day_part: "FULL_DAY", reason_code: "ILLNESS", expected_self_arrival: null }),
    ]);
    const r = await h.start(trigger());

    expect(r.state).toBe("FAILED");
    const [, call] = await toolCalls(db, r.runId);
    expect([call.status, call.result]).toEqual([
      "FAILED",
      {
        error_code: "AMBIGUOUS_SENDER",
        reason_code: "MORE_THAN_ONE_CANDIDATE",
        candidate_count: 2,
        prompt_facts: { error_code: "AMBIGUOUS_SENDER" },
      },
    ]);
    for (const c of sc.children) {
      expect(await attendance(c)).toEqual({ state: "SCHEDULED", version: 1 });
      expect((await leg(sc.legs[c].AM)).state).toBe("SCHEDULED");
      expect((await leg(sc.legs[c].PM)).state).toBe("SCHEDULED");
    }
    expect(await exceptions()).toEqual([]);
  });

  it("a run that never resolved its sender may not cancel, however good the arguments look", async () => {
    sc = await seedAgentScenario(db);
    const child = sc.children[0];
    const h = harness([toolCall("get_leg_state", { leg_id: sc.legs[child].AM }), cancelCall()]);
    const r = await h.start(trigger());

    expect(r.state).toBe("FAILED");
    const [, call] = await toolCalls(db, r.runId);
    expect(call.result).toMatchObject({ error_code: "UNVERIFIED_GUARDIAN", reason_code: "SENDER_NOT_RESOLVED" });
    expect((await leg(sc.legs[child].AM)).state).toBe("SCHEDULED");
  });

  it("the resolved child is the only child this run may cancel, scope or no scope", async () => {
    const mine = await seedAgentScenario(db);
    const theirs = await seedAgentScenario(db, { number: F2_NUMBER });
    const theirChild = theirs.children[0];
    sc = mine;
    const h = liveHarness({
      db,
      script: [
        toolCall("resolve_sender", { message_id: mine.messageId }),
        toolCall("cancel_attendance_or_leg", {
          child_token: theirChild, date: theirs.serviceDate, day_part: "AM",
          reason_code: "FAMILY_REQUEST", expected_self_arrival: null, expected_version: 1,
        }),
      ],
      facts: facts(),
      // A scope wide enough to permit both families, so the refusal below is the executor's own
      // guard — the resolved sender — and not the policy engine's family-scope check.
      policy: policy({
        scope: {
          ...mine.scope,
          tokens: new Set([...mine.scope.tokens, theirChild, theirs.legs[theirChild].AM, theirs.legs[theirChild].PM]),
        },
      }),
      now: () => now,
    });
    const r = await h.start(trigger());

    expect(r.state).toBe("FAILED");
    const [, call] = await toolCalls(db, r.runId);
    expect(call.result).toMatchObject({
      error_code: "UNVERIFIED_GUARDIAN",
      reason_code: "CHILD_NOT_THE_RESOLVED_ONE",
    });
    expect((await leg(theirs.legs[theirChild].AM)).state).toBe("SCHEDULED");
    expect(await attendance(theirChild)).toEqual({ state: "SCHEDULED", version: 1 });
  });
});
