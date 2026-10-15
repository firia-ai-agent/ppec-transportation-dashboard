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

export function requestClarificationExecutor(deps: ExecutorDeps): ToolExecutor {
  return async (call) => {
    const threadId = String(call.args.thread_id ?? "");
    const templateId = String(call.args.draft_template_id ?? "");
    const ambiguity = String(call.args.ambiguity_type ?? "");
    const candidates = Array.isArray(call.args.candidate_tokens) ? (call.args.candidate_tokens as string[]) : [];
    const by = actor(call.runId);

    const thread = await threadRow(deps.db, { siteId: call.siteId, threadId });
    if (!thread) return notFound("conversation_thread");
    // "thread ACTIVE": OPEN is the only state the agent may write into. PAUSED_HUMAN means staff
    // took the conversation over, and CLOSED means it is over.
    if (thread.state !== "OPEN") {
      return failed("THREAD_NOT_ACTIVE", { thread_state: thread.state });
    }
    if (!thread.counterparty_token) {
      // An unknown-sender thread has nobody to ask (AT-09: it is answered by nobody).
      await raiseTask(deps.db, {
        id: effectId(call.idempotencyKey, "send-failure"),
        siteId: call.siteId,
        category: SEND_FAILURE_TASK_CATEGORY,
        severity: "AMBER",
        words: agentTasks.clarificationSendFailure,
        by,
      });
      return failed("NO_COUNTERPARTY");
    }

    const asked = await clarificationsInLastHour(deps.db, { siteId: call.siteId, threadId, now: call.now });
    if (asked >= CLARIFICATIONS_PER_THREAD_PER_HOUR) {
      await raiseTask(deps.db, {
        id: effectId(call.idempotencyKey, "clarification-limit"),
        siteId: call.siteId,
        category: CLARIFICATION_LIMIT_TASK_CATEGORY,
        severity: "AMBER",
        words: agentTasks.clarificationLimit,
        by,
      });
      return failed("CLARIFICATION_RATE_LIMIT", { asked_in_last_hour: asked, task_raised: true });
    }

    let queued: { id: string; duplicate: boolean };
    try {
      queued = await deps.db.tx((tx, afterCommit) =>
        enqueue(tx, afterCommit, deps.transport, {
          siteId: call.siteId,
          purpose: CLARIFICATION_PURPOSE,
          recipientRule: CLARIFICATION_RECIPIENT_RULE,
          // Computed here from the thread, never named by the model (§10.3, tools.ts rule 1).
          recipientToken: thread.counterparty_token!,
          channel: thread.channel as "SMS_1TO1",
          // Fixed copy: the words are the outbox's, and the question is "which one did you mean".
          templateId,
          vars: {},
          // No plan behind a question, and no child reference: `generic.notice` names no child and
          // this message is not about one leg (outbox.assertChildReference).
          planVersionBasis: 0,
          notAfter: new Date(call.now.getTime() + CLARIFICATION_AWAIT_SECONDS * 1000),
          // The whole of the resume contract for a send: the same call re-driven enqueues nothing.
          idempotencyKey: call.idempotencyKey,
          by,
        }),
      );
    } catch (e) {
      // §11.2: "send fail → exception". The run stops; a human asks the question.
      await raiseTask(deps.db, {
        id: effectId(call.idempotencyKey, "send-failure"),
        siteId: call.siteId,
        category: SEND_FAILURE_TASK_CATEGORY,
        severity: "AMBER",
        words: agentTasks.clarificationSendFailure,
        by,
      });
      return failed("SEND_FAILED", { reason: (e instanceof Error ? e.message : String(e)).slice(0, 200) });
    }

    return {
      status: "executed",
      data: {
        outbound_message_id: queued.id,
        duplicate: queued.duplicate,
        template_id: templateId,
        ambiguity_type: ambiguity,
        candidate_count: candidates.length,
        asked_in_last_hour: asked + 1,
      },
      promptFacts: {
        clarification_asked: true,
        ambiguity_type: ambiguity,
        candidate_count: candidates.length,
        thread_id: threadId,
      },
      // §11.1: the wait is a task plus a timer (run/timers.ts), not a session. The predicate is a
      // coded one, so `close_task` can close it when the family's reply arrives.
      awaitExternal: {
        reasonCode: "CLARIFICATION",
        afterSeconds: CLARIFICATION_AWAIT_SECONDS,
        summary: agentWaits.clarification,
        completionPredicate: PREDICATE_INBOUND_REPLY,
        // §11.2's other half of the deadline: a family that never answers becomes a staff task
        // without a model turn (exec/escalate.ts). The watch is the thread, because the reply we
        // are waiting for has no id yet.
        escalation: {
          afterSeconds: CLARIFICATION_AWAIT_SECONDS + NO_REPLY_GRACE_SECONDS,
          reason: "CLARIFICATION",
          category: CLARIFICATION_NO_REPLY_CATEGORY,
          severity: "AMBER",
          nextStepCode: "STAFF_CALL",
          watch: { kind: "inbound_reply", threadId: thread.id },
        },
      },
    };
  };
}

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
    `SELECT count(*)::int n FROM ops.agent_tool_call
     WHERE site_id = $1 AND tool = 'request_clarification' AND status = 'EXECUTED'
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
