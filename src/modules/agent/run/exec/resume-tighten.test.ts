/**
 * PR #35 review, F1: **a resumed step does not outrun a decision taken during the outage.**
 *
 * §11.1's resume contract is that a call persisted but never committed is re-driven with its
 * original idempotency key, so an effect that already happened is not repeated. Read on its own
 * that also says the row's ALLOW survives the crash — which would mean a crash buys the model an
 * exemption from the kill switch: pause the agent, or let the family withdraw consent, while a
 * PENDING send sits on disk, and the next driver would send it anyway.
 *
 * So a resume re-decides the step first, **tighten-only** (`loop.tightenOnResume`): the current
 * context may refuse a call that was allowed, and may never allow one that was refused. The three
 * cases the review named are the three suites below, and each is measured where it matters —
 * `provider.sent`, not a mock:
 *
 *   pause between persist and resume   → the resumed send is BLOCKED `send_while_paused`, zero sends
 *   consent withdrawn                   → BLOCKED `non_consented_number`, nothing even queued
 *   version moved                       → the effect-time guard answers 412 / `canceled_stale`
 *
 * The third needs no policy tightening and is here for the contrast: `transition()` is guarded on
 * the version **the model was given**, so a cancel resumed after a staff edit refuses itself at the
 * effect, which is the half of F1 that was already true. The first two are the half that was not.
 *
 * Every case runs twice over: once with nothing changed during the outage (the control, which must
 * send), and once with the thing that changed. A refusal that is also what the harness does when it
 * works proves nothing.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { Db } from "@/db/exec";
import { TEST_NOW } from "@/test/clock";
import { freshDb } from "@/test/pglite";
import { type AgentScenario, seedAgentScenario, seedTherapySession } from "@/test/agent-state";
import { recordConsent } from "@/modules/messaging/consent";
import { testIdentityGateway } from "@/test/identity-gateway";

/** The suites' identity gateway (S1-6); see src/test/identity-gateway.ts. */
const GATEWAY = testIdentityGateway({ pepper: PEPPER });
import { PEPPER } from "@/test/messaging";
import type { PolicyContext } from "../../policy";
import { toolCall } from "../../providers/fake";
import type { ProviderResponseBody } from "../../providers/provider";
import type { TierFacts } from "../context";
import { toolCalls } from "../store";
import { policyTaskId } from "../tasks";
import type { Trigger } from "../triggers";
import { type LiveHarness, liveHarness } from "./live-harness";

/** The injected "this process is gone" (resume.test.ts uses the same seam, for the same reason). */
class SimulatedCrash extends Error {}
const isFatal = (e: unknown) => e instanceof SimulatedCrash;

let pg: PGlite;
let db: Db;
let now: Date;
let sc: AgentScenario;
/** The therapy session the re-decided send is about (S1-7; see `followupCall`). */
let session: Awaited<ReturnType<typeof seedTherapySession>>;
const open: PGlite[] = [];

beforeEach(async () => {
  ({ pg, db } = await freshDb());
  open.push(pg);
  now = new Date(TEST_NOW);
  sc = await seedAgentScenario(db);
  session = await seedTherapySession(db, {
    siteId: sc.siteId, childToken: sc.children[0], startsAt: new Date(now.getTime() + 3 * 3_600_000),
  });
}, 60_000);

afterEach(async () => {
  await Promise.all(open.splice(0).map((h) => h.close().catch(() => {})));
});

const trigger = (): Trigger => ({ type: "msg.inbound", id: sc.messageId, siteId: sc.siteId });

const facts = (): TierFacts => ({
  t1: `site=${sc.siteId} family=${sc.familyGroupId} scopes=RECEIVE_TRANSPORT_UPDATES`,
  t2: `service_date=${sc.serviceDate}`,
  t3: ["wont need the AM van, dropping at 9:30"],
  t4: "channel=SMS locale=en-US",
});

/** The context a session builds for this run. `over` is what changed during the outage. */
const policy = (over: Partial<PolicyContext> = {}): PolicyContext => ({
  scope: { ...sc.scope, tokens: new Set([...sc.scope.tokens, session.sessionId]) },
  sendableSubjects: new Set([sc.threadId, session.sessionId, ...sc.children]),
  sourceMessageId: sc.messageId,
  ...over,
});

