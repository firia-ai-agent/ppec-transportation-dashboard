/**
 * B-08 slice 4, §11.2's "**no reply → escalate**" — the deterministic half of **AT-02**
 * ("autonomous timer follow-up + escalation").
 *
 * Every suite below is the same two cases, on the three things the agent waits for: the answer
 * arrives before the deadline and nothing is escalated, or it does not and **exactly one**
 * exception is raised — once, however many times the wake-up is delivered. No model turn is taken
 * on either path: the harness's scripts are empty past the awaited call, so a turn would fail the
 * run rather than quietly escalate for it.
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
import type { PGlite } from "@electric-sql/pglite";
import type { Db } from "@/db/exec";
import { handlers } from "@/modules/jobs/handlers";
import { handleWake } from "@/modules/jobs/runner";
import { phoneHmac } from "@/modules/identity/phone";
import { agentNextSteps, agentNoReply } from "@/ui/copy";
import { TEST_NOW } from "@/test/clock";
import { freshDb } from "@/test/pglite";
import { PEPPER } from "@/test/messaging";
import {
  DISPATCHER_NUMBER,
  type AgentScenario,
  type ProviderRoute,
  seedAgentScenario,
  seedInbound,
  seedProviderRoute,
  seedTherapySession,
} from "@/test/agent-state";
import type { PolicyContext } from "../../policy";
import { toolCall } from "../../providers/fake";
import type { ProviderResponseBody } from "../../providers/provider";
import type { TierFacts } from "../context";
import { AGENT_AWAIT_TASK_CATEGORY, awaitTimerKey } from "../timers";
import type { Trigger } from "../triggers";
import { AGENT_ESCALATE_JOB_KIND, NO_REPLY_GRACE_SECONDS, escalateTimerKey } from "./escalate";
import { CAPABILITY_REPLY_SECONDS, CAPABILITY_TASK_CATEGORY } from "./capability";
import { CLARIFICATION_AWAIT_SECONDS, CLARIFICATION_NO_REPLY_CATEGORY } from "./clarify";
import { PREDICATE_INBOUND_REPLY } from "./predicate";
import { agentWaits } from "@/ui/copy";
import { THERAPIST_ACK_SECONDS } from "./therapist";
import { type LiveHarness, liveHarness } from "./live-harness";

let pg: PGlite;
let db: Db;
let now: Date;
let sc: AgentScenario;
const open: PGlite[] = [];

const OTHER_SITE = "00000000-0000-7000-8000-0000000000ff";

beforeEach(async () => {
  ({ pg, db } = await freshDb());
  open.push(pg);
  now = new Date(TEST_NOW);
}, 60_000);

afterEach(async () => {
  await Promise.all(open.splice(0).map((h) => h.close().catch(() => {})));
});

const facts = (): TierFacts => ({
  t1: `site=${sc.siteId} family=${sc.familyGroupId}`,
  t2: `service_date=${sc.serviceDate}`,
  t3: ["staying home sick"],
  t4: "channel=SMS locale=en-US",
});

const harness = (
  script: readonly ProviderResponseBody[],
  over: Partial<PolicyContext> = {},
  overrides: Record<string, unknown> = {},
): LiveHarness =>
  liveHarness({
    gateway: GATEWAY,
    db,
    script,
    overrides: overrides as never,
    facts: facts(),
    policy: {
      scope: sc.scope,
      sendableSubjects: new Set([sc.threadId, ...sc.children]),
      sourceMessageId: sc.messageId,
      ...over,
    },
    now: () => now,
  });

const job = async (key: string) =>
  (await db.query<{ id: string; kind: string; state: string; due_at: Date }>(
    "SELECT id, kind, state, due_at FROM ops.job WHERE key = $1", [key])).rows[0];
const tasks = async () =>
  (await db.query<{ id: string; category: string; severity: string; state: string; summary: string; next_step: string; completion_predicate: string }>(
    `SELECT id, category, severity, state, summary, next_step, completion_predicate
     FROM ops.task ORDER BY created_at`, [])).rows;
const escalations = async () => (await tasks()).filter((t) => t.category !== AGENT_AWAIT_TASK_CATEGORY);

/** Fire a due job through the ordinary B-03 consumer. */
const fire = async (jobId: string) => handleWake(db, { jobId }, "d1", handlers, () => now);
/** A redelivered wake-up for a job that has already fired: the row is re-armed and fired again. */
const fireAgain = async (jobId: string) => {
  await db.query("UPDATE ops.job SET state = 'SCHEDULED' WHERE id = $1", [jobId]);
  return fire(jobId);
};

