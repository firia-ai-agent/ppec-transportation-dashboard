/**
 * B-08 slice 4, §11.2 `notify_affected_therapist` — **AT-14** ("therapist notified ≤10 min, ack
 * tracked") as far as this slice owns it: the overlapping-session lookup, the minimized SMS through
 * the real outbox, the session's status, and the acknowledgment the run then waits on.
 *
 * The timezone case is here rather than in a timezone suite of its own because the session's start
 * time is the one *value* that goes out: it is a calendar-local clock time in the site's zone (PRD
 * §6.1), so a value rendered from the process's zone would be right under TZ=America/New_York and
 * an hour out under TZ=UTC.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { testIdentityGateway } from "@/test/identity-gateway";

/**
 * The suites' identity gateway (S1-6). `read_message`, the capability report and the drain's
 * consent check all ask `IdentityGateway` now rather than the connection — and this one answers
 * from the rows `seedAgentScenario` just wrote. See src/test/identity-gateway.ts for why it is in
 * memory rather than `dbIdentityGateway` over this handle.
 */
const GATEWAY = testIdentityGateway({ pepper: PEPPER });
import { PEPPER } from "@/test/messaging";
import type { PGlite } from "@electric-sql/pglite";
import type { Db } from "@/db/exec";
import { TEST_NOW } from "@/test/clock";
import { freshDb } from "@/test/pglite";
import { type AgentScenario, seedAgentScenario, seedTherapySession } from "@/test/agent-state";
import type { PolicyContext } from "../../policy";
import { toolCall } from "../../providers/fake";
import type { ProviderResponseBody } from "../../providers/provider";
import type { TierFacts } from "../context";
import { toolCalls } from "../store";
import { AGENT_AWAIT_TASK_CATEGORY, awaitTimerKey } from "../timers";
import type { Trigger } from "../triggers";
import { PREDICATE_ACK_CLOSED } from "./predicate";
import { THERAPIST_ACK_SECONDS, THERAPIST_NOTIFIED } from "./therapist";
import { type LiveHarness, liveHarness } from "./live-harness";

let pg: PGlite;
let db: Db;
let now: Date;
let sc: AgentScenario;
let session: { therapistId: string; personToken: string; sessionId: string };
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
  t1: `site=${sc.siteId} family=${sc.familyGroupId} scopes=RECEIVE_TRANSPORT_UPDATES`,
  t2: `service_date=${sc.serviceDate}`,
  t3: ["staying home sick"],
  t4: "channel=SMS locale=en-US",
});

const policy = (): PolicyContext => ({
  scope: { ...sc.scope, tokens: new Set([...sc.scope.tokens, session.sessionId]) },
  sendableSubjects: new Set([sc.threadId, session.sessionId, ...sc.children]),
  sourceMessageId: sc.messageId,
});

const harness = (script: readonly ProviderResponseBody[]): LiveHarness =>
  liveHarness({
    gateway: GATEWAY, db, script, facts: facts(), policy: policy(), now: () => now });

const notifyCall = (over: Record<string, unknown> = {}) =>
  toolCall("notify_affected_therapist", {
    therapy_session_token: session.sessionId,
    child_token: sc.children[0],
    impact: "ABSENT",
    eta: null,
    ...over,
  });

/** The AT-14 run: the sender is resolved (which is where the service date comes from), then notify. */
const notifyScript = (over: Record<string, unknown> = {}): ProviderResponseBody[] => [
  toolCall("resolve_sender", { message_id: sc.messageId }),
  notifyCall(over),
];

const outbound = async () =>
  (await db.query<{
    id: string; purpose: string; recipient_rule: string; recipient_token: string; channel: string;
    template_id: string; vars: Record<string, unknown>; child_token: string | null;
    therapy_session_id: string | null; plan_version_basis: number; state: string; idempotency_key: string;
  }>(
    `SELECT id, purpose, recipient_rule, recipient_token, channel, template_id, vars, child_token,
       therapy_session_id, plan_version_basis, state, idempotency_key
     FROM ops.outbound_message ORDER BY created_at`, [])).rows;
const acks = async () =>
  (await db.query<{ id: string; state: string; contact_token: string; due_at: Date; outbound_message_id: string }>(
    "SELECT id, state, contact_token, due_at, outbound_message_id FROM ops.acknowledgment ORDER BY created_at", [])).rows;