const NOTE_TURN = () => toolCall("summarize_thread_for_staff", { thread_id: sc.threadId, summary: "Guardian canceled a ride" });
const NOTE_EXECUTOR = { summarize_thread_for_staff: async () => ({ data: { note: "stored" }, done: true }) };

/**
 * The process that dies: the real registry, except that `tool` throws fatally **before** doing
 * anything. What it leaves behind is the state F1 is about — the row committed PENDING with its
 * ALLOW, and no effect.
 */
const crashingOn = (tool: string, script: readonly ProviderResponseBody[]): LiveHarness =>
  liveHarness({
    gateway: GATEWAY,
    db, script: [...script, NOTE_TURN()], facts: facts(), policy: policy(), now: () => now, isFatal,
    overrides: {
      ...NOTE_EXECUTOR,
      [tool]: async () => {
        throw new SimulatedCrash(`process died after persisting ${tool}`);
      },
    },
  });

/** The process that comes back, with the real executors and the context as it is **now**. */
const resumingWith = (over: Partial<PolicyContext>, script: readonly ProviderResponseBody[]): LiveHarness =>
  liveHarness({
    gateway: GATEWAY,
    db, script: [...script, NOTE_TURN()], facts: facts(), policy: policy(over), now: () => now,
    overrides: NOTE_EXECUTOR,
  });

/**
 * The send this file re-decides on resume.
 *
 * It was `send_followup`, which Firia's S1-7 ruling (2026-10-18) moved to the `human` tier: it
 * proposes now, so it never reaches an executor, never commits a PENDING `ALLOW:send` row, and
 * cannot be crashed on — none of which is what F1 is about. F1 is about a send that was ALLOWED
 * by one process, written down, and then re-decided by the process that comes back, and
 * `notify_affected_therapist` is an auto-tier send of exactly that shape.
 */
const followupCall = () =>
  toolCall("notify_affected_therapist", {
    therapy_session_token: session.sessionId,
    child_token: sc.children[0],
    impact: "LATE",
    eta: "09:30",
  });

/** The run whose last step is a send: one turn, so the PENDING row is the send itself. */
const SEND_SCRIPT = () => [followupCall()];

const outbound = () =>
  db.query<{ state: string; template_id: string; block_reason: string | null }>(
    "SELECT state, template_id, block_reason FROM ops.outbound_message ORDER BY created_at",
    [],
  ).then((r) => r.rows);

/** The PENDING row a dead process left, and what the resume made of it. */
const sendRow = async (runId: string) => (await toolCalls(db, runId))[0];

/**
 * Crash on the send, then hand the half-finished run to a process whose context carries `over`.
 * Returns the run id and the resumed result.
 */
async function crashThenResume(over: Partial<PolicyContext>) {
  const dying = crashingOn("notify_affected_therapist", SEND_SCRIPT());
  await expect(dying.start(trigger())).rejects.toBeInstanceOf(SimulatedCrash);

  const runId = (await db.query<{ id: string }>("SELECT id FROM ops.agent_run", [])).rows[0].id;
  const pending = await sendRow(runId);
  // The state F1 is about: allowed, written down, not executed, and nothing queued.
  expect([pending.tool, pending.status, pending.policyDecision]).toEqual([
    "notify_affected_therapist", "PENDING", "ALLOW:send",
  ]);
  expect(await outbound()).toEqual([]);

  const back = resumingWith(over, SEND_SCRIPT());
  const resumed = await back.drive(runId);
  return { runId, resumed, back };
}

