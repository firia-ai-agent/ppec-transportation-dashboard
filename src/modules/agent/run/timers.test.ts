/**
 * §11.1 "delayed external responses are tasks with timers, never waiting sessions", end to end:
 * the run parks itself on a B-03 timer, the timer fires through the ordinary job claim, and the run
 * resumes from its committed result.
 *
 * The timezone assertions live here too, because this is where the two kinds of time meet. A
 * deadline is an **instant** — `now + afterSeconds`, which must survive a DST boundary and must not
 * depend on the timezone the serverless instance booted in — while the service date in the prompt
 * is a **calendar date in the site's zone** (PRD §6.1). The suite runs under TZ=UTC and
 * TZ=America/New_York, and the two cases below are chosen so that a value computed in process-local
 * time fails one of the two runs.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { Db } from "@/db/exec";
import { TEST_NOW } from "@/test/clock";
import { SITE, freshDb } from "@/test/pglite";
import { handlers } from "@/modules/jobs/handlers";
import { type Handlers, handleWake } from "@/modules/jobs/runner";
import { agentWaits, fill } from "@/ui/copy";
import { toolCall } from "../providers/fake";
import { tierPrompt } from "./context";
import { CLARIFICATION_AWAIT_SECONDS } from "./exec/clarify";
import { AT01_EXECUTORS, AT01_FACTS, AT01_NOTE, at01Policy, runHarness } from "./harness";
import { resumeQueuedRuns } from "./loop";
import { type AgentWake, type AgentWakeTransport, handleAgentWake, runWakeKey } from "./queue";
import { loadRun, toolCalls } from "./store";
import { AGENT_AWAIT_TASK_CATEGORY, AGENT_RESUME_JOB_KIND, agentResumeHandler, awaitTimerKey } from "./timers";
import type { Trigger } from "./triggers";

const TRIGGER: Trigger = { type: "msg.inbound", id: "MSG-1", siteId: SITE };
/** A second tenant, for the site fence below. */
const OTHER_SITE = "00000000-0000-7000-8000-0000000000ff";

/**
 * §11.2 `notify_affected_therapist`: a fixed-copy alert, then an await on the answer.
 *
 * It used to be `request_clarification`, which Firia's S1-7 ruling (2026-10-18) moved to the
 * `human` tier — so the loop no longer calls an executor for it at all and it can no longer park
 * anything. The timer machinery is unchanged and still has live producers; this is one of them
 * (`exec/therapist.ts`), and it is the one this fixture's scope already reaches.
 */
const AWAIT_ARGS = {
  therapy_session_token: "SESS-C1",
  child_token: "C1",
  impact: "LATE",
  eta: "09:30",
};
const AWAIT_TOOL = "notify_affected_therapist";
/** §11.2 "→ outbound + 15-min await" (`exec/clarify.CLARIFICATION_AWAIT_SECONDS`). */
const CLARIFY_SECONDS = CLARIFICATION_AWAIT_SECONDS;

/** What the `ppec-agent` topic is handed, in order (`queue.ts AgentWakeTransport`). */
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
/** The run wake-ups the resume handler published, per test. */
let agentQueue: FakeAgentTransport;
/**
 * The production registry with one substitution: the resume handler over a fake `ppec-agent`
 * transport instead of the Vercel one (`jobs/handlers.ts` wires the real one). Everything else —
 * the claim, the lease, the fence, the DONE update — is the real consumer.
 */
let timerHandlers: Handlers;
const open: PGlite[] = [];

beforeEach(async () => {
  ({ pg, db } = await freshDb());
  open.push(pg);
  now = new Date(TEST_NOW);
  agentQueue = new FakeAgentTransport();
  timerHandlers = { ...handlers, [AGENT_RESUME_JOB_KIND]: agentResumeHandler(agentQueue) };
}, 60_000);

afterEach(async () => {
  await Promise.all(open.splice(0).map((h) => h.close().catch(() => {})));
});

