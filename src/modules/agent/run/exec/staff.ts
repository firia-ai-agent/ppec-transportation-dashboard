/**
 * §11.2 `escalate_exception` and `close_task` — the two tools whose whole job is handing work to a
 * human, or taking it back off them when the evidence says it is done.
 *
 * | Tool | Precondition → effect | Failure |
 * |---|---|---|
 * | `escalate_exception(severity, category, leg, summary, next_step)` | always allowed | — |
 * | `close_task(task_id, evidence_ref)` | evidence satisfies completion predicate | stays open |
 *
 * "Always allowed" is literal and is why `escalate_exception` is the one non-read tool the policy
 * engine lets through while the agent is paused (policy.ts step 2): a stopped agent must still be
 * able to say why it stopped. It is also the only tool that may carry the model's own words, and
 * they are staff-facing and redacted before they are stored (`sanitizeStaffText`) — an exception
 * summary keeps its sentence and loses the number somebody tried to smuggle into it.
 *
 * `close_task` is the opposite direction and is deliberately the weaker of the two. §6.3 freezes
 * the task machine, and the only edges into `CLOSED_VERIFIED` are from `RESOLVED_APPROVED` /
 * `RESOLVED_OVERRIDE` by the system — so what the agent can close is a task **staff have already
 * resolved**, by verifying the evidence against the completion predicate.
 *
 * A task that is still OPEN — including every await task the agent raises for itself — is
 * **refused by name**: `CLOSE_REFUSED_OPEN` plus `agentRefusals.closeTaskOpen` for whoever reads
 * the step, rather than the bare "stays open" the PRD's failure column allows. That is the
 * founder's decision of 2026-10-15, and it is a refusal and not a new edge: the §6.3 machine is
 * unchanged, nothing is written, and the row the model named is left exactly as it was found.
 * "Stays open" without a named reason remains the answer for the two cases that really are about
 * evidence rather than about permission — a predicate a machine cannot read, and evidence that
 * does not satisfy one it can.
 */
import { TASK, canTransition } from "@/domain/machines";
import { IllegalTransition, StaleOrConflict, transition } from "@/domain/transition";
import { agentNextSteps, agentRefusals, agentTasks } from "@/ui/copy";
import type { ToolExecution, ToolExecutor } from "../executors";
import { type ExecutorDeps, actor, effectId, failed, isUuid, legRow, notFound } from "./effects";
import { checkPredicate } from "./predicate";

/** §11.2 severity → `ops.task.severity` (there is no INFO on a task; the board's lowest is GREEN). */
const TASK_SEVERITY: Readonly<Record<string, "GREEN" | "AMBER" | "RED">> = {
  RED: "RED",
  AMBER: "AMBER",
  INFO: "GREEN",
};

type TaskState = (typeof TASK)["states"][number];

/**
 * `close_task`'s refusal on a task that is still OPEN, as a code (founder decision, 2026-10-15).
 *
 * It is its own name rather than the generic `TASK_NOT_RESOLVED` because it is the only one of the
 * three unresolved states the agent reaches on its own account — every await task it raises is
 * OPEN — so the run's record should say *that*, and not merely that some precondition failed. The
 * staff-readable half is `ui/copy.ts` `agentRefusals.closeTaskOpen`.
 */
export const CLOSE_REFUSED_OPEN = "TASK_NOT_CLOSABLE_OPEN";

export function escalateExceptionExecutor(deps: ExecutorDeps): ToolExecutor {
  return async (call) => {
    const severity = TASK_SEVERITY[String(call.args.severity)] ?? "AMBER";
    const category = String(call.args.category ?? "");
    const summary = String(call.args.summary ?? agentTasks.escalation.summary);
    const nextStepCode = String(call.args.next_step_code ?? "NONE");
    const legId = typeof call.args.leg_id === "string" ? call.args.leg_id : null;
    const by = actor(call.runId);

    // A leg named on an exception has to be a real leg of this site, or the row would point at
    // nothing — and `ops.task.trip_leg_id` is a foreign key, so the insert would fail anyway.
    const leg = legId ? await legRow(deps.db, { siteId: call.siteId, legId }) : null;
    if (legId && !leg) return notFound("trip_leg");

    const taskId = effectId(call.idempotencyKey, "exception");
    await deps.db.query(
      `INSERT INTO ops.task (id, site_id, category, severity, state, summary, next_step, completion_predicate,
         trip_leg_id, child_token, prior_leg_state, created_by, updated_by, source_mode)
       VALUES ($1, $2, $3, $4, 'OPEN', $5, $6, $7, $8, $9, $10, $11, $11, 'SIMULATED')
       ON CONFLICT (id) DO NOTHING`,
      [
        taskId, call.siteId, category, severity,
        // The model's sentence, already redacted by the policy engine before it was stored on the
        // call row; this is the same value, so the task and the audit trail agree.
        summary,
        // The words are ours, chosen by the model's code (§11.2 `next_step`).
        agentNextSteps[nextStepCode as keyof typeof agentNextSteps] ?? agentNextSteps.NONE,
        agentTasks.escalation.predicate,
        leg?.id ?? null,
        leg?.child_token ?? null,
        leg?.state ?? null,
        by,
      ],
    );

    return {
      status: "executed",
      data: {
        exception_task_id: taskId,
        severity,
        category,
        next_step_code: nextStepCode,
        trip_leg_id: leg?.id ?? null,
      },
      promptFacts: { exception_raised: true, severity, category, next_step_code: nextStepCode },
      // A run that has escalated has handed its work to a person; there is nothing after it for the
      // agent to decide, and another model turn would only cost money to say so.
      done: true,
    };
  };
}

