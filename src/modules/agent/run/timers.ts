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
import { uuidv7 } from "uuidv7";
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

export type ParkedAwait = { readonly jobKey: string; readonly jobId: string; readonly taskId: string; readonly dueAt: Date };

/**
 * Commit the awaiting call, raise the staff task, arm the timer and park the run — in the caller's
 * transaction, which must be the one that commits the tool call, so the four cannot come apart.
 *
 * `severity` is GREEN: a run waiting for an answer it asked for on time is not an exception. The
 * task becomes staff-visible work when its own escalation timer fires (the §11.2 "no reply →
 * escalate" row, a later slice), not when it is created.
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
      `${args.await.summary} (${triggerLabel(args.run.trigger)}, step ${args.call.seq})`,
      `Wait for the reply, or answer it; the agent resumes when the timer fires`,
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

  const parked = await setRunState(tx, args.run.id, "RUNNING", "WAITING_TOOL", by);
  if (!parked) throw new Error(`run ${args.run.id} was not RUNNING; refusing to park it on a timer`);

  return { jobKey: awaitTimerKey(args.run.id, args.call.seq), jobId: job.id, taskId, dueAt };
}

/**
 * The B-03 handler for `agent.run.resume`. DB-only and idempotent: it moves the run back to QUEUED
 * and nothing else. A run that is not WAITING_TOOL any more — because the awaited reply arrived as
 * its own `msg.inbound` trigger and something else already finished this run, or because a human
 * took it over — matches zero rows and the timer fires as a no-op, which is the same answer every
 * other B-03 handler gives to a wake-up for work that is already done.
 */
export const agentResumeHandler: Handler = async (tx, job) => {
  const payload = resumePayloadSchema.parse(job.payload);
  await tx.query(
    `UPDATE ops.agent_run SET state = 'QUEUED', version = version + 1, updated_at = now(), updated_by = $2
     WHERE id = $1 AND state = 'WAITING_TOOL'`,
    [payload.runId, `system:job:${AGENT_RESUME_JOB_KIND}`],
  );
};
