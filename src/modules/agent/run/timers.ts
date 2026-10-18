/**
 * §11.1: "delayed external responses are tasks with timers, never waiting sessions."
 *
 * A run that has asked a human or a provider something does not sit in a function waiting for the
 * answer — serverless has nowhere to sit, and a held session is the thing that loses work on a
 * restart. Instead the run ends: it writes an `ops.task` row (so the wait is visible to staff and
 * closable by them), schedules a **B-03 timer** on `ops.job` for the deadline, and goes
 * WAITING_TOOL. The timer firing is what re-triggers it.
 *
 * All four of those happen in **one transaction**, so there is no state in which the run waits on
 * a timer that does not exist, or a timer exists for a run that is not waiting. The wake-up itself
 * is published after commit by `JobScheduler.schedule` (ADR-001), and if that publish is lost the
 * every-minute sweeper re-arms the row — the agent inherits the timer guarantees instead of
 * restating them.
 *
 * The handler is deliberately tiny. A B-03 handler's *transaction* is DB-only (ADR-001/ADR-003:
 * external effects go through the outbox) and it runs inside the job's claim transaction, while a
 * run step needs its own transaction per tool call (that is the whole of persist-before-execute).
 * So the handler does the one DB-only thing that re-triggers a run — move it WAITING_TOOL → QUEUED
 * — and then, **after that transaction commits**, publishes the one message that gets it driven:
 * the same `ppec-agent` wake-up the inbound path publishes (`queue.ts enqueueRun`), delivered to
 * the same consumer, taken under the same per-run lease (`driveRunLeased`, lease.ts).
 *
 * The queue slice built that driver (`/api/queues/agent`) and deliberately did **not** wire this
 * handler to it, because a handler had no after-commit hook to publish from and publishing inside
 * the claim transaction is the thing ADR-003 forbids. It left the run QUEUED and named a periodic
 * sweep of `agent_run_resume_idx` as the delivery mechanism (docs/agent/B08-SLICE1-DEFERRED.md,
 * "What the queue slice did not bring") — and that sweep was never built, so a fired deadline
 * re-queued a run that nothing then drove. `fire` now hands every handler the claim transaction's
 * own `afterCommit` (jobs/runner.ts), which is the hook that was missing; see
 * `agentResumeHandler` for why after-commit is the only correct moment for it.
 */
import { z } from "zod";
import type { Exec } from "@/db/exec";
import type { Handler } from "@/modules/jobs/runner";
import type { JobScheduler } from "@/modules/jobs/scheduler";
import { agentWaits, fill } from "@/ui/copy";
import { uuidv7 } from "uuidv7";
import { effectId } from "./exec/effects";
import {
  AGENT_ESCALATE_JOB_KIND,
  type EscalatePayload,
  escalateTimerKey,
} from "./exec/escalate";
import type { AwaitExternal } from "./executors";
import { type AgentWakeTransport, runWakeKey } from "./wake";
import { type RunRow, type ToolCallRow, commitCall, runActor, setRunState } from "./store";
import { triggerLabel } from "./triggers";

/** The `ops.job.kind` that re-triggers a parked run. Registered in `src/modules/jobs/handlers.ts`. */
export const AGENT_RESUME_JOB_KIND = "agent.run.resume";

/** `ops.task.category` for a run parked on an external response. */
export const AGENT_AWAIT_TASK_CATEGORY = "AGENT_AWAIT_EXTERNAL";

/**
 * The live job key for one awaited call. Keyed by (run, seq) rather than by run alone, so two
 * awaits in one run are two timers and `job_key_live_uq` still rejects a duplicate of either.
 */
export function awaitTimerKey(runId: string, seq: number): string {
  return `${AGENT_RESUME_JOB_KIND}:${runId}:${seq}`;
}

export const resumePayloadSchema = z.object({
  runId: z.string().uuid(),
  seq: z.number().int().nonnegative(),
  taskId: z.string().uuid(),
});
export type ResumePayload = z.infer<typeof resumePayloadSchema>;

export type ParkedAwait = {
  readonly jobKey: string;
  readonly jobId: string;
  readonly taskId: string;
  readonly dueAt: Date;
  /** The §11.2 "no reply → escalate" deadline, when this await declared one. */
  readonly escalateJobKey?: string;
  readonly escalateJobId?: string;
  readonly escalateAt?: Date;
  readonly escalationTaskId?: string;
};

/**
 * Commit the awaiting call, raise the staff task, arm the timer(s) and park the run — in the
 * caller's transaction, which must be the one that commits the tool call, so none of it can come
 * apart.
 *
 * `severity` is GREEN: a run waiting for an answer it asked for on time is not an exception. The
 * exception is a **second** job, `agent.await.escalate`, armed here when the await declares one
 * (§11.2 "no reply → escalate"): it fires a grace period past the first deadline, reads the one row
 * that would show an answer, and raises the AMBER exception if there is none — with no model turn
 * in the path (`exec/escalate.ts`). The wait itself stays the GREEN wait it is; the escalation is
 * its own row, because that is what §11.2's failure column asks for and what a coordinator acts on.
 *
 * An await that names an `ops.acknowledgment` has that row's `timer_job_id` stamped with the
 * **escalation** job, not the resume one: "cancel timer" when an ack comes back (§11.2
 * `record_acknowledgment`) has to cancel the thing that would have escalated it, and must not
 * cancel the wake-up that un-parks the run.
 */