describe("the control: a resumed send that nothing refused goes out", () => {
  it("queues under the original key and the outbox sends it", async () => {
    const { resumed, runId, back } = await crashThenResume({});

    /*
     * WAITING_TOOL, because this send asks for an acknowledgment and parks the run on its
     * deadline (§11.1; `exec/therapist.ts`). What F1's control is about is the step before that:
     * the persisted ALLOW was executed rather than refused, and the message is in the outbox.
     */
    expect(resumed.state).toBe("WAITING_TOOL");
    const row = await sendRow(runId);
    expect(row.status).toBe("EXECUTED");
    // No re-decision happened, so nothing says one did.
    expect(row.result).not.toHaveProperty("tightened_on_resume");

    const queued = await outbound();
    expect(queued.map((m) => m.state)).toEqual(["QUEUED"]);
    expect(queued[0].template_id).toMatch(/^therapist\./);
    expect(await back.drainOutbox()).toEqual(["SENT"]);
    expect(back.provider.sent).toHaveLength(1);
  });
});

describe("F1 a pause that lands between the persist and the resume", () => {
  it("refuses the resumed send instead of executing the row's ALLOW", async () => {
    const { resumed, runId, back } = await crashThenResume({ paused: true });

    expect([resumed.state, resumed.reason]).toEqual([
      "FAILED", "policy blocked notify_affected_therapist (send_while_paused)",
    ]);
    const row = await sendRow(runId);
    // The row keeps the decision it was persisted with — that is a fact about the turn that
    // produced it — and records that the effect-time decision was a stricter one.
    expect(row.policyDecision).toBe("ALLOW:send");
    expect([row.status, row.result]).toEqual([
      "BLOCKED",
      {
        blocked_rule: "send_while_paused",
        prompt_facts: { refused: "send_while_paused" },
        tightened_on_resume: "ALLOW:send",
        task_ids: [policyTaskId(row.idempotencyKey, 0)],
      },
    ]);

    // Nothing was queued and nothing left: "sending while paused" measured at the provider.
    expect(await outbound()).toEqual([]);
    expect(await back.drainOutbox()).toEqual([]);
    expect(back.provider.sent).toEqual([]);
    // And the refusal is a task a coordinator can act on (AGT-02), not just a log line.
    const tasks = await db.query<{ category: string; severity: string }>(
      "SELECT category, severity FROM ops.task", []);
    expect(tasks.rows).toHaveLength(1);
  });

  it("still lets a paused run say why it stopped: escalate_exception is always allowed", async () => {
    // §11.2 marks `escalate_exception` "always allowed", so the tightening is the policy engine's
    // rule and not a blanket "paused means stop" — a resumed escalation still writes its task.
    const escalate = () => toolCall("escalate_exception", {
      severity: "AMBER", category: "POLICY_BLOCK", leg_id: sc.legs[sc.children[0]].AM,
      summary: "The agent stopped and a person has to take this on", next_step_code: "STAFF_REVIEW",
    });
    const dying = crashingOn("escalate_exception", [escalate()]);
    await expect(dying.start(trigger())).rejects.toBeInstanceOf(SimulatedCrash);
    const runId = (await db.query<{ id: string }>("SELECT id FROM ops.agent_run", [])).rows[0].id;

    const back = resumingWith({ paused: true }, [escalate()]);
    expect((await back.drive(runId)).state).toBe("SUCCEEDED");
    expect((await sendRow(runId)).status).toBe("EXECUTED");
    const tasks = await db.query<{ category: string }>("SELECT category FROM ops.task", []);
    expect(tasks.rows.map((t) => t.category)).toEqual(["POLICY_BLOCK"]);
  });
});