/**
 * A QUESTION NOBODY ANSWERS (AT-02), and where its producer went.
 *
 * This block is about the escalation machinery for a wait whose answer is an **inbound reply**:
 * the deadline, the grace period, the AMBER exception raised with no model turn, and the reply
 * that closes it. All of that is live code (`exec/escalate.ts`, `run/timers.ts`) and all of it is
 * asserted below.
 *
 * What is no longer live is the one tool that produced that wait. Firia's S1-7 ruling
 * (2026-10-18) moved `request_clarification` to the `human` tier, so it proposes instead of
 * sending and there is nothing to await until a person has approved the question — the await and
 * its `inbound_reply` escalation come back when the APPROVED message is the thing being waited
 * on, which is B-12's to wire (named in the PR body as a deferral).
 *
 * So the step is driven through an override here: the same `awaitExternal` the clarification
 * executor returned, on an auto-tier send this fixture's scope already reaches. The alternative
 * was to delete the block, and the machinery it covers has not changed.
 */
describe("a question nobody answers (AT-02)", () => {
  const clarifyRun = async (): Promise<{ runId: string; escalateJobId: string; escalateAt: Date }> => {
    sc = await seedAgentScenario(db, { children: 2 });
    const h = harness(
      [
        toolCall("resolve_sender", { message_id: sc.messageId }),
        toolCall("notify_affected_therapist", {
          therapy_session_token: sc.children[0], child_token: sc.children[0], impact: "LATE", eta: "09:30",
        }),
      ],
      {},
      {
        notify_affected_therapist: async () => ({
          data: { would_send: "generic.notice" },
          awaitExternal: {
            reasonCode: "CLARIFICATION",
            afterSeconds: CLARIFICATION_AWAIT_SECONDS,
            summary: agentWaits.clarification,
            completionPredicate: PREDICATE_INBOUND_REPLY,
            escalation: {
              afterSeconds: CLARIFICATION_AWAIT_SECONDS + NO_REPLY_GRACE_SECONDS,
              reason: "CLARIFICATION",
              category: CLARIFICATION_NO_REPLY_CATEGORY,
              severity: "AMBER",
              nextStepCode: "STAFF_CALL",
              watch: { kind: "inbound_reply", threadId: sc.threadId },
            },
          },
        }),
      },
    );
    const r = await h.start({ type: "msg.inbound", id: sc.messageId, siteId: sc.siteId });
    expect(r.state).toBe("WAITING_TOOL");
    // Two deadlines: the resume, then the escalation a grace period later.
    expect(r.awaiting).toMatchObject({
      jobKey: awaitTimerKey(r.runId, 1),
      escalateJobKey: escalateTimerKey(r.runId, 1),
      dueAt: new Date(now.getTime() + CLARIFICATION_AWAIT_SECONDS * 1000),
      escalateAt: new Date(now.getTime() + (CLARIFICATION_AWAIT_SECONDS + NO_REPLY_GRACE_SECONDS) * 1000),
    });
    const escalate = await job(escalateTimerKey(r.runId, 1));
    expect([escalate.kind, escalate.state]).toEqual([AGENT_ESCALATE_JOB_KIND, "SCHEDULED"]);
    return { runId: r.runId, escalateJobId: escalate.id, escalateAt: new Date(escalate.due_at) };
  };

  it("the family replies in time: the deadline fires and escalates nothing", async () => {
    const { escalateJobId, escalateAt } = await clarifyRun();
    // The reply arrives five minutes in, as its own inbound message in the same thread.
    await seedInbound(db, {
      siteId: sc.siteId, threadId: sc.threadId, fromHmac: phoneHmac(sc.number, PEPPER),
      body: "the younger one", receivedAt: new Date(now.getTime() + 5 * 60_000),
    });

    now = escalateAt;
    expect(await fire(escalateJobId)).toBe("fired");
    expect(await escalations()).toEqual([]);
  });

  it("nobody replies: one AMBER exception, in our words, with no model turn", async () => {
    const { runId, escalateJobId, escalateAt } = await clarifyRun();
    now = escalateAt;
    expect(await fire(escalateJobId)).toBe("fired");

    const raised = await escalations();
    expect(raised).toHaveLength(1);
    expect([raised[0].category, raised[0].severity, raised[0].state]).toEqual([
      CLARIFICATION_NO_REPLY_CATEGORY, "AMBER", "OPEN",
    ]);
    expect(raised[0].summary).toContain(agentNoReply.CLARIFICATION.summary);
    // The locator points at the step that asked, so a coordinator can find the question.
    expect(raised[0].summary).toContain(`msg.inbound:${sc.messageId}`);
    expect(raised[0].next_step).toBe(agentNextSteps.STAFF_CALL);
    expect(raised[0].completion_predicate).toBe(agentNoReply.CLARIFICATION.predicate);
    // The run was not re-driven and no model was called: the escalation is the timer's own work.
    expect((await db.query<{ state: string }>("SELECT state FROM ops.agent_run WHERE id = $1", [runId])).rows[0].state)
      .toBe("WAITING_TOOL");

    // Exactly once, however often the wake-up is delivered.
    expect(await fireAgain(escalateJobId)).toBe("fired");
    expect(await escalations()).toHaveLength(1);
  });

  it("a job that belongs to another site escalates nothing (F3)", async () => {
    const { escalateJobId, escalateAt } = await clarifyRun();
    await db.query(
      `INSERT INTO ops.site (id, org_id, name, depot_lat, depot_lng, created_by, updated_by)
       SELECT $1, org_id, 'SYN Other Site', depot_lat, depot_lng, 'test', 'test' FROM ops.site WHERE id = $2`,
      [OTHER_SITE, sc.siteId],
    );
    await db.query("UPDATE ops.job SET site_id = $2 WHERE id = $1", [escalateJobId, OTHER_SITE]);

    now = escalateAt;
    expect(await fire(escalateJobId)).toBe("fired");
    expect(await escalations()).toEqual([]);
  });
});