export async function parkRunOnTimer(
  tx: Exec,
  afterCommit: (hook: () => Promise<void>) => void,
  scheduler: JobScheduler,
  args: {
    run: RunRow;
    call: ToolCallRow;
    await: AwaitExternal;
    result: Record<string, unknown> | null;
    now: Date;
  },
): Promise<ParkedAwait> {
  const by = runActor(args.run.id);
  const dueAt = new Date(args.now.getTime() + args.await.afterSeconds * 1000);
  const taskId = uuidv7();

  const committed = await commitCall(tx, args.call.id, "EXECUTED", args.result, by);
  if (!committed) throw new Error(`tool call ${args.call.id} was not PENDING; refusing to park the run on a timer`);

  await tx.query(
    `INSERT INTO ops.task (id, site_id, category, severity, state, summary, next_step, completion_predicate, sla_due_at, created_by, updated_by, source_mode)
     VALUES ($1, $2, $3, 'GREEN', 'OPEN', $4, $5, $6, $7, $8, $8, 'SIMULATED')`,
    [
      taskId, args.run.siteId, AGENT_AWAIT_TASK_CATEGORY,
      // The staff-visible words are `src/ui/copy.ts`; what this module decides is which await
      // reason the summary names and which step it points at (PR #35 review, F10).
      fill(agentWaits.locator, {
        summary: args.await.summary,
        trigger: triggerLabel(args.run.trigger),
        step: args.call.seq,
      }),
      agentWaits.nextStep,
      args.await.completionPredicate,
      dueAt.toISOString(), by,
    ],
  );

  const job = await scheduler.schedule(tx, afterCommit, {
    siteId: args.run.siteId,
    key: awaitTimerKey(args.run.id, args.call.seq),
    kind: AGENT_RESUME_JOB_KIND,
    payload: { runId: args.run.id, seq: args.call.seq, taskId } satisfies ResumePayload,
    dueAt,
    by,
  });

  const escalation = args.await.escalation
    ? await armEscalation(tx, afterCommit, scheduler, { ...args, taskId, by })
    : null;

  // The run row's own writes carry the driver's actor (`DriveOpts.actor` — the lease's claim token
  // when the queue route is driving, `runActor` otherwise), while the task and the jobs beside it
  // are the run's and carry `by`. Parking is also how a lease ends on the §11.1 wait: the row
  // leaves RUNNING, so the claim it was holding is no longer a claim on anything (run/lease.ts).
  const parked = await setRunState(tx, args.run.id, "RUNNING", "WAITING_TOOL", args.run.updatedBy);
  if (!parked) throw new Error(`run ${args.run.id} was not RUNNING; refusing to park it on a timer`);

  return {
    jobKey: awaitTimerKey(args.run.id, args.call.seq),
    jobId: job.id,
    taskId,
    dueAt,
    ...(escalation ?? {}),
  };
}

/**
 * The §11.2 "no reply → escalate" job, and the acknowledgment deadline that rides on it.
 *
 * Everything the handler will need is on the payload, because a B-03 handler has no memory of the
 * run that scheduled it: which row to read, which category and severity to raise, and the task id
 * to raise it under — derived from the awaited call's idempotency key, so a replayed wake-up
 * writes nothing.
 */
async function armEscalation(
  tx: Exec,
  afterCommit: (hook: () => Promise<void>) => void,
  scheduler: JobScheduler,
  args: {
    run: RunRow;
    call: ToolCallRow;
    await: AwaitExternal;
    now: Date;
    taskId: string;
    by: string;
  },
): Promise<{ escalateJobKey: string; escalateJobId: string; escalateAt: Date; escalationTaskId: string }> {
  const escalation = args.await.escalation!;
  const escalateAt = new Date(args.now.getTime() + escalation.afterSeconds * 1000);
  const escalationTaskId = effectId(args.call.idempotencyKey, "no-reply-escalation");
  const key = escalateTimerKey(args.run.id, args.call.seq);

  const job = await scheduler.schedule(tx, afterCommit, {
    siteId: args.run.siteId,
    key,
    kind: AGENT_ESCALATE_JOB_KIND,
    payload: {
      runId: args.run.id,
      seq: args.call.seq,
      taskId: args.taskId,
      escalationTaskId,
      reason: escalation.reason,
      category: escalation.category,
      severity: escalation.severity,
      nextStepCode: escalation.nextStepCode,
      since: args.now.toISOString(),
      watch: escalation.watch,
    } satisfies EscalatePayload,
    dueAt: escalateAt,
    by: args.by,
  });

  if (args.await.acknowledgmentId) {
    // Only while it is unset: an ack that already has a deadline keeps the one it was raised with.
    await tx.query(
      `UPDATE ops.acknowledgment SET timer_job_id = $1, version = version + 1, updated_at = now(), updated_by = $2
       WHERE id = $3 AND site_id = $4 AND timer_job_id IS NULL`,
      [job.id, args.by, args.await.acknowledgmentId, args.run.siteId],
    );
  }

  return { escalateJobKey: key, escalateJobId: job.id, escalateAt, escalationTaskId };
}

