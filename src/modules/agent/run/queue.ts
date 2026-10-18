/**
 * An agent run **as a queue job** (PRD §11.1 l.924: "Each run = job with idempotency
 * (trigger_type, trigger_id)").
 *
 * Slice 2 made a run idempotent on its trigger, and slice 3 fenced every entry point on the site —
 * but a run was still only a *row*. Nothing delivered it: `startAndDriveRun` drove the run inline,
 * in whatever process the trigger happened to arrive in, and the only other driver was
 * `resumeQueuedRuns`, which nothing in production called. That is the §11.1 row "the run is not yet
 * a *queue* job", and this module is the delivery half of it:
 *
 *   trigger → `enqueueRun` (one row, one message) → topic `ppec-agent` → `/api/queues/agent`
 *           → `handleAgentWake` → the per-run lease → `driveRun`
 *
 * What that buys, beyond symmetry with B-03's timers and the outbox:
 *  - a run outlives the request that triggered it, so an inbound SMS is not held open while a model
 *    thinks, and a 60-second webhook is not where a 120-second run has to fit;
 *  - a redelivery is the recovery path for a driver that died mid-run — the lease expires, the next
 *    delivery reclaims (lease.ts);
 *  - the work happens in **one** place, with one claim in front of it, which is what makes F2's
 *    "two drivers on one run" preventable at all.
 *
 * Queues is at-least-once and unordered with no delay SLA, so this consumer must be idempotent, and
 * is: every delivery goes through the lease, and every one of the lease's refusals — already
 * finished, parked on its timer, held by another driver, another tenant's, unknown — is a **no-op
 * and an ack**, never a throw. A throw means "redeliver this", and none of those would be helped by
 * one. What *does* throw is a drive that failed unexpectedly, which is the only case where trying
 * again later is the right answer.
 */
import type { Db } from "@/db/exec";
import { MAX_DELIVERIES } from "@/modules/jobs/scheduler";
import { AGENT_RUN_LEASE_SECONDS, type LeaseRefusal, driveRunLeased } from "./lease";
import type { RunDeps, RunResult } from "./loop";
import { startRun } from "./store";
import type { Trigger } from "./triggers";
import { agentWakeSchema, runWakeKey, type AgentWake, type AgentWakeTransport } from "./wake";

/** The Vercel Queues topic, and the `experimentalTriggers` entry in vercel.json. */
export const AGENT_TOPIC = "ppec-agent";

/**
 * The agent route's `maxDuration` (ARCHITECTURE §2, "Agent runner … 120 s"), pinned here because
 * the lease is chosen *against* it: `AGENT_RUN_LEASE_SECONDS` has to be longer, so that the
 * platform stops a wedged driver before its claim can expire (lease.ts). `queue.test.ts` holds the
 * two together; the route cannot import this (Next wants a literal in a segment config export), so
 * it spells the number out and `route.test.ts` pins that copy to this one.
 */
export const AGENT_RUN_MAX_DURATION_SECONDS = 120;

/**
 * `visibilityTimeoutSeconds` for this consumer: how long Queues hides a delivered message before
 * redelivering it. It has to be **longer than the lease**, because redelivery is how a dead driver's
 * run is recovered: a redelivery that arrived while the claim was still live could only be refused
 * `leased`, spending one of the MAX_DELIVERIES the message has. 300 s is the package's default and
 * comfortably past the 150 s lease, so the first redelivery after a crash finds a reclaimable run.
 */
export const AGENT_QUEUE_VISIBILITY_TIMEOUT_SECONDS = 300;

/**
 * vercel.json `retryAfterSeconds` for this trigger, and the delay our own `retry` callback returns:
 * the lease, for the same reason as the visibility timeout. A redelivery sooner than that can only
 * be refused by a claim that is still live, and the timer trigger sets this to *its* lease too
 * (QUEUE_RETRY_AFTER_SECONDS), so the convention is the same one.
 */
export const AGENT_QUEUE_RETRY_AFTER_SECONDS = AGENT_RUN_LEASE_SECONDS;

/**
 * What the consumer's `retry` callback returns for the Nth delivery of a message whose drive threw:
 * wait out the lease, and stop at MAX_DELIVERIES by acknowledging.
 *
 * Flat rather than exponential, unlike the timer's `queueRetryDirective`: the timer backs off from
 * 2 s because its lease is 2 s and NFR-03 gives it 5 s, while a redelivery here is worthless until
 * the claim could have lapsed, so the first useful retry *is* the backoff. The bound is ours
 * because @vercel/queue 0.8.0 has no `maxDeliveries` option and no DLQ (scheduler.ts
 * MAX_DELIVERIES); dropping the message leaves the run row exactly as it was, which a later trigger
 * or the ops surface can still act on — it stops us paying for a hot loop on a poison payload.
 */
