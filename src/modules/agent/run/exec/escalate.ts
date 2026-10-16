/**
 * §11.2's "**no reply → escalate**", as a timer rather than as a model turn — the half of **AT-02**
 * ("autonomous timer follow-up + escalation") that slice 3 said was still missing.
 *
 * A run that has asked somebody something ends on two deadlines, not one (timers.ts):
 *
 *  1. `agent.run.resume` at the await's own deadline — the run wakes up and decides what to do next,
 *     which costs a model turn and may ask again, close the thread, or escalate with the tool.
 *  2. `agent.await.escalate` a little later — **this** one. It takes no turn, calls no model and
 *     reads one row: the row whose state would show that the answer arrived (`AwaitWatch`). If it
 *     did, the timer is a no-op, which is the same answer every other B-03 handler gives to a
 *     wake-up for work that is already done. If it did not, the exception §11.2 asks for is raised
 *     through the *same writer* `escalate_exception` uses (`exec/staff.writeExceptionTask`), so
 *     what a coordinator sees is the row that tool would have written.
 *
 * Why deterministic rather than "let the resumed run decide": because the resumed run is the thing
 * that may not happen. A model refusal, an exhausted step budget, a gateway outage or a paused
 * agent all end a run quietly and correctly — and a family, a therapist or a dispatcher who was
 * asked a question and never followed up on is not a quiet, correct outcome. This path has no model
 * in it, so there is nothing in it to fail that way.
 *
 * Exactly once, twice over: the job fires once (B-03's guarded claim), and the task's id is derived
 * from the awaited call's idempotency key, so a replayed or re-delivered wake-up writes nothing.
 */
import { z } from "zod";
import type { Exec } from "@/db/exec";
import { ACK } from "@/domain/machines";
import { StaleOrConflict, transition } from "@/domain/transition";
import type { Handler } from "@/modules/jobs/runner";
import { agentNoReply, fill } from "@/ui/copy";
import type { AwaitWatch } from "../executors";
import { type TriggerType, triggerLabel } from "../triggers";
import { writeExceptionTask } from "./staff";

/** The `ops.job.kind` that escalates an unanswered await. Registered in `modules/jobs/handlers.ts`. */
export const AGENT_ESCALATE_JOB_KIND = "agent.await.escalate";

/**
 * How long past the await's own deadline the escalation fires. One minute, so a reply that lands on
 * the deadline — or a resumed run that answers it on the spot — is not escalated for being
 * punctual, and nobody waits meaningfully longer than §11.2's deadline for a person to be told.
 */
export const NO_REPLY_GRACE_SECONDS = 60;

/** The live job key for one awaited call's escalation. Keyed by (run, seq), as the resume timer is. */
export function escalateTimerKey(runId: string, seq: number): string {
  return `${AGENT_ESCALATE_JOB_KIND}:${runId}:${seq}`;
}

const watchSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("inbound_reply"), threadId: z.string().uuid() }),
  z.object({ kind: z.literal("acknowledgment"), ackId: z.string().uuid() }),
  z.object({ kind: z.literal("capability"), capabilityId: z.string().uuid() }),
]);

export const escalatePayloadSchema = z.object({
  runId: z.string().uuid(),
  seq: z.number().int().nonnegative(),
  /** The await task this escalation is about. Carried so the record joins up, not read from. */
  taskId: z.string().uuid(),
  /** Derived from the awaited call's idempotency key: the whole of "exactly once". */
  escalationTaskId: z.string().uuid(),
  reason: z.enum(["CLARIFICATION", "ACKNOWLEDGMENT", "CAPABILITY"]),
  category: z.string().min(1).max(40),
  severity: z.enum(["AMBER", "RED"]),
  nextStepCode: z.string().min(1).max(40),
  /** When the wait began, for a watch that is about anything arriving rather than a row moving. */
  since: z.string(),
  watch: watchSchema,
});
export type EscalatePayload = z.infer<typeof escalatePayloadSchema>;

/**
 * The B-03 handler. DB-only, site-fenced on its own job row (PR #35 review, F3: a run id on a
 * payload is not an authorization), and idempotent.
 */