/**
 * The B-03 handler for `agent.run.resume`: move the parked run back to QUEUED **and publish the
 * wake-up that drives it**.
 *
 * The state change is DB-only and idempotent, as it always was. A run that is not WAITING_TOOL any
 * more — because the awaited reply arrived as its own `msg.inbound` trigger and something else
 * already finished this run, or because a human took it over — matches zero rows and the timer
 * fires as a no-op, which is the same answer every other B-03 handler gives to a wake-up for work
 * that is already done. Nothing is published for a no-op either: the `RETURNING id` is what the
 * publish is conditional on, so a wake-up exists only for a run this fire actually re-queued.
 *
 * `AND site_id = $3` is the tenant fence (PR #35 review, F3). The run id travels in a job payload,
 * and a payload is not an authorization: the id could be wrong by accident (a hand-written replay,
 * a copied fixture) or on purpose, and a wake-up that could re-queue *any* run by id would be a
 * cross-tenant write with a timer in front of it. The job row carries the site it was scheduled
 * for, so the fence costs one predicate — and a mismatch matches zero rows, which is the same
 * no-op as every other wake-up for work this handler may not do. The published message carries
 * that same `job.site_id`, never the run row's, so the consumer's claim is fenced on what this
 * handler was authorized for (queue.ts `AgentWake`).
 *
 * ## Why this publishes at all now
 *
 * The queue slice deliberately did not wire the two together, and the reason it gave was a real
 * one: a B-03 handler runs inside the job's claim transaction and had no after-commit hook to
 * publish from, so publishing was either an external effect inside a transaction (ADR-003's rule,
 * and a wake-up a rollback cannot take back) or nothing. It left "a fired deadline leaves the run
 * QUEUED and visible" and named the periodic sweep of `agent_run_resume_idx` as the thing that
 * would deliver it — and that sweep was never built. `resumeQueuedRuns` (loop.ts) exists but
 * production calls it from nowhere, so in the deployed app a 15-minute clarification wait came due,
 * the run went QUEUED, and **nothing ever drove it**: the family's question sat unanswered with no
 * exception raised, because a GREEN wait that re-queued itself is not an exception to anybody.
 *
 * What changed is the hook, not the rule: `fire` now hands every handler the transaction's own
 * `afterCommit` (jobs/runner.ts), so the wake-up goes out **after** the claim transaction commits,
 * which is the same ordering `JobScheduler.schedule` and the outbox already use. A publish before
 * the commit would be the genuinely broken version — the consumer would take the lease, find the
 * run still WAITING_TOOL, refuse it `parked` and ack, and the one wake-up would be spent on a row
 * that had not moved yet.
 *
 * It is the **same** message the inbound path publishes — `{runId, siteId}` under
 * `runWakeKey(runId)` (queue.ts `enqueueRun`) — so there is one consumer, one lease and one driver
 * for a run however it came to be drivable, and a resume wake-up that races an inbound one for the
 * same run collapses on the queue's own idempotency key instead of becoming two drivers.
 *
 * A failed publish is swallowed by the hook runner (`db/exec.runAfterCommit`) and leaves the run
 * QUEUED, which is exactly where this handler used to leave it — strictly better than before, and
 * still the honest residual: nothing on the agent topic re-arms a QUEUED run nobody was told about
 * (queue.ts). The await's own escalation timer, when it declared one, is what puts a silent wait in
 * front of a person (§11.2 "no reply → escalate", `exec/escalate.ts`).
 */
export function agentResumeHandler(transport: AgentWakeTransport): Handler {
  return async (tx, job, afterCommit) => {
    const payload = resumePayloadSchema.parse(job.payload);
    const requeued = await tx.query<{ id: string }>(
      `UPDATE ops.agent_run SET state = 'QUEUED', version = version + 1, updated_at = now(), updated_by = $2
       WHERE id = $1 AND state = 'WAITING_TOOL' AND site_id = $3 RETURNING id`,
      [payload.runId, `system:job:${AGENT_RESUME_JOB_KIND}`, job.site_id],
    );
    if (requeued.rows.length === 0) return;
    afterCommit(() =>
      transport.publish(
        { runId: payload.runId, siteId: job.site_id },
        { idempotencyKey: runWakeKey(payload.runId) },
      ),
    );
  };
}