export function agentRetryDirective(deliveryCount: number): { afterSeconds: number } | { acknowledge: true } {
  return deliveryCount >= MAX_DELIVERIES
    ? { acknowledge: true }
    : { afterSeconds: AGENT_QUEUE_RETRY_AFTER_SECONDS };
}

/**
 * The message, its idempotency key and the transport that publishes one: `wake.ts`, which is a
 * leaf so that `timers.ts` can publish a wake-up without importing the consumer that handles it.
 * Re-exported here because the queue is still the one name to import for the delivery itself; see
 * that file for the cycle this split breaks and what it was costing.
 */
export { agentWakeSchema, runWakeKey, type AgentWake, type AgentWakeTransport } from "./wake";

/**
 * The §11.1 start, as a queue job: make (or find) the run for this trigger and publish one wake-up
 * for it. The caller's request ends there — the run is driven by `/api/queues/agent`.
 *
 * `created` is false for a duplicate trigger, and the wake-up is published either way: the run that
 * already exists may be one whose driver died, and the queue's own idempotency key
 * (`runWakeKey`) is what keeps a redelivered trigger from becoming two deliveries.
 *
 * A failed publish **throws**, and deliberately does not leave a quiet half-start behind: the run
 * row is still there and `startRun` is idempotent, so the caller's own retry — the inbound webhook's
 * queue, the cron that found the overdue row — collapses onto the same run and publishes again.
 * There is no agent-side sweeper that would re-arm a QUEUED run nobody was told about; B-03's
 * every-minute sweep covers `ops.job`, not this.
 */
export async function enqueueRun(
  db: Db,
  transport: AgentWakeTransport,
  trigger: Trigger,
  routing: { model: string; provider: string },
): Promise<{ runId: string; created: boolean }> {
  const { runId, created } = await startRun(db, trigger, routing);
  await transport.publish({ runId, siteId: trigger.siteId }, { idempotencyKey: runWakeKey(runId) });
  return { runId, created };
}

/** A delivery nobody could act on. `malformed` is the only one the lease does not decide. */
export type AgentWakeRefusal = LeaseRefusal | "malformed";

export type AgentWakeResult =
  | { readonly ok: false; readonly refused: AgentWakeRefusal; readonly runId?: string; readonly detail?: string }
  | { readonly ok: true; readonly runId: string; readonly reclaimed: boolean; readonly result: RunResult };

/**
 * One delivery: parse it, claim the run it names, drive it, release the claim.
 *
 * A payload that is not an agent wake-up is refused `malformed` and acked rather than thrown back
 * at the queue: a message from another environment or an older deployment is not going to parse any
 * better on the fourth delivery, and with no DLQ a throw is a hot loop. The detail names the fields
 * that were wrong and never the values, because the values came from outside this process.
 *
 * Everything else is the lease's answer (lease.ts `LeaseRefusal`), unchanged and un-reinterpreted.
 */
export async function handleAgentWake(
  db: Db,
  message: unknown,
  opts: { deps: RunDeps; leaseSeconds?: number },
): Promise<AgentWakeResult> {
  const parsed = agentWakeSchema.safeParse(message);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((i) => i.path.join(".") || "(root)"))].sort();
    return { ok: false, refused: "malformed", detail: fields.join(",") };
  }
  const { runId, siteId } = parsed.data;
  const driven = await driveRunLeased(opts.deps, runId, { siteId, leaseSeconds: opts.leaseSeconds });
  return driven.claimed
    ? { ok: true, runId, reclaimed: driven.reclaimed, result: driven.result }
    : { ok: false, refused: driven.reason, runId };
}

/** The one line the route logs per delivery. Ids and codes only — no prose, no payload. */
export function agentWakeLog(r: AgentWakeResult): string {
  if (!r.ok) return `refused ${r.refused}${r.runId ? ` run=${r.runId}` : ""}${r.detail ? ` fields=${r.detail}` : ""}`;
  const steps = `steps=${r.result.steps}`;
  return `run=${r.runId} ${r.result.state} ${steps}${r.reclaimed ? " reclaimed" : ""}`;
}