/**
 * The awaiting run: one send that asks for an answer, then one staff note once it is in.
 * The send needs no approval — §11.2 marks `notify_affected_therapist` `auto` and its copy is
 * rendered downstream from structured fields, so the policy engine allows it on the agent's own
 * authority (VERI-2). A send that would carry the model's own words proposes instead and awaits
 * nothing (`free-text-approval.test.ts`); so, since S1-7, does any message to a FAMILY
 * (`exec/clarify.test.ts`).
 */
const clarifyHarness = () =>
  runHarness({
    db,
    script: [toolCall(AWAIT_TOOL, AWAIT_ARGS), AT01_NOTE],
    facts: AT01_FACTS,
    policy: at01Policy(),
    overrides: {
      [AWAIT_TOOL]: async () => ({
        data: { would_send: "generic.notice" },
        promptFacts: { clarification_asked: true },
        awaitExternal: {
          reasonCode: "CLARIFICATION",
          afterSeconds: CLARIFY_SECONDS,
          summary: "Waiting for the guardian to say which child",
          completionPredicate: "guardian reply resolves WHICH_CHILD",
        },
      }),
      summarize_thread_for_staff: AT01_EXECUTORS.summarize_thread_for_staff,
    },
    now: () => now,
  });

const job = async (key: string) =>
  (await db.query<{ id: string; kind: string; state: string; due_at: Date; payload: { runId: string; seq: number; taskId: string } }>(
    "SELECT id, kind, state, due_at, payload FROM ops.job WHERE key = $1", [key])).rows[0];
const tasks = async () =>
  (await db.query<{ category: string; severity: string; state: string; summary: string; next_step: string; completion_predicate: string; sla_due_at: Date }>(
    "SELECT category, severity, state, summary, next_step, completion_predicate, sla_due_at FROM ops.task ORDER BY created_at", [])).rows;