export const agentEscalateHandler: Handler = async (tx, job) => {
  const p = escalatePayloadSchema.parse(job.payload);
  const run = await tx.query<{ trigger_type: TriggerType; trigger_id: string }>(
    "SELECT trigger_type, trigger_id FROM ops.agent_run WHERE id = $1 AND site_id = $2",
    [p.runId, job.site_id],
  );
  const trigger = run.rows[0];
  // A run of another tenant, or one that no longer exists: zero rows, no escalation. The same
  // no-op `agentResumeHandler` gives a wake-up it may not act on.
  if (!trigger) return;

  if (await answered(tx, { siteId: job.site_id, watch: p.watch, since: p.since })) return;

  // An acknowledgment nobody answered has its own §6.3 edge, and it is the system's: the ack is
  // closed EXPIRED_ESCALATED before the exception is raised, so the two cannot disagree about
  // whether it is still pending.
  if (p.watch.kind === "acknowledgment") {
    await expireAcknowledgment(tx, { siteId: job.site_id, ackId: p.watch.ackId, by: escalationActor(p.runId) });
  }

  const words = agentNoReply[p.reason];
  await writeExceptionTask(tx, {
    id: p.escalationTaskId,
    siteId: job.site_id,
    category: p.category,
    severity: p.severity,
    // Our words, chosen by the await's reason code — there is no model in this path to have any.
    summary: fill(agentNoReply.locator, {
      summary: words.summary,
      trigger: triggerLabel({ type: trigger.trigger_type, id: trigger.trigger_id }),
      step: p.seq,
    }),
    nextStepCode: p.nextStepCode,
    predicate: words.predicate,
    by: escalationActor(p.runId),
  });
};

/** `created_by` / `updated_by` for the escalation: the timer, acting for that run. */
export function escalationActor(runId: string): string {
  return `system:job:${AGENT_ESCALATE_JOB_KIND}:${runId}`;
}

/** Did the thing this run was waiting for arrive? One read of one row's state. */
export async function answered(
  tx: Exec,
  a: { siteId: string; watch: AwaitWatch; since: string },
): Promise<boolean> {
  if (a.watch.kind === "acknowledgment") {
    const r = await tx.query<{ state: string }>(
      "SELECT state FROM ops.acknowledgment WHERE id = $1 AND site_id = $2",
      [a.watch.ackId, a.siteId],
    );
    // A row that is gone cannot be escalated about; a row that has moved off PENDING was answered.
    return !r.rows[0] || r.rows[0].state !== "PENDING";
  }
  if (a.watch.kind === "capability") {
    const r = await tx.query<{ state: string }>(
      "SELECT state FROM ops.vehicle_capability_day WHERE id = $1 AND site_id = $2",
      [a.watch.capabilityId, a.siteId],
    );
    const state = r.rows[0]?.state;
    return state === undefined || (state !== "UNKNOWN" && state !== "REQUESTED");
  }
  // A reply has no id until it exists, so what is watched is the thread: any inbound message that
  // is not our own echo, received after the question went out.
  const r = await tx.query<{ n: number }>(
    `SELECT count(*)::int n FROM ops.message
     WHERE site_id = $1 AND thread_id = $2 AND direction = 'IN' AND is_own_echo = false
       AND received_at > $3::timestamptz`,
    [a.siteId, a.watch.threadId, a.since],
  );
  return (r.rows[0]?.n ?? 0) > 0;
}

/** PENDING → EXPIRED_ESCALATED (actor Y, machines.ts ACK). A row that moved first is left alone. */
async function expireAcknowledgment(
  tx: Exec,
  a: { siteId: string; ackId: string; by: string },
): Promise<void> {
  const r = await tx.query<{ version: number }>(
    "SELECT version FROM ops.acknowledgment WHERE id = $1 AND site_id = $2 AND state = 'PENDING'",
    [a.ackId, a.siteId],
  );
  const row = r.rows[0];
  if (!row) return;
  try {
    await transition(tx, ACK, "ops.acknowledgment", {
      id: a.ackId, version: row.version, from: "PENDING", to: "EXPIRED_ESCALATED", actor: "Y", by: a.by,
    });
  } catch (e) {
    // Answered between the two statements: the reply wins, and the exception below is still raised
    // for this firing only if `answered` had not already returned true.
    if (!(e instanceof StaleOrConflict)) throw e;
  }
}
