/**
 * §11.2 `request_clarification` and `record_acknowledgment` — the two tools that are about a
 * conversation rather than a ride.
 *
 * | Tool | Precondition → effect | Failure |
 * |---|---|---|
 * | `request_clarification(thread, ambiguity_type, candidates, draft)` | thread ACTIVE; ≤2/thread/hour → outbound + 15-min await | send fail → exception |
 * | `record_acknowledgment(ack_id, contact, status)` | matching PENDING ack → close, cancel timer; DECLINED → AMBER | — |
 *
 * The clarification is the other half of AT-06: when the contact point cannot tell two siblings
 * apart, the agent asks instead of guessing, and the asking is an **outbox** message with
 * fixed copy (`generic.notice`) plus a 15-minute wait that is a staff task and a B-03 timer, never
 * a held session (§11.1). Three things bound it:
 *
 *  - **thread ACTIVE.** A thread a human has taken over (`PAUSED_HUMAN`) or closed is not the
 *    agent's to write into; staff own that conversation now (§13 takeover).
 *  - **≤2 per thread per hour**, counted from the agent's own ledger (`ops.agent_tool_call`), so
 *    the limit survives a restart and spans runs — two different triggers cannot each get two
 *    questions. The third is a staff task instead: a family asked twice in an hour and still not
 *    understood is a phone call, not a third text.
 *  - **the send is the outbox's**, so consent, suppression and the recipient's authorization are
 *    re-checked per contact at send time, after this call has committed. A failure to even queue it
 *    is the §11.2 "send fail → exception".
 *
 * `record_acknowledgment` is the reply side of an awaited answer: the matching PENDING
 * acknowledgment closes, its deadline timer is canceled through B-03's scheduler (a timer that
 * fires for an answered question is a second alert about nothing), and a DECLINED answer raises the
 * AMBER exception §11.2 asks for — someone said no, and that is a human's problem now.
 */
import type { Exec } from "@/db/exec";
import { ACK } from "@/domain/machines";
import { IllegalTransition, StaleOrConflict, transition } from "@/domain/transition";
import { enqueue } from "@/modules/outbox/outbox";
import { agentTasks, agentWaits } from "@/ui/copy";
import type { ToolExecution, ToolExecutor } from "../executors";
import { NO_REPLY_GRACE_SECONDS } from "./escalate";
import { PREDICATE_INBOUND_REPLY } from "./predicate";
import {
  type ExecutorDeps,
  actor,
  effectId,
  failed,
  isUuid,
  notFound,
  raiseTask,
  threadRow,
} from "./effects";

/** §11.2: "≤2/thread/hour". */
export const CLARIFICATIONS_PER_THREAD_PER_HOUR = 2;
/** §11.2: "→ outbound + 15-min await". */
export const CLARIFICATION_AWAIT_SECONDS = 15 * 60;
/** `ops.outbound_message.purpose` / `.recipient_rule` for a clarification. Not a safety purpose. */
export const CLARIFICATION_PURPOSE = "AGENT_CLARIFICATION";
export const CLARIFICATION_RECIPIENT_RULE = "thread_counterparty";
/** `ops.task.category` for the two staff tasks these tools raise. */
export const CLARIFICATION_LIMIT_TASK_CATEGORY = "CLARIFICATION_LIMIT";
export const SEND_FAILURE_TASK_CATEGORY = "SEND_FAILURE";
export const ACK_DECLINED_TASK_CATEGORY = "ACK_DECLINED";
/**
 * `ops.task.category` when the question went out and nobody answered it (§11.2 "no reply →
 * escalate"). `ACK_OVERDUE` is `escalate_exception`'s own category for "we asked and heard
 * nothing", which is exactly what this is — the agent is not waiting on a *different* kind of
 * silence just because the question was a clarification.
 */
export const CLARIFICATION_NO_REPLY_CATEGORY = "ACK_OVERDUE";

type AckRow = {
  id: string;
  state: string;
  version: number;
  outbound_message_id: string;
  contact_token: string;
  timer_job_id: string | null;
};

/*
 * THERE IS NO `requestClarificationExecutor` ANY MORE (Firia's S1-7 ruling, 2026-10-18).
 *
 * A clarification is a text to a family, so a person decides it: the tool is `human` tier with a
 * `propose` effect, the loop has no executor to reach for (`registry.ts`), and what the call
 * writes is a `MESSAGE_SEND` approval row — `clarificationProposal` in `exec/proposals.ts`, which
 * keeps both §11.2 preconditions this executor held (thread ACTIVE with a counterparty, and at
 * most two questions per thread per hour) and simply ends at a row instead of at `enqueue`.
 *
 * The function is DELETED rather than left exported and unregistered. An executor nothing can
 * call is a path that still compiles, still has tests, and is one `registry.ts` line away from
 * being live again — which is exactly the shape of the hole Veri found in the template
 * allow-list. `clarificationsInLastHour` below is kept: the proposal writer counts with it.
 *
 * What went with it is the 15-minute await. There is nothing to wait for until a person has
 * approved the question, and §11.1 has no notion of a run that waits for an approval — it has a
 * proposal row and a task. The timer and its escalation come back the moment the approved message
 * is the thing being awaited, which is B-12's to wire.
 */