describe("a therapist who does not acknowledge (AT-14)", () => {
  const notifyRun = async (): Promise<{
    runId: string; ackId: string; escalateJobId: string; escalateAt: Date; resumeKey: string;
  }> => {
    sc = await seedAgentScenario(db);
    const session = await seedTherapySession(db, {
      siteId: sc.siteId, childToken: sc.children[0], startsAt: new Date("2026-10-15T13:00:00.000Z"),
    });
    const h = harness([
      toolCall("resolve_sender", { message_id: sc.messageId }),
      toolCall("notify_affected_therapist", {
        therapy_session_token: session.sessionId, child_token: sc.children[0],
        impact: "ABSENT", eta: null,
      }),
    ], {
      scope: { ...sc.scope, tokens: new Set([...sc.scope.tokens, session.sessionId]) },
      sendableSubjects: new Set([sc.threadId, session.sessionId, ...sc.children]),
    });
    const r = await h.start({ type: "msg.inbound", id: sc.messageId, siteId: sc.siteId });
    expect(r.state).toBe("WAITING_TOOL");
    expect(r.awaiting!.escalateAt).toEqual(
      new Date(now.getTime() + (THERAPIST_ACK_SECONDS + NO_REPLY_GRACE_SECONDS) * 1000),
    );
    const ack = (await db.query<{ id: string; timer_job_id: string }>(
      "SELECT id, timer_job_id FROM ops.acknowledgment", [])).rows[0];
    const escalate = await job(escalateTimerKey(r.runId, 1));
    // §11.2 "cancel timer": the deadline the ack holds is the one that would escalate it.
    expect(ack.timer_job_id).toBe(escalate.id);
    return {
      runId: r.runId, ackId: ack.id, escalateJobId: escalate.id,
      escalateAt: new Date(escalate.due_at), resumeKey: awaitTimerKey(r.runId, 1),
    };
  };

  it("an acknowledgment that comes back closes the ack and escalates nothing", async () => {
    const { ackId, escalateJobId, escalateAt } = await notifyRun();
    await db.query(
      "UPDATE ops.acknowledgment SET state = 'ACKNOWLEDGED', version = version + 1 WHERE id = $1",
      [ackId],
    );
    now = escalateAt;
    expect(await fire(escalateJobId)).toBe("fired");
    expect(await escalations()).toEqual([]);
  });

  it("ten minutes of silence: the ack expires and one exception is raised, exactly once", async () => {
    const { ackId, escalateJobId, escalateAt } = await notifyRun();
    now = escalateAt;
    expect(await fire(escalateJobId)).toBe("fired");

    // The §6.3 edge for an unanswered acknowledgment, taken by the system.
    expect((await db.query<{ state: string }>("SELECT state FROM ops.acknowledgment WHERE id = $1", [ackId])).rows[0])
      .toEqual({ state: "EXPIRED_ESCALATED" });
    const raised = await escalations();
    expect(raised).toHaveLength(1);
    expect([raised[0].category, raised[0].severity]).toEqual(["ACK_OVERDUE", "AMBER"]);
    expect(raised[0].summary).toContain(agentNoReply.ACKNOWLEDGMENT.summary);

    expect(await fireAgain(escalateJobId)).toBe("fired");
    expect(await escalations()).toHaveLength(1);
  });

  it("recording the acknowledgment cancels the escalation and leaves the resume timer alone", async () => {
    const { ackId, escalateJobId, resumeKey } = await notifyRun();
    const ackRun = harness([
      toolCall("record_acknowledgment", {
        ack_id: ackId, status: "CONFIRMED", source_message_id: sc.messageId,
      }),
    ], { scope: { ...sc.scope, tokens: new Set([...sc.scope.tokens, ackId]) } });
    await ackRun.start({ type: "msg.inbound", id: "MSG-ACK-REPLY", siteId: sc.siteId });

    expect((await db.query<{ state: string }>("SELECT state FROM ops.job WHERE id = $1", [escalateJobId])).rows[0])
      .toEqual({ state: "CANCELED" });
    expect((await job(resumeKey)).state).toBe("SCHEDULED");
    // And the canceled wake-up, if it is delivered anyway, does nothing.
    expect(await fire(escalateJobId)).toBe("noop");
    expect(await escalations()).toEqual([]);
  });
});