const sessionStatus = async () =>
  (await db.query<{ status: string; version: number }>(
    "SELECT status, version FROM ops.therapy_session WHERE id = $1", [session.sessionId])).rows[0];
const tasks = async () =>
  (await db.query<{ category: string; severity: string; completion_predicate: string }>(
    "SELECT category, severity, completion_predicate FROM ops.task ORDER BY created_at", [])).rows;

const seedSession = async (over: { startsAt?: Date; childToken?: string } = {}) => {
  session = await seedTherapySession(db, {
    siteId: sc.siteId,
    childToken: over.childToken ?? sc.children[0],
    startsAt: over.startsAt ?? new Date("2026-10-15T13:00:00.000Z"),
  });
};

describe("AT-14 the therapist of an overlapping session is told, in codes, and the ack is tracked", () => {
  it("queues the minimized alert, moves the session to THERAPIST_NOTIFIED and waits ten minutes", async () => {
    sc = await seedAgentScenario(db);
    await seedSession();
    const h = harness(notifyScript());
    const r = await h.start(trigger());

    // §11.1: the ack is a task plus a timer, not a held session.
    expect([r.state, r.steps]).toEqual(["WAITING_TOOL", 2]);
    expect(r.awaiting).toMatchObject({
      jobKey: awaitTimerKey(r.runId, 1),
      dueAt: new Date(now.getTime() + THERAPIST_ACK_SECONDS * 1000),
    });

    const [msg] = await outbound();
    expect(await outbound()).toHaveLength(1);
    expect(msg).toMatchObject({
      purpose: "THERAPIST_ALERT",
      recipient_rule: "therapist_of_session",
      recipient_token: session.personToken,
      channel: "SMS_1TO1",
      template_id: "therapist.absence_alert",
      child_token: sc.children[0],
      therapy_session_id: session.sessionId,
      plan_version_basis: 0,
      state: "QUEUED",
      idempotency_key: `agent:${r.runId}:1`,
    });
    // The session's start time in the site's zone, and nothing else: no name, no number, no prose.
    expect(msg.vars).toEqual({ sessionStart: "09:00" });

    expect(await sessionStatus()).toEqual({ status: THERAPIST_NOTIFIED, version: 2 });

    const [ack] = await acks();
    expect([ack.state, ack.contact_token, ack.outbound_message_id]).toEqual([
      "PENDING", session.personToken, msg.id,
    ]);
    expect(new Date(ack.due_at).toISOString()).toBe(new Date(now.getTime() + THERAPIST_ACK_SECONDS * 1000).toISOString());

    // The wait is closable by the ack coming back, and nothing else.
    expect(await tasks()).toEqual([
      expect.objectContaining({
        category: AGENT_AWAIT_TASK_CATEGORY,
        severity: "GREEN",
        completion_predicate: PREDICATE_ACK_CLOSED,
      }),
    ]);

    // The send-time half: the therapist's authorization for that child is re-checked per contact.
    expect(await h.drainOutbox()).toEqual(["SENT"]);
    expect(h.provider.sent).toHaveLength(1);
    expect(h.provider.sent[0]).toMatchObject({
      templateId: "therapist.absence_alert",
      recipientToken: session.personToken,
      vars: { sessionStart: "09:00" },
    });
    const wire = JSON.stringify(h.provider.sent);
    expect(wire).not.toContain(sc.number);
    expect(wire).not.toContain("sick");

    const calls = await toolCalls(db, r.runId);
    expect(calls.map((c) => [c.tool, c.status])).toEqual([
      ["resolve_sender", "EXECUTED"],
      ["notify_affected_therapist", "EXECUTED"],
    ]);
    expect(calls[1].result).toMatchObject({
      session_status: THERAPIST_NOTIFIED, impact: "ABSENT", ack_state: "PENDING",
    });
  });

  it("a session on another day is not an overlapping session, and nothing is sent", async () => {
    sc = await seedAgentScenario(db);
    await seedSession({ startsAt: new Date("2026-10-16T13:00:00.000Z") });
    const h = harness(notifyScript());
    const r = await h.start(trigger());

    expect(r.state).toBe("FAILED");
    expect((await toolCalls(db, r.runId))[1].result).toMatchObject({
      error_code: "NO_OVERLAPPING_SESSION",
      service_date: sc.serviceDate,
      session_date: "2026-10-16",
    });
    expect(await outbound()).toEqual([]);
    expect(await acks()).toEqual([]);
    expect(await sessionStatus()).toEqual({ status: "SCHEDULED", version: 1 });
  });

  it("a session about another child, and a canceled one, are both NOT_FOUND", async () => {
    sc = await seedAgentScenario(db, { children: 2 });
    await seedSession({ childToken: sc.children[1] });
    const other = harness(notifyScript());
    const r = await other.start(trigger());
    expect((await toolCalls(db, r.runId))[1].result).toMatchObject({
      error_code: "NOT_FOUND", object: "therapy_session",
    });

    await db.query("UPDATE ops.therapy_session SET status = 'CANCELED' WHERE id = $1", [session.sessionId]);
    const canceled = harness([
      toolCall("resolve_sender", { message_id: sc.messageId }),
      notifyCall({ child_token: sc.children[1] }),
    ]);
    const r2 = await canceled.start({ ...trigger(), id: "MSG-CANCELED" });
    expect((await toolCalls(db, r2.runId))[1].result).toMatchObject({
      error_code: "NOT_FOUND", object: "therapy_session",
    });
    expect(await outbound()).toEqual([]);
  });

  it("a session somebody has already been told about is not told twice", async () => {
    sc = await seedAgentScenario(db);
    await seedSession();
    await db.query(
      "UPDATE ops.therapy_session SET status = $1, version = version + 1 WHERE id = $2",
      [THERAPIST_NOTIFIED, session.sessionId],
    );
    const h = harness(notifyScript());
    const r = await h.start(trigger());

    expect(r.state).toBe("FAILED");
    expect((await toolCalls(db, r.runId))[1].result).toMatchObject({
      error_code: "SESSION_NOT_NOTIFIABLE",
      session_status: THERAPIST_NOTIFIED,
    });
    expect(await outbound()).toEqual([]);
  });

  it("the impact code chooses the body: lateness carries the ETA, an early pickup the fixed notice", async () => {
    sc = await seedAgentScenario(db);
    await seedSession();
    const late = harness(notifyScript({ impact: "LATE", eta: "09:20" }));
    await late.start(trigger());
    expect((await outbound())[0]).toMatchObject({ template_id: "therapist.late_alert" });
    expect((await outbound())[0].vars).toEqual({ sessionStart: "09:00", eta: "09:20" });

    // A second session for the same child, since the first one has now been notified.
    await seedSession();
    const early = harness(notifyScript({ impact: "EARLY_PICKUP" }));
    await early.start({ ...trigger(), id: "MSG-EARLY" });
    const notice = (await outbound())[1];
    expect(notice).toMatchObject({ template_id: "generic.notice", therapy_session_id: session.sessionId });
    expect(notice.vars).toEqual({});
  });

  it("the same call driven twice notifies once", async () => {
    sc = await seedAgentScenario(db);
    await seedSession();
    const h = harness(notifyScript());
    const r = await h.start(trigger());
    expect(await outbound()).toHaveLength(1);

    // The run is parked, so a second drive takes no step; the sink's own key is what guarantees it.
    const again = await h.drive(r.runId);
    expect(again.reason).toBe("run is parked on a timer");
    expect(await outbound()).toHaveLength(1);
    expect(await acks()).toHaveLength(1);
    expect(await sessionStatus()).toEqual({ status: THERAPIST_NOTIFIED, version: 2 });
  });

  it("the session start that goes out is the site's clock time, not the process's", async () => {
    // 2026-10-15T23:30Z is 19:30 on the 15th in America/New_York. A value rendered in process-local
    // time would read 23:30 under TZ=UTC, and the service date would be the 16th.
    sc = await seedAgentScenario(db, { receivedAt: new Date("2026-10-15T23:00:00.000Z") });
    now = new Date("2026-10-15T23:00:00.000Z");
    await seedSession({ startsAt: new Date("2026-10-15T23:30:00.000Z") });
    const h = harness(notifyScript());
    const r = await h.start(trigger());

    expect(r.state).toBe("WAITING_TOOL");
    expect((await outbound())[0].vars).toEqual({ sessionStart: "19:30" });
  });
});
