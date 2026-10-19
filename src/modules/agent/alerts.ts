/**
 * AN ALERT FOR STAFF IS ALSO AN ALERT FOR THE AGENT (ledger #74 e).
 *
 * PRD §11.1's "operational event (rules first)": a deterministic rule raises a task a coordinator
 * sees — a van that no longer carries its riders, say — and the agent is started on that task to
 * propose what to do about it. The run may only *propose*: nobody asked it to act, so there is no
 * person to act as (`run/exec/actions.ts`), and every action it would take is a card a person
 * confirms (policy `proposeOnly`, `alertContext`).
 *
 * `raiseStaffAlert` is the one writer: the task and, in the same transaction, the run — then the
 * wake-up after commit, the `inbound-hook.ts` pattern. Idempotent twice over: the task on its id,
 * the run on (operational.event, task id).
 *
 * WHAT NEVER STARTS A RUN, so nothing can loop:
 *  - a task the agent itself wrote (`agent:<run>`) or its own timers wrote (`system:job:agent.…`);
 *  - the agent's bookkeeping and the ask path's rows (`AGENT_*`, `STAFF_ASK`, `NEEDS_PERSON`,
 *    `ASSISTANT_UNAVAILABLE`, `STAFF_ACTION`);
 *  - more than `alertAgentConfig.maxRunsPerSitePerHour` alert runs at one centre in the last hour.
 */
import { alertAgentConfig } from "@/config/live";
import type { Exec } from "@/db/exec";
import { MODEL_UNAVAILABLE_CATEGORY } from "./alert-task";
import { STAFF_ALERT_TASK_CATEGORY, STAFF_ASK_TASK_CATEGORY } from "./ask/ask-text";
import { raiseTask } from "./run/exec/effects";
import { STAFF_ACTION_TASK_CATEGORY } from "./run/exec/proposals";
import { runWakeKey, type AgentWakeTransport } from "./run/queue";
import { startRun } from "./run/store";
import type { Trigger } from "./run/triggers";

/** The trigger an alert starts: §11.1's operational event, keyed on the alert's own task row. */
export const ALERT_TRIGGER = "operational.event" as const;

const NEVER_A_RUN: ReadonlySet<string> = new Set([
  STAFF_ASK_TASK_CATEGORY,
  STAFF_ALERT_TASK_CATEGORY,
  MODEL_UNAVAILABLE_CATEGORY,
  STAFF_ACTION_TASK_CATEGORY,
]);

export type AlertAgentResult = "started" | "agent-wrote-it" | "not-for-the-agent" | "over-the-hourly-cap";

type RaiseInput = Parameters<typeof raiseTask>[1];

/**
 * Start the agent on an alert task that already exists, if it is one the agent should hear.
 * Inside the caller's transaction; the wake-up is published after it commits.
 */
export async function alertAgent(
  tx: Exec,
  afterCommit: (hook: () => Promise<void>) => void,
  transport: AgentWakeTransport,
  task: { readonly id: string; readonly siteId: string; readonly category: string; readonly by: string },
  routing: { readonly model: string; readonly provider: string },
): Promise<AlertAgentResult> {
  if (task.by.startsWith("agent:") || task.by.startsWith("system:job:agent")) return "agent-wrote-it";
  if (NEVER_A_RUN.has(task.category) || task.category.startsWith("AGENT_")) return "not-for-the-agent";
  const recent = await tx.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM ops.agent_run
      WHERE site_id = $1 AND trigger_type = $2 AND created_at > now() - interval '1 hour'`,
    [task.siteId, ALERT_TRIGGER],
  );
  if ((recent.rows[0]?.n ?? 0) >= alertAgentConfig.maxRunsPerSitePerHour) return "over-the-hourly-cap";
  const trigger: Trigger = { type: ALERT_TRIGGER, id: task.id, siteId: task.siteId };
  const { runId } = await startRun(tx, trigger, routing);
  afterCommit(() => transport.publish({ runId, siteId: task.siteId }, { idempotencyKey: runWakeKey(runId) }));
  return "started";
}

/** Raise a staff alert and, when it is one the agent should hear, start the agent on it. */
export async function raiseStaffAlert(
  tx: Exec,
  afterCommit: (hook: () => Promise<void>) => void,
  transport: AgentWakeTransport,
  task: RaiseInput,
  routing: { readonly model: string; readonly provider: string },
): Promise<{ readonly taskId: string; readonly agent: AlertAgentResult }> {
  const taskId = await raiseTask(tx, task);
  const agent = await alertAgent(tx, afterCommit, transport, { id: taskId, siteId: task.siteId, category: task.category, by: task.by }, routing);
  return { taskId, agent };
}

/**
 * The backstop for a lost wake-up (the one-minute sweep calls it): an alert run still QUEUED a
 * minute after it was started is published again. Driving is leased (`run/lease.ts`), so a wake-up
 * that arrives twice drives once. The key carries the minute, so the queue does not swallow a
 * second attempt as a duplicate of the first.
 */
export async function rewakeAlertRuns(db: Exec, transport: AgentWakeTransport, now: Date): Promise<number> {
  const stale = await db.query<{ id: string; site_id: string }>(
    `SELECT id, site_id FROM ops.agent_run
      WHERE trigger_type = $1 AND state = 'QUEUED' AND created_at < $2::timestamptz - make_interval(secs => $3)
      ORDER BY created_at LIMIT 50`,
    [ALERT_TRIGGER, now.toISOString(), alertAgentConfig.rewakeAfterSeconds],
  );
  const minute = Math.floor(now.getTime() / 60_000);
  for (const run of stale.rows) {
    await transport.publish({ runId: run.id, siteId: run.site_id }, { idempotencyKey: `${runWakeKey(run.id)}:rewake:${minute}` });
  }
  return stale.rows.length;
}