describe("§11.1 an awaited response is a task plus a timer", () => {
  it("parks the run: the call commits, the task and the timer exist, and the run is WAITING_TOOL", async () => {
    const h = clarifyHarness();
    const r = await h.start(TRIGGER);

    expect([r.state, r.steps]).toEqual(["WAITING_TOOL", 1]);
    const key = awaitTimerKey(r.runId, 0);
    expect(r.awaiting).toMatchObject({ jobKey: key, dueAt: new Date(now.getTime() + CLARIFY_SECONDS * 1000) });

    // The call itself committed — a parked run is a run whose last step finished.
    const [call] = await toolCalls(db, r.runId);
    expect([call.tool, call.status]).toEqual([AWAIT_TOOL, "EXECUTED"]);
    expect(call.result).toMatchObject({ would_send: "generic.notice", prompt_facts: { clarification_asked: true } });

    // The timer (B-03), with the run on its payload.
    const timer = await job(key);
    expect([timer.kind, timer.state]).toEqual([AGENT_RESUME_JOB_KIND, "SCHEDULED"]);
    expect(timer.payload.runId).toBe(r.runId);
    expect(new Date(timer.due_at).toISOString()).toBe(r.awaiting!.dueAt.toISOString());
    // …and its wake-up was published after the transaction committed, at a whole-second delay.
    expect(h.transport.sent).toEqual([expect.objectContaining({ jobId: timer.id, delaySeconds: CLARIFY_SECONDS })]);

    // The staff-visible wait (§11.1: a task, not a session), in the words of src/ui/copy.ts —
    // this module chooses which await reason and which step, never the sentence (F10).
    expect(await tasks()).toEqual([
      expect.objectContaining({
        category: AGENT_AWAIT_TASK_CATEGORY,
        severity: "GREEN",
        state: "OPEN",
        completion_predicate: "guardian reply resolves WHICH_CHILD",
        next_step: agentWaits.nextStep,
        summary: fill(agentWaits.locator, {
          summary: "Waiting for the guardian to say which child",
          trigger: "msg.inbound:MSG-1",
          step: 0,
        }),
      }),
    ]);
    expect((await tasks())[0].summary).toContain("msg.inbound:MSG-1");
    expect(new Date((await tasks())[0].sla_due_at).toISOString()).toBe(r.awaiting!.dueAt.toISOString());
    expect(timer.payload.taskId).toBeTruthy();
  });

  it("a parked run is not resumable until its timer fires", async () => {
    const h = clarifyHarness();
    const r = await h.start(TRIGGER);
    const again = await h.drive(r.runId);

    expect([again.state, again.steps, again.reason]).toEqual(["WAITING_TOOL", 0, "run is parked on a timer"]);
    // No model turn was taken on that attempt, and no second call was written.
    expect(h.gateways.at(-1)!.auditLog).toEqual([]);
    expect(await toolCalls(db, r.runId)).toHaveLength(1);
  });

  it("the timer firing re-triggers the run, which resumes from the committed result", async () => {
    const h = clarifyHarness();
    const r = await h.start(TRIGGER);
    const timer = await job(awaitTimerKey(r.runId, 0));

    // The deadline arrives and the ordinary B-03 consumer fires it.
    now = new Date(timer.due_at);
    expect(await handleWake(db, { jobId: timer.id }, "d1", timerHandlers, () => now)).toBe("fired");
    expect((await job(awaitTimerKey(r.runId, 0))).state).toBe("DONE");
    // The handler's *transaction* is DB-only: all it wrote was the run's state.
    expect((await loadRun(db, r.runId))!.state).toBe("QUEUED");
    // And after that transaction committed, one wake-up for that run (the driver's half is the
    // test below; this one drives the batch way, which is what a sweep would do).
    expect(agentQueue.sent).toEqual([
      { msg: { runId: r.runId, siteId: SITE }, idempotencyKey: runWakeKey(r.runId) },
    ]);

    const resumed = await resumeQueuedRuns(h.deps(1), SITE);
    expect(resumed.map((x) => [x.runId, x.state, x.steps])).toEqual([[r.runId, "SUCCEEDED", 1]]);

    const calls = await toolCalls(db, r.runId);
    expect(calls.map((c) => [c.seq, c.tool, c.status])).toEqual([
      [0, AWAIT_TOOL, "EXECUTED"],
      [1, "summarize_thread_for_staff", "EXECUTED"],
    ]);
    // The awaited call ran once, and the resumed turn saw its result.
    expect(h.recorder.intents.map((i) => i.tool)).toEqual([AWAIT_TOOL, "summarize_thread_for_staff"]);
    expect(h.gateways.at(-1)!.auditLog.map((a) => a.tool)).toEqual(["summarize_thread_for_staff"]);
  });

  /**
   * PR #35 review, F3. The run id travels in the job payload, and a payload is not an
   * authorization: `agentResumeHandler` re-queues a run only in the site its own job row belongs
   * to. Remove `AND site_id = $3` from timers.ts and this test fails — a timer scheduled in one
   * tenant re-queues another tenant's parked run, which is then driven by whoever polls that site.
   */
  it("a timer whose job belongs to another site re-queues nothing", async () => {
    const h = clarifyHarness();
    const r = await h.start(TRIGGER);
    const key = awaitTimerKey(r.runId, 0);
    const timer = await job(key);

    // The same payload, moved to another site's job row — a copied fixture, a hand-run replay, or
    // a forged wake-up. The site has to exist for the foreign key, and the run stays in ours.
    await db.query(
      `INSERT INTO ops.site (id, org_id, name, depot_lat, depot_lng, created_by, updated_by)
       SELECT $1, org_id, 'SYN Other Site', depot_lat, depot_lng, 'test', 'test' FROM ops.site WHERE id = $2`,
      [OTHER_SITE, SITE],
    );
    await db.query("UPDATE ops.job SET site_id = $2 WHERE id = $1", [timer.id, OTHER_SITE]);

    now = new Date(timer.due_at);
    expect(await handleWake(db, { jobId: timer.id }, "d1", timerHandlers, () => now)).toBe("fired");

    // The job is done — a wake-up for work this handler may not do is a no-op and an ack, the same
    // answer every other B-03 handler gives — and the parked run was not touched.
    expect((await job(key)).state).toBe("DONE");
    expect((await loadRun(db, r.runId))!.state).toBe("WAITING_TOOL");
    expect(await toolCalls(db, r.runId)).toHaveLength(1);
    // Nothing was published either: the publish is conditional on the UPDATE having matched, so a
    // wake-up this handler may not raise is not raised for some other driver to act on.
    expect(agentQueue.sent).toEqual([]);
  });

  it("the timer is a no-op for a run that is no longer waiting", async () => {
    const h = clarifyHarness();
    const r = await h.start(TRIGGER);
    const timer = await job(awaitTimerKey(r.runId, 0));
    // The awaited reply arrived as its own trigger and that run finished this one's work.
    await db.query("UPDATE ops.agent_run SET state = 'SUCCEEDED' WHERE id = $1", [r.runId]);

    now = new Date(timer.due_at);
    expect(await handleWake(db, { jobId: timer.id }, "d1", timerHandlers, () => now)).toBe("fired");
    expect((await loadRun(db, r.runId))!.state).toBe("SUCCEEDED");
    expect(await toolCalls(db, r.runId)).toHaveLength(1);
    // A no-op fire publishes nothing: there is no re-queued run for a wake-up to be about.
    expect(agentQueue.sent).toEqual([]);
  });

  /**
   * THE 15-MINUTE CLARIFICATION WAIT, END TO END, WITH NOBODY POLLING ANYTHING.
   *
   * This is the gap this change closes. The run parks on §11.2's "→ outbound + 15-min await"
   * (`CLARIFICATION_AWAIT_SECONDS`), the deadline fires through the ordinary B-03 consumer, and
   * what drives the re-queued run is the **wake-up the handler published** — delivered to
   * `handleAgentWake`, the same consumer `/api/queues/agent` is, under the same per-run lease.
   * `resumeQueuedRuns` is deliberately not called anywhere in here: before this change it was the
   * only thing that would have finished this run, and production called it from nowhere, so a
   * family's clarification sat QUEUED forever with no exception raised.
   *
   * The await is declared by `notify_affected_therapist` rather than by `request_clarification`
   * itself: Firia's S1-7 ruling (2026-10-18) moved that tool to the `human` tier, so the loop
   * proposes it and never calls an executor for it, and it can no longer park anything. The wait
   * under test is the clarification wait all the same — same reason code, same 15 minutes, same
   * timer — and `exec/clarify.ts` is where the seconds come from.
   */
  it("the 15-minute clarification wait resumes and finishes on the wake-up the timer published", async () => {
    const h = clarifyHarness();
    const r = await h.start(TRIGGER);
    expect([r.state, r.awaiting!.dueAt.toISOString()]).toEqual([
      "WAITING_TOOL",
      new Date(now.getTime() + 15 * 60 * 1000).toISOString(),
    ]);

    // 15 minutes later the deadline fires. Nothing else happens in between.
    now = new Date(now.getTime() + CLARIFICATION_AWAIT_SECONDS * 1000);
    const timer = await job(awaitTimerKey(r.runId, 0));
    expect(await handleWake(db, { jobId: timer.id }, "d1", timerHandlers, () => now)).toBe("fired");

    // One wake-up, for this run, in this tenant, keyed exactly as the inbound path keys its own —
    // so a resume and an inbound trigger for the same run collapse instead of making two drivers.
    expect(agentQueue.sent).toEqual([
      { msg: { runId: r.runId, siteId: SITE }, idempotencyKey: runWakeKey(r.runId) },
    ]);

    // Delivered: the run is claimed, driven and finished, with no polling driver anywhere.
    const driven = await handleAgentWake(db, agentQueue.sent[0].msg, { deps: h.deps(1) });
    expect(driven).toMatchObject({ ok: true, runId: r.runId, reclaimed: false });
    if (!driven.ok) throw new Error("unreachable");
    expect([driven.result.state, driven.result.steps]).toEqual(["SUCCEEDED", 1]);

    expect((await loadRun(db, r.runId))!.state).toBe("SUCCEEDED");
    expect((await toolCalls(db, r.runId)).map((c) => [c.seq, c.tool, c.status])).toEqual([
      [0, AWAIT_TOOL, "EXECUTED"],
      [1, "summarize_thread_for_staff", "EXECUTED"],
    ]);
    // The awaited call ran once and the resumed turn saw its committed result (§11.1).
    expect(h.recorder.intents.map((i) => i.tool)).toEqual([AWAIT_TOOL, "summarize_thread_for_staff"]);
    // The staff task the wait raised is still the only one: resuming raised nothing new.
    expect((await tasks()).map((t) => t.category)).toEqual([AGENT_AWAIT_TASK_CATEGORY]);
  });

  /**
   * A publish that fails is the residual this change does not remove, and it is left where it was:
   * the run is QUEUED and drivable, which is exactly where the handler used to leave *every* fired
   * deadline. The hook runner swallows it (`db/exec.runAfterCommit`), so the job is still DONE
   * rather than retried against a state change that already happened.
   */
  it("a wake-up that could not be published still leaves the run re-queued, and the job done", async () => {
    const h = clarifyHarness();
    const r = await h.start(TRIGGER);
    const timer = await job(awaitTimerKey(r.runId, 0));
    agentQueue.failNext = 1;

    now = new Date(timer.due_at);
    expect(await handleWake(db, { jobId: timer.id }, "d1", timerHandlers, () => now)).toBe("fired");

    expect(agentQueue.sent).toEqual([]);
    expect((await job(awaitTimerKey(r.runId, 0))).state).toBe("DONE");
    expect((await loadRun(db, r.runId))!.state).toBe("QUEUED");
  });
});