describe("F1 a consent withdrawal that lands between the persist and the resume", () => {
  it("refuses the resumed send, and queues nothing for a family that has opted out", async () => {
    const dying = crashingOn("notify_affected_therapist", SEND_SCRIPT());
    await expect(dying.start(trigger())).rejects.toBeInstanceOf(SimulatedCrash);
    const runId = (await db.query<{ id: string }>("SELECT id FROM ops.agent_run", [])).rows[0].id;

    // The family texts STOP while the process is down: one consent event, one suppression row.
    /*
     * The suites' gateway (S1-6): `recordConsent` appends the consent event through one now. In
     * memory, because this call is inside `db.tx` and a second transaction on the same PGlite
     * connection would wait on the first forever. What the test is about is unchanged — the
     * `ops.suppression` row, written in this transaction.
     */
    const consent = await db.tx((tx) => recordConsent(tx, GATEWAY, {
      siteId: sc.siteId, contactToken: sc.contactToken, channel: "SMS_1TO1", kind: "STOP",
      at: now, by: "test",
    }));
    expect(consent.suppression).toBe("added");

    // A session builds `sendableSubjects` from that same ledger, so the context the returning
    // process assembles no longer holds this child.
    const back = resumingWith({ sendableSubjects: new Set() }, SEND_SCRIPT());
    const resumed = await back.drive(runId);

    expect([resumed.state, resumed.reason]).toEqual([
      "FAILED", "policy blocked notify_affected_therapist (non_consented_number)",
    ]);
    const row = await sendRow(runId);
    expect([row.status, row.policyDecision]).toEqual(["BLOCKED", "ALLOW:send"]);
    expect(row.result).toMatchObject({
      blocked_rule: "non_consented_number",
      tightened_on_resume: "ALLOW:send",
    });
    // Not queued-then-blocked: never queued. Zero sends, measured at the provider.
    expect(await outbound()).toEqual([]);
    expect(back.provider.sent).toEqual([]);
  });
});

describe("F1 a version that moved between the persist and the resume", () => {
  const legRow = (id: string) =>
    db.query<{ state: string; version: number; plan_version: number }>(
      "SELECT state, version, plan_version FROM ops.trip_leg WHERE id = $1", [id],
    ).then((r) => r.rows[0]);

  const CANCEL_SCRIPT = () => [
    toolCall("resolve_sender", { message_id: sc.messageId }),
    toolCall("get_leg_state", { leg_id: sc.legs[sc.children[0]].AM }),
    toolCall("cancel_attendance_or_leg", {
      child_token: sc.children[0], date: sc.serviceDate, day_part: "AM",
      reason_code: "FAMILY_DROPOFF", expected_self_arrival: "09:30", expected_version: 1,
    }),
  ];

  it("the resumed cancel is refused by the effect-time version guard: 412, canceled_stale", async () => {
    const legId = sc.legs[sc.children[0]].AM;
    const dying = crashingOn("cancel_attendance_or_leg", CANCEL_SCRIPT());
    await expect(dying.start(trigger())).rejects.toBeInstanceOf(SimulatedCrash);
    const runId = (await db.query<{ id: string }>("SELECT id FROM ops.agent_run", [])).rows[0].id;
    expect((await toolCalls(db, runId)).map((c) => c.status)).toEqual(["EXECUTED", "EXECUTED", "PENDING"]);

    // Staff move the leg while the agent is down. The model's `expected_version` is now a lie, and
    // the resume is guarded on *that* argument rather than on a version read afresh.
    await db.query(
      "UPDATE ops.trip_leg SET state = 'PROVISIONAL_ASSIGNED', version = version + 1 WHERE id = $1",
      [legId],
    );

    const back = resumingWith({}, CANCEL_SCRIPT());
    const resumed = await back.drive(runId);

    expect(resumed.state).toBe("FAILED");
    const call = (await toolCalls(db, runId))[2];
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
    // The staff edit stands, and the cancel left no receipt behind.
    expect(await legRow(legId)).toEqual({ state: "PROVISIONAL_ASSIGNED", version: 2, plan_version: 1 });
    expect((await db.query("SELECT id FROM ops.attendance_exception", [])).rows).toEqual([]);
  });

  it("the control: the same resumed cancel goes through when the version did not move", async () => {
    const legId = sc.legs[sc.children[0]].AM;
    const dying = crashingOn("cancel_attendance_or_leg", CANCEL_SCRIPT());
    await expect(dying.start(trigger())).rejects.toBeInstanceOf(SimulatedCrash);
    const runId = (await db.query<{ id: string }>("SELECT id FROM ops.agent_run", [])).rows[0].id;

    const back = resumingWith({}, CANCEL_SCRIPT());
    expect((await back.drive(runId)).state).toBe("SUCCEEDED");
    expect((await toolCalls(db, runId))[2].status).toBe("EXECUTED");
    expect(await legRow(legId)).toMatchObject({ state: "CANCELED_TRANSPORT" });
  });
});
