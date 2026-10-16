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
 * The handler is deliberately tiny. A B-03 handler is DB-only (ADR-001/ADR-003: external effects
 * go through the outbox) and runs inside the job's claim transaction, while a run step needs its
 * own transaction per tool call (that is the whole of persist-before-execute). So the handler does
 * the one DB-only thing that re-triggers a run — move it WAITING_TOOL → QUEUED — and the agent
 * runner picks it up (`resumeQueuedRuns`, loop.ts). Wiring that runner to its own queue route
 * (`/api/queues/agent`, ARCHITECTURE §2) is a later slice; nothing about the protocol changes.
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

  const parked = await setRunState(tx, args.run.id, "RUNNING", "WAITING_TOOL", by);
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
 * The B-03 handler for `agent.run.resume`. DB-only and idempotent: it moves the run back to QUEUED
 * and nothing else. A run that is not WAITING_TOOL any more — because the awaited reply arrived as
 * its own `msg.inbound` trigger and something else already finished this run, or because a human
 * took it over — matches zero rows and the timer fires as a no-op, which is the same answer every
 * other B-03 handler gives to a wake-up for work that is already done.
 *
 * `AND site_id = $3` is the tenant fence (PR #35 review, F3). The run id travels in a job payload,
 * and a payload is not an authorization: the id could be wrong by accident (a hand-written replay,
 * a copied fixture) or on purpose, and a wake-up that could re-queue *any* run by id would be a
 * cross-tenant write with a timer in front of it. The job row carries the site it was scheduled
 * for, so the fence costs one predicate — and a mismatch matches zero rows, which is the same
 * no-op as every other wake-up for work this handler may not do.
 */
export const agentResumeHandler: Handler = async (tx, job) => {
  const payload = resumePayloadSchema.parse(job.payload);
  await tx.query(
    `UPDATE ops.agent_run SET state = 'QUEUED', version = version + 1, updated_at = now(), updated_by = $2
     WHERE id = $1 AND state = 'WAITING_TOOL' AND site_id = $3`,
    [payload.runId, `system:job:${AGENT_RESUME_JOB_KIND}`, job.site_id],
  );
};