describe("timezones: deadlines are instants, service dates are site-local", () => {
  it("the service date in the prompt is the site's calendar date, not the process's", async () => {
    // 2026-03-08T04:30Z is 23:30 on 2026-03-07 in America/New_York: the site's service date is
    // the 7th, and a prompt built in UTC local time would say the 8th.
    now = new Date("2026-03-08T04:30:00.000Z");
    const h = runHarness({
      db, script: [AT01_NOTE], facts: AT01_FACTS, policy: at01Policy(),
      overrides: AT01_EXECUTORS, now: () => now,
    });
    const r = await h.start(TRIGGER);
    expect(r.state).toBe("SUCCEEDED");

    const prompt = tierPrompt(AT01_FACTS, { runId: r.runId, trigger: TRIGGER, committed: [], now });
    expect(prompt).toContain("service_date=2026-03-07 tz=America/New_York");
    // And that is the prompt the run actually sent (hashes only, as always).
    expect(h.gateways.at(-1)!.auditLog.map((a) => a.promptHash)).toEqual([
      h.gateways.at(-1)!.validatePromptTokensOnly(prompt),
    ]);
  });

  it("an await across the spring-forward boundary is 15 minutes of real time, in either timezone", async () => {
    // 01:55 EST on the morning the clocks jump: +15 min is 03:10 EDT, which is 07:10Z. Local-time
    // arithmetic would land an hour out in one of the two timezones this suite runs under.
    now = new Date("2026-03-08T06:55:00.000Z");
    const h = clarifyHarness();
    const r = await h.start(TRIGGER);

    expect(r.state).toBe("WAITING_TOOL");
    expect(r.awaiting!.dueAt.toISOString()).toBe("2026-03-08T07:10:00.000Z");
    const timer = await job(awaitTimerKey(r.runId, 0));
    expect(new Date(timer.due_at).toISOString()).toBe("2026-03-08T07:10:00.000Z");
    expect(h.transport.sent.map((m) => m.delaySeconds)).toEqual([CLARIFY_SECONDS]);
    expect(new Date((await tasks())[0].sla_due_at).toISOString()).toBe("2026-03-08T07:10:00.000Z");
  });
});
