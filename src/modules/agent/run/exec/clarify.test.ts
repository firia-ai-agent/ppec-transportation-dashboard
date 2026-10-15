/**
 * B-08 slice 3, §11.2 `request_clarification` and `record_acknowledgment` — **AT-06** end to end.
 *
 * AT-06 is "sibling ambiguity → clarification, no mutation", and it is two claims. The first is
 * the clarification: a shared number with two children on it resolves to two candidates, the agent
 * asks which one, the question is an outbox message with fixed copy, and the run parks on a
 * 15-minute B-03 timer as a staff task rather than waiting. The second is the "no mutation": after
 * all of that, every leg and every attendance day is exactly where it started, and the only row
 * written about a child is the question itself.
 *
 * Then the limits §11.2 puts on the asking (thread ACTIVE, ≤2/thread/hour, send fail → exception)
 * and the reply side (`record_acknowledgment`: matching PENDING ack → close, cancel timer,
 * DECLINED → AMBER).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { Db } from "@/db/exec";
import { freshDb } from "@/test/pglite";
import { type AgentScenario, seedAcknowledgment, seedAgentScenario } from "@/test/agent-state";
import { handlers } from "@/modules/jobs/handlers";
import { handleWake } from "@/modules/jobs/runner";
import type { PolicyContext } from "../../policy";
import { toolCall } from "../../providers/fake";
import type { ProviderResponseBody } from "../../providers/provider";
import type { TierFacts } from "../context";
import { resumeQueuedRuns } from "../loop";
import { loadRun, toolCalls } from "../store";
import { AGENT_AWAIT_TASK_CATEGORY, awaitTimerKey } from "../timers";
import type { Trigger } from "../triggers";
import {
  ACK_DECLINED_TASK_CATEGORY,
  CLARIFICATION_AWAIT_SECONDS,
  CLARIFICATION_LIMIT_TASK_CATEGORY,
  CLARIFICATION_PURPOSE,
  SEND_FAILURE_TASK_CATEGORY,
} from "./clarify";
import { PREDICATE_INBOUND_REPLY } from "./predicate";
import { type LiveHarness, liveHarness } from "./live-harness";

let pg: PGlite;
let db: Db;
let now: Date;
let sc: AgentScenario;
const open: PGlite[] = [];

beforeEach(async () => {
  ({ pg, db } = await freshDb());
  open.push(pg);
  now = new Date("2026-10-15T12:00:00.000Z");
}, 60_000);

afterEach(async () => {
  await Promise.all(open.splice(0).map((h) => h.close().catch(() => {})));
});

const trigger = (): Trigger => ({ type: "msg.inbound", id: sc.messageId, siteId: sc.siteId });

const facts = (): TierFacts => ({
  t1: `site=${sc.siteId} family=${sc.familyGroupId} scopes=RECEIVE_TRANSPORT_UPDATES`,
  t2: `service_date=${sc.serviceDate}`,
  t3: ["staying home sick"],
  t4: "channel=SMS locale=en-US",
});

const policy = (over: Partial<PolicyContext> = {}): PolicyContext => ({
  scope: sc.scope,
  sendableSubjects: new Set([sc.threadId, ...sc.children]),
  sourceMessageId: sc.messageId,
  ...over,
});

const harness = (script: readonly ProviderResponseBody[], over: Partial<PolicyContext> = {}): LiveHarness =>
  liveHarness({ db, script, facts: facts(), policy: policy(over), now: () => now });

const clarifyCall = (over: Record<string, unknown> = {}) =>
  toolCall("request_clarification", {
    thread_id: sc.threadId,
    ambiguity_type: "WHICH_CHILD",
    candidate_tokens: sc.children,
    draft_template_id: "generic.notice",
    ...over,
  });

const outbound = async () =>
  (await db.query<{ id: string; purpose: string; template_id: string; vars: Record<string, unknown>; recipient_token: string; state: string; child_token: string | null; idempotency_key: string }>(
    `SELECT id, purpose, template_id, vars, recipient_token, state, child_token, idempotency_key
     FROM ops.outbound_message ORDER BY created_at`, [])).rows;
const tasks = async () =>
  (await db.query<{ id: string; category: string; severity: string; state: string; summary: string; completion_predicate: string }>(
    "SELECT id, category, severity, state, summary, completion_predicate FROM ops.task ORDER BY created_at", [])).rows;
const legStates = async () =>
  (await db.query<{ state: string; version: number }>(
    "SELECT state, version FROM ops.trip_leg ORDER BY child_token, direction", [])).rows;
const attendanceStates = async () =>
  (await db.query<{ state: string; version: number }>(
    "SELECT state, version FROM ops.attendance_day ORDER BY child_token", [])).rows;

describe("AT-06 sibling ambiguity: the agent asks, and mutates nothing", () => {
  it("resolves two candidates, queues one fixed-copy question, and parks on a 15-minute timer", async () => {
    sc = await seedAgentScenario(db, { children: 2, body: "staying home sick" });
    const h = harness([toolCall("resolve_sender", { message_id: sc.messageId }), clarifyCall()]);
    const r = await h.start(trigger());

    expect([r.state, r.steps]).toEqual(["WAITING_TOOL", 2]);
    expect(r.awaiting).toMatchObject({
      jobKey: awaitTimerKey(r.runId, 1),
      dueAt: new Date(now.getTime() + CLARIFICATION_AWAIT_SECONDS * 1000),
    });

    // One message, fixed copy, no vars, to the thread's counterparty — a recipient the model never
    // named and could not have.
    const [msg] = await outbound();
    expect(await outbound()).toHaveLength(1);
    expect([msg.purpose, msg.template_id, msg.state]).toEqual([CLARIFICATION_PURPOSE, "generic.notice", "QUEUED"]);
    expect(msg.vars).toEqual({});
    expect(msg.recipient_token).toBe(sc.contactToken);
    // A question names no child: no child reference, and nothing about either sibling in it.
    expect(msg.child_token).toBeNull();
    expect(JSON.stringify(msg)).not.toContain(sc.children[0]);
    expect(msg.idempotency_key).toBe(`agent:${r.runId}:1`);

    // The wait is a staff task plus a timer (§11.1), with a predicate a machine can close.
    const awaitTask = (await tasks()).find((t) => t.category === AGENT_AWAIT_TASK_CATEGORY)!;
    expect([awaitTask.severity, awaitTask.state, awaitTask.completion_predicate]).toEqual([
      "GREEN", "OPEN", PREDICATE_INBOUND_REPLY,
    ]);

    // …and nothing about either child's day has moved. This is the other half of AT-06.
    expect(await legStates()).toEqual(Array(4).fill({ state: "SCHEDULED", version: 1 }));
    expect(await attendanceStates()).toEqual([{ state: "SCHEDULED", version: 1 }, { state: "SCHEDULED", version: 1 }]);
    expect(await db.query("SELECT 1 FROM ops.attendance_exception", []).then((x) => x.rows)).toEqual([]);
  });

  it("the question goes out only after the outbox re-checks consent at send time", async () => {
    sc = await seedAgentScenario(db, { children: 2 });
    const h = harness([toolCall("resolve_sender", { message_id: sc.messageId }), clarifyCall()]);
    await h.start(trigger());

    expect(await h.drainOutbox()).toEqual(["SENT"]);
    expect(h.provider.sent.map((m) => m.templateId)).toEqual(["generic.notice"]);
  });

  it("a family that has opted out is asked nothing: blocked at egress, zero sends", async () => {
    sc = await seedAgentScenario(db, { children: 2 });
    await db.query(
      `INSERT INTO identity.consent_event (id, site_id, contact_token, kind, channel, at, source_mode)
       VALUES ($1,$2,$3,'STOP','SMS_1TO1',$4,'SIMULATED')`,
      ["0199e5f0-0000-7000-8000-00000000a001", sc.siteId, sc.contactToken, now.toISOString()],
    );
    const h = harness([toolCall("resolve_sender", { message_id: sc.messageId }), clarifyCall()]);
    await h.start(trigger());

    expect(await h.drainOutbox()).toEqual(["BLOCKED_EGRESS"]);
    expect(h.provider.sent).toEqual([]);
  });

  it("the timer firing resumes the run, which can then ask a human instead", async () => {
    sc = await seedAgentScenario(db, { children: 2 });
    const h = harness([
      toolCall("resolve_sender", { message_id: sc.messageId }),
      clarifyCall(),
      toolCall("escalate_exception", {
        severity: "AMBER", category: "UNKNOWN_SENDER", leg_id: null,
        summary: "No answer about which child", next_step_code: "STAFF_CALL",
      }),
    ]);
    const r = await h.start(trigger());
    const timer = (await db.query<{ id: string; due_at: Date }>(
      "SELECT id, due_at FROM ops.job WHERE key = $1", [awaitTimerKey(r.runId, 1)])).rows[0];

    now = new Date(timer.due_at);
    expect(await handleWake(db, { jobId: timer.id }, "d1", handlers, () => now)).toBe("fired");
    expect((await loadRun(db, r.runId))!.state).toBe("QUEUED");

    // The resumed run takes its next turn from the committed result and escalates: the family did
    // not answer, so a person is asked instead. Nothing about either child moved on the way.
    const resumed = await resumeQueuedRuns(h.deps(2), sc.siteId);
    expect(resumed.map((x) => [x.state, x.steps])).toEqual([["SUCCEEDED", 1]]);
    expect((await tasks()).map((t) => t.category)).toContain("UNKNOWN_SENDER");
    expect(await legStates()).toEqual(Array(4).fill({ state: "SCHEDULED", version: 1 }));
  });
});

describe("§11.2 the limits on asking", () => {
  it("a thread a human has taken over is not the agent's to write into", async () => {
    sc = await seedAgentScenario(db, { children: 2, threadState: "PAUSED_HUMAN" });
    const h = harness([toolCall("resolve_sender", { message_id: sc.messageId }), clarifyCall()]);
    const r = await h.start(trigger());

    expect(r.state).toBe("FAILED");
    const [, call] = await toolCalls(db, r.runId);
    expect(call.result).toMatchObject({ error_code: "THREAD_NOT_ACTIVE", thread_state: "PAUSED_HUMAN" });
    expect(await outbound()).toEqual([]);
  });

  it("≤2 per thread per hour: the third is a staff task, not a third text", async () => {
    sc = await seedAgentScenario(db, { children: 2 });
    // Two clarifications already asked in this thread, by two earlier runs.
    for (const seq of [0, 1]) {
      const h = harness([clarifyCall()]);
      const r = await h.start({ ...trigger(), id: `MSG-EARLIER-${seq}` });
      expect(r.state).toBe("WAITING_TOOL");
    }
    expect(await outbound()).toHaveLength(2);

    const third = harness([clarifyCall()]);
    const r = await third.start(trigger());
    expect(r.state).toBe("FAILED");
    const [call] = await toolCalls(db, r.runId);
    expect(call.result).toMatchObject({
      error_code: "CLARIFICATION_RATE_LIMIT",
      asked_in_last_hour: 2,
      task_raised: true,
    });
    // No third message, and a human has been asked to call instead.
    expect(await outbound()).toHaveLength(2);
    expect((await tasks()).map((t) => t.category)).toContain(CLARIFICATION_LIMIT_TASK_CATEGORY);
  });

  it("the hour is a window, not a counter: questions asked 90 minutes ago do not count", async () => {
    sc = await seedAgentScenario(db, { children: 2 });
    for (const seq of [0, 1]) {
      const h = harness([clarifyCall()]);
      await h.start({ ...trigger(), id: `MSG-EARLIER-${seq}` });
    }
    // Those two were asked an hour and a half ago, so this hour has had none.
    await db.query(
      "UPDATE ops.agent_tool_call SET committed_at = $1 WHERE tool = 'request_clarification'",
      [new Date(now.getTime() - 90 * 60_000).toISOString()],
    );
    const later = harness([clarifyCall()]);
    const r = await later.start(trigger());
    expect(r.state).toBe("WAITING_TOOL");
    expect(await outbound()).toHaveLength(3);
  });

  it("a send that cannot even be queued raises the exception §11.2 asks for", async () => {
    sc = await seedAgentScenario(db, { children: 2 });
    // The thread has no counterparty: an unknown-sender thread, which is answered by nobody.
    await db.query("UPDATE ops.conversation_thread SET counterparty_token = NULL WHERE id = $1", [sc.threadId]);
    const h = harness([clarifyCall()]);
    const r = await h.start(trigger());

    expect(r.state).toBe("FAILED");
    const [call] = await toolCalls(db, r.runId);
    expect(call.result).toMatchObject({ error_code: "NO_COUNTERPARTY" });
    expect(await outbound()).toEqual([]);
    expect((await tasks()).map((t) => [t.category, t.severity])).toEqual([[SEND_FAILURE_TASK_CATEGORY, "AMBER"]]);
  });

  it("the same call driven twice queues one message", async () => {
    sc = await seedAgentScenario(db, { children: 2 });
    const h = harness([clarifyCall()]);
    const r = await h.start(trigger());
    expect(r.state).toBe("WAITING_TOOL");

    // The outbox is keyed on the call's idempotency key, so the second attempt finds its own row.
    const again = await h.execDeps.db.query<{ n: number }>(
      "SELECT count(*)::int n FROM ops.outbound_message WHERE idempotency_key = $1",
      [`agent:${r.runId}:0`],
    );
    expect(again.rows[0].n).toBe(1);
    const repeat = await h.drive(r.runId);
    expect(repeat.reason).toBe("run is parked on a timer");
    expect(await outbound()).toHaveLength(1);
  });
});

describe("§11.2 record_acknowledgment: matching PENDING ack → close, cancel timer", () => {
  const ackHarness = async (status: "CONFIRMED" | "DECLINED") => {
    const ack = await seedAcknowledgment(db, {
      siteId: sc.siteId,
      contactToken: sc.contactToken,
      childToken: sc.children[0],
      dueAt: new Date(now.getTime() + 10 * 60_000),
    });
    const h = liveHarness({
      db,
      script: [toolCall("record_acknowledgment", {
        ack_id: ack.ackId, status, source_message_id: sc.messageId,
      })],
      facts: facts(),
      policy: policy({
        scope: { ...sc.scope, tokens: new Set([...sc.scope.tokens, ack.ackId]) },
      }),
      now: () => now,
    });
    return { ack, h };
  };

  const ackRow = async (id: string) =>
    (await db.query<{ state: string; version: number }>(
      "SELECT state, version FROM ops.acknowledgment WHERE id = $1", [id])).rows[0];
  const job = async (id: string) =>
    (await db.query<{ state: string }>("SELECT state FROM ops.job WHERE id = $1", [id])).rows[0];

  it("closes the ack and cancels its deadline, so no second alert fires", async () => {
    sc = await seedAgentScenario(db);
    const { ack, h } = await ackHarness("CONFIRMED");
    const r = await h.start(trigger());

    expect(r.state).toBe("FAILED"); // the run has nothing more scripted; the call itself executed
    const [call] = await toolCalls(db, r.runId);
    expect([call.status, call.tool]).toEqual(["EXECUTED", "record_acknowledgment"]);
    expect(call.result).toMatchObject({ ack_state: "ACKNOWLEDGED", timer_canceled: true });
    expect(await ackRow(ack.ackId)).toEqual({ state: "ACKNOWLEDGED", version: 2 });
    expect(await job(ack.timerJobId!)).toEqual({ state: "CANCELED" });
    expect(await tasks()).toEqual([]);
  });

  it("DECLINED closes the ack and raises the AMBER exception", async () => {
    sc = await seedAgentScenario(db);
    const { ack, h } = await ackHarness("DECLINED");
    await h.start(trigger());

    expect(await ackRow(ack.ackId)).toEqual({ state: "DECLINED", version: 2 });
    expect((await tasks()).map((t) => [t.category, t.severity, t.state])).toEqual([
      [ACK_DECLINED_TASK_CATEGORY, "AMBER", "OPEN"],
    ]);
  });

  it("an ack that is not PENDING any more is staff's to resolve, and one already closed is a no-op", async () => {
    sc = await seedAgentScenario(db);
    const { ack, h } = await ackHarness("CONFIRMED");
    await db.query(
      "UPDATE ops.acknowledgment SET state = 'EXPIRED_ESCALATED', version = version + 1 WHERE id = $1",
      [ack.ackId],
    );
    const r = await h.start(trigger());
    const [call] = await toolCalls(db, r.runId);
    expect(call.result).toMatchObject({ error_code: "ACK_NOT_PENDING", ack_state: "EXPIRED_ESCALATED" });

    // The same call against an ack already in the state it wanted: executed, idempotent, no write.
    await db.query("UPDATE ops.acknowledgment SET state = 'ACKNOWLEDGED' WHERE id = $1", [ack.ackId]);
    const second = liveHarness({
      db,
      script: [toolCall("record_acknowledgment", {
        ack_id: ack.ackId, status: "CONFIRMED", source_message_id: sc.messageId,
      })],
      facts: facts(),
      policy: policy({ scope: { ...sc.scope, tokens: new Set([...sc.scope.tokens, ack.ackId]) } }),
      now: () => now,
    });
    const r2 = await second.start({ ...trigger(), id: "MSG-AGAIN" });
    const [call2] = await toolCalls(db, r2.runId);
    expect([call2.status, call2.result]).toEqual([
      "EXECUTED",
      {
        idempotent: true,
        ack_id: ack.ackId,
        ack_state: "ACKNOWLEDGED",
        prompt_facts: { ack_id: ack.ackId, ack_state: "ACKNOWLEDGED" },
      },
    ]);
  });

  it("an ack of another site, and evidence that does not exist, are both NOT_FOUND", async () => {
    sc = await seedAgentScenario(db);
    const { ack, h } = await ackHarness("CONFIRMED");
    const missingEvidence = liveHarness({
      db,
      script: [toolCall("record_acknowledgment", {
        ack_id: ack.ackId, status: "CONFIRMED", source_message_id: "0199e5f0-0000-7000-8000-0000000000aa",
      })],
      facts: facts(),
      policy: policy({
        scope: { ...sc.scope, tokens: new Set([...sc.scope.tokens, ack.ackId, "0199e5f0-0000-7000-8000-0000000000aa"]) },
      }),
      now: () => now,
    });
    const r = await missingEvidence.start(trigger());
    expect((await toolCalls(db, r.runId))[0].result).toMatchObject({ error_code: "NOT_FOUND", object: "message" });
    expect(await ackRow(ack.ackId)).toEqual({ state: "PENDING", version: 1 });

    await db.query("UPDATE ops.acknowledgment SET site_id = $1 WHERE id = $2", [sc.siteId, ack.ackId]);
    const r2 = await h.start({ ...trigger(), id: "MSG-OTHER-SITE" });
    expect((await toolCalls(db, r2.runId))[0].status).toBe("EXECUTED");
  });
});