export function closeTaskExecutor(deps: ExecutorDeps): ToolExecutor {
  return async (call) => {
    const taskId = String(call.args.task_id ?? "");
    const evidenceRef = String(call.args.evidence_ref ?? "");
    const by = actor(call.runId);
    if (!isUuid(taskId)) return notFound("task");

    const found = await deps.db.query<{ id: string; state: TaskState; version: number; completion_predicate: string }>(
      "SELECT id, state, version, completion_predicate FROM ops.task WHERE id = $1 AND site_id = $2",
      [taskId, call.siteId],
    );
    const task = found.rows[0];
    if (!task) return notFound("task");
    if (task.state === "CLOSED_VERIFIED") {
      return staysOpenOrClosed(true, { taskId, reasonCode: "ALREADY_CLOSED", idempotent: true });
    }
    // An OPEN task is refused **by name**, before any evidence is read and whatever the machine
    // would say. It is the case the model will actually reach — its own 15-minute await tasks are
    // OPEN — and the founder's decision (2026-10-15) is that it gets an explicit reason and a
    // sentence a coordinator can read, not a silent "stays open". Checked ahead of
    // `canTransition` on purpose: if §6.3 ever grew an OPEN edge, this executor still would not
    // take it, because closing a task nobody has resolved is not the agent's call to make.
    if (task.state === "OPEN") {
      return staysOpenOrClosed(false, {
        taskId,
        reasonCode: CLOSE_REFUSED_OPEN,
        state: task.state,
        staff_message: agentRefusals.closeTaskOpen,
      });
    }
    // §6.3: only a task staff have resolved has an edge into CLOSED_VERIFIED, and only for the
    // system. IN_PROGRESS and SNOOZED land here — somebody is already on them.
    if (!canTransition(TASK, task.state, "CLOSED_VERIFIED", "Y")) {
      return staysOpenOrClosed(false, { taskId, reasonCode: "TASK_NOT_RESOLVED", state: task.state });
    }

    const check = await checkPredicate(deps.db, {
      siteId: call.siteId,
      predicate: task.completion_predicate,
      evidenceRef,
    });
    if (!check.satisfied) {
      // The PRD's own failure column: "stays open". Not an error — the evidence simply does not
      // show the thing the task is waiting for, and the task is still a person's to close.
      return staysOpenOrClosed(false, { taskId, reasonCode: check.reasonCode, evidence: check.evidence });
    }

    try {
      return await deps.db.tx(async (tx) => {
        // The evidence first, then the state: `task_closed_needs_evidence` is a row check, so a
        // CLOSED_VERIFIED row without evidence cannot exist even for one statement.
        const stamped = await tx.query<{ version: number }>(
          `UPDATE ops.task SET completion_evidence = $2::jsonb, version = version + 1,
             updated_at = now(), updated_by = $3
           WHERE id = $1 AND version = $4 RETURNING version`,
          [
            task.id,
            JSON.stringify({
              evidence_ref: evidenceRef,
              kind: check.evidence?.kind ?? null,
              state: check.evidence?.state ?? null,
              closed_by_run: call.runId,
              call_id: call.callId,
            }),
            by,
            task.version,
          ],
        );
        if (stamped.rows.length !== 1) throw new StaleOrConflict(`task ${task.id}: stale`);
        await transition(tx, TASK, "ops.task", {
          id: task.id,
          version: stamped.rows[0].version,
          from: task.state,
          to: "CLOSED_VERIFIED",
          actor: "Y",
          by,
        });
        return staysOpenOrClosed(true, { taskId, reasonCode: check.reasonCode, evidence: check.evidence });
      });
    } catch (e) {
      if (e instanceof StaleOrConflict) return failed("VERSION_CONFLICT", { http_status: 412 });
      if (e instanceof IllegalTransition) return failed("ILLEGAL_TRANSITION", { reason: e.message.slice(0, 200) });
      throw e;
    }
  };
}

/**
 * One shape for both close outcomes, because "closed" and "stays open" are both successful calls:
 * the §11.2 failure column for `close_task` is a state of the world, not an error.
 */
function staysOpenOrClosed(
  closed: boolean,
  a: { taskId: string; reasonCode: string } & Record<string, unknown>,
): ToolExecution {
  const { taskId, reasonCode, ...rest } = a;
  return {
    status: "executed",
    data: { closed, task_id: taskId, reason_code: reasonCode, ...rest },
    promptFacts: { task_closed: closed, reason_code: reasonCode },
  };
}