export function recordAcknowledgmentExecutor(deps: ExecutorDeps): ToolExecutor {
  return async (call) => {
    const ackId = String(call.args.ack_id ?? "");
    const status = call.args.status === "DECLINED" ? "DECLINED" : "ACKNOWLEDGED";
    const sourceMessageId = String(call.args.source_message_id ?? "");
    const by = actor(call.runId);
    if (!isUuid(ackId)) return notFound("acknowledgment");

    const found = await deps.db.query<AckRow>(
      `SELECT id, state, version, outbound_message_id, contact_token, timer_job_id
       FROM ops.acknowledgment WHERE id = $1 AND site_id = $2`,
      [ackId, call.siteId],
    );
    const ack = found.rows[0];
    if (!ack) return notFound("acknowledgment");
    // The evidence has to exist and be ours: the reply that says this was acknowledged.
    const evidence = await deps.db.query<{ id: string }>(
      "SELECT id FROM ops.message WHERE id = $1 AND site_id = $2",
      [isUuid(sourceMessageId) ? sourceMessageId : null, call.siteId],
    );
    if (!evidence.rows[0]) return notFound("message");

    // Already where this call wanted it: a re-drive, or the therapist's own reply got there first.
    if (ack.state === status) {
      return {
        status: "executed",
        data: { idempotent: true, ack_id: ack.id, ack_state: ack.state },
        promptFacts: { ack_state: ack.state, ack_id: ack.id },
      };
    }
    if (ack.state !== "PENDING") {
      // §11.2's precondition is a *matching PENDING* ack; anything else is staff's to resolve.
      return failed("ACK_NOT_PENDING", { ack_state: ack.state });
    }

    try {
      return await deps.db.tx(async (tx) => {
        await transition(tx, ACK, "ops.acknowledgment", {
          id: ack.id,
          version: ack.version,
          from: "PENDING",
          // Actor T: the acknowledgment belongs to the therapist (or staff recipient) who answered
          // — the agent records their answer, it does not acknowledge on its own behalf.
          to: status,
          actor: "T",
          by,
        });
        const timerCanceled = await cancelAckTimer(tx, deps, { jobId: ack.timer_job_id, by });
        const taskId = status === "DECLINED" ? effectId(call.idempotencyKey, "ack-declined") : null;
        if (taskId) {
          // §11.2: "DECLINED → AMBER".
          await raiseTask(tx, {
            id: taskId,
            siteId: call.siteId,
            category: ACK_DECLINED_TASK_CATEGORY,
            severity: "AMBER",
            words: agentTasks.acknowledgmentDeclined,
            by,
          });
        }
        return {
          status: "executed" as const,
          data: {
            ack_id: ack.id,
            ack_state: status,
            timer_canceled: timerCanceled,
            outbound_message_id: ack.outbound_message_id,
            exception_task_id: taskId,
          },
          promptFacts: {
            ack_id: ack.id,
            ack_state: status,
            timer_canceled: timerCanceled,
            ...(taskId ? { exception_raised: true } : {}),
          },
        };
      });
    } catch (e) {
      if (e instanceof StaleOrConflict) return failed("VERSION_CONFLICT", { http_status: 412 });
      if (e instanceof IllegalTransition) return failed("ILLEGAL_TRANSITION", { reason: e.message.slice(0, 200) });
      throw e;
    }
  };
}

/* ───────────────────────────── the pieces ───────────────────────────── */

/**
 * How many clarifications this thread has had in the last hour, from the agent's own ledger.
 *
 * `ops.agent_tool_call` rather than the outbox, because the limit is on *asking*: a call that was
 * committed EXECUTED asked the question, whether or not the message later went out, and a run that
 * crashed before committing did not. Spanning runs is the point — two triggers an hour apart may
 * not each get two questions.
 *
 * The window start comes from the run's clock and `committed_at` is stamped by the database, the
 * same pairing `sweepOutbox` uses. In production they are one clock; under an injected test clock
 * they are not, which is why the suite ages the rows rather than moving the clock forward.
 */
export async function clarificationsInLastHour(
  db: Exec,
  a: { siteId: string; threadId: string; now: Date },
): Promise<number> {
  const r = await db.query<{ n: number }>(
    /*
     * PROPOSED, not EXECUTED (S1-7). The limit counts what the agent ASKED FOR, and since
     * Firia's 2026-10-18 ruling a clarification commits as a proposal — a call that committed
     * EXECUTED is one no version of this code can write any more. Counting only those would
     * have made the limit unreachable, which is the quietest way a rate limit ever fails.
     *
     * Whether a coordinator has pressed Approve on the earlier questions is deliberately not
     * part of it: two unanswered questions in an hour is the thing §11.2 is protecting a family
     * from, and a third one waiting on a card is still a third one.
     */
    `SELECT count(*)::int n FROM ops.agent_tool_call
     WHERE site_id = $1 AND tool = 'request_clarification' AND status = 'PROPOSED'
       AND args ->> 'thread_id' = $2
       AND committed_at > $3::timestamptz - interval '1 hour'`,
    [a.siteId, a.threadId, a.now.toISOString()],
  );
  return r.rows[0]?.n ?? 0;
}

/**
 * Cancel the acknowledgment's deadline through B-03's scheduler, by key — the scheduler owns what
 * canceling a job means (`ops.job` state, the in-flight wake-up that then no-ops), and the ack row
 * holds the job's id, so the key is read first.
 */
async function cancelAckTimer(
  tx: Exec,
  deps: ExecutorDeps,
  a: { jobId: string | null; by: string },
): Promise<boolean> {
  if (!a.jobId) return false;
  const job = await tx.query<{ key: string }>("SELECT key FROM ops.job WHERE id = $1", [a.jobId]);
  const key = job.rows[0]?.key;
  if (!key) return false;
  return (await deps.scheduler.cancel(tx, key, a.by)) > 0;
}

/** `raiseTask` used to live here; it is `exec/effects.ts`'s, beside the other shared writers. */
export { raiseTask } from "./effects";
