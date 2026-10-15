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
import { SITE, freshDb } from "@/test/pglite";
import { handlers } from "@/modules/jobs/handlers";
import { handleWake } from "@/modules/jobs/runner";
import { toolCall } from "../providers/fake";
import { tierPrompt } from "./context";
import { AT01_EXECUTORS, AT01_FACTS, AT01_NOTE, at01Policy, runHarness } from "./harness";
import { resumeQueuedRuns } from "./loop";
import { loadRun, toolCalls } from "./store";
import { AGENT_AWAIT_TASK_CATEGORY, AGENT_RESUME_JOB_KIND, awaitTimerKey } from "./timers";
import type { Trigger } from "./triggers";

const TRIGGER: Trigger = { type: "msg.inbound", id: "MSG-1", siteId: SITE };
/** A second tenant, for the site fence below. */
const OTHER_SITE = "00000000-0000-7000-8000-0000000000ff";

/** §11.2 request_clarification: an outbound into the thread, then a 15-minute await. */
const CLARIFY_ARGS = {
  thread_id: "TH-F1",
  ambiguity_type: "WHICH_CHILD",
  candidate_tokens: ["C1"],
  draft_template_id: "generic.notice",
};
const CLARIFY_SECONDS = 15 * 60;

let pg: PGlite;
let db: Db;
let now: Date;
const open: PGlite[] = [];

beforeEach(async () => {
  ({ pg, db } = await freshDb());
  open.push(pg);
  now = new Date("2026-10-15T12:00:00.000Z");
}, 60_000);

afterEach(async () => {
  await Promise.all(open.splice(0).map((h) => h.close().catch(() => {})));
});

/**
 * The clarification run: one send that asks a question, then one staff note once the answer is in.
 * The send needs no approval — §11.2 marks `request_clarification` `auto` and its copy is a
 * fixed-copy template id, so the policy engine allows it on the agent's own authority (VERI-2).
 * What a *free-text* send would do instead — propose, await nothing — is `free-text-approval.test.ts`.
 */
const clarifyHarness = () =>
  runHarness({
    db,
    script: [toolCall("request_clarification", CLARIFY_ARGS), AT01_NOTE],
    facts: AT01_FACTS,
    policy: at01Policy(),
    overrides: {
      request_clarification: async () => ({
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
  (await db.query<{ category: string; severity: string; state: string; summary: string; completion_predicate: string; sla_due_at: Date }>(
    "SELECT category, severity, state, summary, completion_predicate, sla_due_at FROM ops.task ORDER BY created_at", [])).rows;

describe("§11.1 an awaited response is a task plus a timer", () => {
  it("parks the run: the call commits, the task and the timer exist, and the run is WAITING_TOOL", async () => {
    const h = clarifyHarness();
    const r = await h.start(TRIGGER);

    expect([r.state, r.steps]).toEqual(["WAITING_TOOL", 1]);
    const key = awaitTimerKey(r.runId, 0);
    expect(r.awaiting).toMatchObject({ jobKey: key, dueAt: new Date(now.getTime() + CLARIFY_SECONDS * 1000) });

    // The call itself committed — a parked run is a run whose last step finished.
    const [call] = await toolCalls(db, r.runId);
    expect([call.tool, call.status]).toEqual(["request_clarification", "EXECUTED"]);
    expect(call.result).toMatchObject({ would_send: "generic.notice", prompt_facts: { clarification_asked: true } });

    // The timer (B-03), with the run on its payload.
    const timer = await job(key);
    expect([timer.kind, timer.state]).toEqual([AGENT_RESUME_JOB_KIND, "SCHEDULED"]);
    expect(timer.payload.runId).toBe(r.runId);
    expect(new Date(timer.due_at).toISOString()).toBe(r.awaiting!.dueAt.toISOString());
    // …and its wake-up was published after the transaction committed, at a whole-second delay.
    expect(h.transport.sent).toEqual([expect.objectContaining({ jobId: timer.id, delaySeconds: CLARIFY_SECONDS })]);

    // The staff-visible wait (§11.1: a task, not a session).
    expect(await tasks()).toEqual([
      expect.objectContaining({
        category: AGENT_AWAIT_TASK_CATEGORY,
        severity: "GREEN",
        state: "OPEN",
        completion_predicate: "guardian reply resolves WHICH_CHILD",
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
    expect(await handleWake(db, { jobId: timer.id }, "d1", handlers, () => now)).toBe("fired");
    expect((await job(awaitTimerKey(r.runId, 0))).state).toBe("DONE");
    // The handler is DB-only: all it did was re-trigger the run.
    expect((await loadRun(db, r.runId))!.state).toBe("QUEUED");

    const resumed = await resumeQueuedRuns(h.deps(1), SITE);
    expect(resumed.map((x) => [x.runId, x.state, x.steps])).toEqual([[r.runId, "SUCCEEDED", 1]]);

    const calls = await toolCalls(db, r.runId);
    expect(calls.map((c) => [c.seq, c.tool, c.status])).toEqual([
      [0, "request_clarification", "EXECUTED"],
      [1, "summarize_thread_for_staff", "EXECUTED"],
    ]);
    // The awaited call ran once, and the resumed turn saw its result.
    expect(h.recorder.intents.map((i) => i.tool)).toEqual(["request_clarification", "summarize_thread_for_staff"]);
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
    expect(await handleWake(db, { jobId: timer.id }, "d1", handlers, () => now)).toBe("fired");

    // The job is done — a wake-up for work this handler may not do is a no-op and an ack, the same
    // answer every other B-03 handler gives — and the parked run was not touched.
    expect((await job(key)).state).toBe("DONE");
    expect((await loadRun(db, r.runId))!.state).toBe("WAITING_TOOL");
    expect(await toolCalls(db, r.runId)).toHaveLength(1);
  });

  it("the timer is a no-op for a run that is no longer waiting", async () => {
    const h = clarifyHarness();
    const r = await h.start(TRIGGER);
    const timer = await job(awaitTimerKey(r.runId, 0));
    // The awaited reply arrived as its own trigger and that run finished this one's work.
    await db.query("UPDATE ops.agent_run SET state = 'SUCCEEDED' WHERE id = $1", [r.runId]);

    now = new Date(timer.due_at);
    expect(await handleWake(db, { jobId: timer.id }, "d1", handlers, () => now)).toBe("fired");
    expect((await loadRun(db, r.runId))!.state).toBe("SUCCEEDED");
    expect(await toolCalls(db, r.runId)).toHaveLength(1);
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