describe("a dispatcher who does not answer about a vehicle", () => {
  let route: ProviderRoute;

  const capabilityRun = async (): Promise<{ escalateJobId: string; escalateAt: Date }> => {
    sc = await seedAgentScenario(db);
    route = await seedProviderRoute(db, {
      siteId: sc.siteId, serviceDate: sc.serviceDate,
      windowStart: new Date("2026-10-15T13:00:00.000Z"),
      legIds: [sc.legs[sc.children[0]].AM],
      number: DISPATCHER_NUMBER,
    });
    const h = harness([
      toolCall("request_provider_capability", {
        vehicle_token: route.vehicleId, provider_token: route.providerId,
        route_token: route.manifestId, required: ["LIFT_OR_RAMP"],
      }),
    ], {
      scope: { ...sc.scope, shared: new Set([route.vehicleId, route.providerId, route.manifestId]) },
      sendableSubjects: new Set([route.providerId]),
    });
    const r = await h.start({ type: "operational.event", id: "EV-CAP", siteId: sc.siteId });
    expect(r.state).toBe("WAITING_TOOL");
    expect(r.awaiting!.escalateAt).toEqual(
      new Date(now.getTime() + (CAPABILITY_REPLY_SECONDS + NO_REPLY_GRACE_SECONDS) * 1000),
    );
    const escalate = await job(escalateTimerKey(r.runId, 0));
    return { escalateJobId: escalate.id, escalateAt: new Date(escalate.due_at) };
  };

  it("a report that arrives in time escalates nothing", async () => {
    const { escalateJobId, escalateAt } = await capabilityRun();
    await db.query(
      "UPDATE ops.vehicle_capability_day SET state = 'REPORTED', version = version + 1 WHERE id = $1",
      [route.capabilityId],
    );
    now = escalateAt;
    expect(await fire(escalateJobId)).toBe("fired");
    expect(await escalations()).toEqual([]);
  });

  it("silence past the deadline is one CAPABILITY_UNKNOWN exception, pointing at the dispatcher", async () => {
    const { escalateJobId, escalateAt } = await capabilityRun();
    now = escalateAt;
    expect(await fire(escalateJobId)).toBe("fired");

    const raised = await escalations();
    expect(raised).toHaveLength(1);
    expect([raised[0].category, raised[0].severity]).toEqual([CAPABILITY_TASK_CATEGORY, "AMBER"]);
    expect(raised[0].summary).toContain(agentNoReply.CAPABILITY.summary);
    expect(raised[0].next_step).toBe(agentNextSteps.DISPATCHER_PING);
    // The vehicle-day is left exactly as it was: nobody answered, so nothing is known.
    expect((await db.query<{ state: string }>("SELECT state FROM ops.vehicle_capability_day WHERE id = $1", [route.capabilityId])).rows[0])
      .toEqual({ state: "REQUESTED" });

    expect(await fireAgain(escalateJobId)).toBe("fired");
    expect(await escalations()).toHaveLength(1);
  });
});
