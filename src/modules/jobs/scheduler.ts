/**
 * JobScheduler seam (PRD ADR 1.2, ADR-001). `ops.job` is the source of truth; the wake transport
 * (Vercel Queues now, pg-boss on AWS later; QStash is a Proposed contingency only, not implemented)
 * is just an alarm clock. Exactly-once *effect* comes from the guarded claim, not from the transport.
 */
import { uuidv7 } from "uuidv7";
import type { Db, Exec } from "@/db/exec";

export const MAX_DELAY_SECONDS = 7 * 24 * 3600; // Vercel Queues limit
/**
 * Claim lease (ADR-001, Option A, DECISION-LEDGER row 56 "Accepted by default (Firia, within founder locks)",
 * Firia → Rudy relay 2026-10-14 14:22 ET — the Option A retune, which supersedes the 3 s lease proposed for
 * row 38 (PR #10, closed, so row 38 is not in this tree; row 56 cites it)):
 * short, so a consumer that dies after claiming is recovered within the 5 s bar. Handlers are DB-only and
 * short; one that outlives the lease renews it (runner.ts `startLeaseRenewal`) and is fenced by the claim
 * token either way. Row 56 is conditional on TEST-INF-01 showing Vercel Queues honours sub-second
 * `delaySeconds` (probe: GET /api/probe/delay → topic ppec-delay-probe); if it does not, revert to the row 38
 * parameters (3 s lease, whole-second re-wakes).
 */
export const LEASE_SECONDS = 2;
/** The re-wake published at claim time arrives this long after the claim. Both sides use the app clock (claim and reclaim). */
export const REWAKE_DELAY_SECONDS = LEASE_SECONDS; // reclaim uses claimed_until <= now, so the re-wake lands exactly at expiry
/** Extra wait added when a wake has to re-publish itself, so the next one cannot land before the lease expires. */
export const REWAKE_MARGIN_MS = 250;
/** A handler renews its lease this often; two renewals fit in every lease, so one lost renewal is not fatal. */
export const LEASE_RENEW_EVERY_MS = (LEASE_SECONDS * 1000) / 2;
export const MAX_ATTEMPTS = 5;
/** Queue redelivery backoff after a handler failure (route.ts): 2 s, 4 s, 8 s, … capped. */
export const RETRY_BASE_SECONDS = 2;
export const RETRY_MAX_SECONDS = 60;

/*
 * ── Vercel Queues delivery contract (Athena's research, PR #21) and how we configure it ──────────────
 * Queues (Beta) gives us: **at-least-once** delivery, **no ordering guarantee**, and **no delay SLA** —
 * `delaySeconds` is a "not before" floor, not an appointment. Everything below is therefore tuning, not
 * correctness: correctness comes from the guarded claim + the (dueAt, version) fence in runner.ts, which
 * make a duplicate, an out-of-order, and a very late delivery all no-ops. The default redelivery interval
 * is **60 s**, which is 12× the NFR-03 bar, so we override it.
 *
 * Only three knobs exist in @vercel/queue 0.8.0 (checked against node_modules/@vercel/queue/dist/index.d.ts):
 *   1. `retryAfterSeconds` — per-trigger, in vercel.json. QUEUE_RETRY_AFTER_SECONDS below.
 *   2. `visibilityTimeoutSeconds` — per-consumer, passed to `handleCallback`. QUEUE_VISIBILITY_TIMEOUT_SECONDS.
 *   3. `retry(err, meta)` — per-consumer callback returning `{ afterSeconds }` or `{ acknowledge: true }`.
 * There is **no `maxDeliveries` option** (and no `maxAttempts`, and no DLQ) anywhere in the package, so the
 * bound is enforced by us, in the `retry` callback, off `meta.deliveryCount` — see MAX_DELIVERIES.
 */

/**
 * vercel.json `retryAfterSeconds` for the timer trigger: the interval Queues waits before redelivering a
 * message whose handler threw and returned no `retry` directive. Set to the claim lease so the floor matches
 * the recovery window we designed around (ledger row 56) instead of the 60 s default, which would park a
 * failed timer 12× past the NFR-03 bar. Our `retry` callback normally supplies an explicit `afterSeconds`
 * (redeliveryDelaySeconds), so this is the fallback for paths that bypass it.
 *
 * Unverified: the Queues docs give no minimum for `retryAfterSeconds` and the SDK does not validate it (it
 * only forwards the vercel.json value, index.mjs `findRetryAfterSeconds`), so the platform may clamp 2 s up.
 * TEST-INF-01 reads the real interval off the function logs; if it is clamped, the sweeper is still the backstop.
 */
export const QUEUE_RETRY_AFTER_SECONDS = LEASE_SECONDS;
/**
 * `visibilityTimeoutSeconds` for the timer consumer: how long Queues hides an in-flight message before
 * assuming the consumer died and redelivering it.
 *
 * **It cannot be set to the 2 s lease.** @vercel/queue 0.8.0 documents `@minimum 30` on every
 * `visibilityTimeoutSeconds` (ReceiveByIdOptions / ReceiveBatchOptions, default 300, max 3600), so 30 is the
 * floor and we take it — a 15× improvement on the 300 s default, but still 15× the lease. This is exactly why
 * Option A does not rely on queue redelivery for crash recovery: the re-wake we publish ourselves at claim
 * time (REWAKE_DELAY_SECONDS) is what recovers a killed consumer inside 5 s. The visibility timeout is the
 * slow outer backstop, below the 60 s sweeper but above the lease.
 */
export const QUEUE_VISIBILITY_TIMEOUT_SECONDS = 30;
/**
 * Hard ceiling on deliveries of one message before we acknowledge it and drop it (the `retry` callback
 * returns `{ acknowledge: true }`). Stands in for the `maxDeliveries` option Queues does not have, and for
 * the DLQ it does not have either: without it a message whose handler throws forever is redelivered until
 * `retentionSeconds` expires, 7 days of wasted invocations on our bill.
 *
 * Above MAX_ATTEMPTS, because the two count different things: `ops.job.attempts` counts handler failures and
 * reaches DEAD (+ RED task) at 5, after which the wake no-ops and is acked anyway. MAX_DELIVERIES only binds
 * failures that never reach the handler (a missing deployment marker, a DB outage), which do not increment
 * attempts. Dropping the message is safe because `ops.job` is the source of truth and the every-minute
 * sweeper re-arms it; nothing is lost, we just stop paying for a hot loop.
 */
export const MAX_DELIVERIES = 8;

/**
 * Delay for a re-wake that arrived while the lease was still live (queue jitter, or clock skew between the
 * claiming and the waking instance): the rest of the lease plus REWAKE_MARGIN_MS, because a reclaim needs
 * `claimed_until <= now` and would otherwise no-op and leave recovery to the 1-minute sweep (Veri #10, blocker 1).
 * Fractional seconds with millisecond precision (ledger row 56): rounding up to whole seconds added up to
 * ~1 s per hop and put the early-arrival path over the NFR-03 bar. Conditional on TEST-INF-01 confirming
 * Vercel Queues honours sub-second `delaySeconds`; if it floors them, revert to the row 38 parameters
 * (whole seconds, 3 s lease).
 */
export function rewakeDelaySeconds(remainingLeaseMs: number) {
  return Math.ceil(Math.max(0, remainingLeaseMs) + REWAKE_MARGIN_MS) / 1000;
}

/**
 * Bounded exponential backoff for queue redelivery after a handler failure. `deliveryCount` starts at 1
 * (@vercel/queue `MessageMetadata`). Without it Queues redelivers at once and a few seconds of DB or provider
 * trouble burns all MAX_ATTEMPTS attempts and marks the job DEAD (Veri #10, point 3).
 */
export function redeliveryDelaySeconds(deliveryCount: number) {
  return Math.min(RETRY_MAX_SECONDS, RETRY_BASE_SECONDS * 2 ** Math.max(0, Math.floor(deliveryCount) - 1));
}

/**
 * What the consumer's `retry` callback returns to Queues for the Nth delivery of a message whose handler
 * threw: back off exponentially, then stop at MAX_DELIVERIES by acknowledging. `{ acknowledge: true }` is
 * the package's only way to bound redelivery (there is no `maxDeliveries` option and no DLQ) — see
 * MAX_DELIVERIES for why dropping the message loses nothing.
 */
export function queueRetryDirective(deliveryCount: number): { acknowledge: true } | { afterSeconds: number } {
  if (deliveryCount >= MAX_DELIVERIES) return { acknowledge: true };
  return { afterSeconds: redeliveryDelaySeconds(deliveryCount) };
}

/**
 * What rides on a wake-up. `jobId` says which row; `dueAt` + `version` are the **fence**: the generation of
 * that row the message was published for. Queues is at-least-once and unordered with no delay SLA, so a wake
 * can arrive twice, out of order, or long after the job was cancelled or rescheduled — the fence is what lets
 * the consumer tell those apart from a live wake (see runner.ts `claimForWake`).
 */
export type WakeMessage = { jobId: string; dueAt: string; version: number };

/** A fence read off an incoming message. Both fields optional: a wake published before this field existed, or
 * by the sweeper from the row itself, carries no fence and is judged on the row's state and due time alone. */
export type WakeFence = { dueAt?: string; version?: number };

export interface WakeTransport {
  /** Deliver a WakeMessage to the timer consumer after delaySeconds. At-least-once and unordered is fine. */
  publish(msg: WakeMessage, opts: { delaySeconds: number; idempotencyKey: string }): Promise<void>;
}

export type Clock = () => Date;
export const systemClock: Clock = () => new Date();

export type ScheduleInput = { siteId: string; key: string; kind: string; payload: unknown; dueAt: Date; by: string };
export type JobRow = { id: string; key: string; kind: string; payload: unknown; due_at: Date; state: string; attempts: number; site_id: string; version: number };
/** Every column a handler or the fence needs. Kept in one place so the claim, the sweeper and the re-wake agree. */
export const JOB_COLUMNS = "id, key, kind, payload, due_at, state, attempts, site_id, version";

/**
 * Is this wake-up for a generation of the row that no longer exists? Two independent reasons:
 * - `dueAt` differs ⇒ the job was **rescheduled** after the message was published (reschedule is the only
 *   thing that moves `due_at`, and it bumps `version` with it). Firing now would fire at the wrong time.
 * - the message's `version` is **ahead** of the row's ⇒ a generation the row never reached: a replayed or
 *   forged message, or a clock/ordering fault. Refuse rather than guess.
 *
 * Deliberately **not** `version !== row.version`: the recovery paths (reclaimIfExpired, markFailed) bump
 * `version` while leaving `due_at` alone, so an equality fence would make every crash recovery and every
 * post-failure redelivery a no-op — it would disable Option A. A message whose version is merely *behind*
 * the row is a legitimate retry of the same scheduled firing, and must be allowed through.
 */
export function staleWake(row: { due_at: Date | string; version: number }, fence: WakeFence) {
  if (fence.dueAt !== undefined && new Date(row.due_at).getTime() !== new Date(fence.dueAt).getTime()) return true;
  return fence.version !== undefined && fence.version > row.version;
}

export interface JobScheduler {
  schedule(tx: Exec, afterCommit: (h: () => Promise<void>) => void, input: ScheduleInput): Promise<{ id: string }>;
  cancel(tx: Exec, key: string, by: string): Promise<number>;
  reschedule(tx: Exec, afterCommit: (h: () => Promise<void>) => void, key: string, dueAt: Date, by: string): Promise<{ id: string } | null>;
}

/**
 * Delay for the wake published at schedule time. Millisecond precision, not whole seconds (ledger row 56):
 * rounding up cost up to 1 s of lateness on every job, not just the recovery paths.
 */
export function delayFor(dueAt: Date, now: Date) {
  return Math.min(MAX_DELAY_SECONDS, Math.max(0, Math.ceil(dueAt.getTime() - now.getTime())) / 1000);
}

/**
 * Publish a wake-up and record it; failures leave wake_published_at NULL for the sweeper.
 * The message carries the row's `version` so the consumer can refuse a wake for a superseded generation.
 */
export async function arm(db: Exec, transport: WakeTransport, job: { id: string; dueAt: Date; version: number }, now: Date) {
  if (job.dueAt.getTime() - now.getTime() > MAX_DELAY_SECONDS * 1000) return false; // re-armed later by the sweeper
  await transport.publish({ jobId: job.id, dueAt: job.dueAt.toISOString(), version: job.version },
    { delaySeconds: delayFor(job.dueAt, now), idempotencyKey: `${job.id}:${job.dueAt.toISOString()}` });
  await db.query("UPDATE ops.job SET wake_published_at = now() WHERE id = $1 AND state = 'SCHEDULED'", [job.id]);
  return true;
}

export class VercelQueueScheduler implements JobScheduler {
  constructor(private db: Db, private transport: WakeTransport, private clock: Clock = systemClock) {}

  async schedule(tx: Exec, afterCommit: (h: () => Promise<void>) => void, i: ScheduleInput) {
    const id = uuidv7();
    // Partial unique index on live key makes double-schedule fail loudly inside the caller's tx.
    const r = await tx.query<{ version: number }>(
      `INSERT INTO ops.job (id, site_id, key, kind, payload, due_at, created_by, updated_by, source_mode)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7, 'SIMULATED') RETURNING version`,
      [id, i.siteId, i.key, i.kind, JSON.stringify(i.payload ?? {}), i.dueAt.toISOString(), i.by]);
    const version = r.rows[0].version;
    afterCommit(() => arm(this.db, this.transport, { id, dueAt: i.dueAt, version }, this.clock()).then(() => {}));
    return { id };
  }

  async cancel(tx: Exec, key: string, by: string) {
    const r = await tx.query(
      `UPDATE ops.job SET state = 'CANCELED', version = version + 1, updated_at = now(), updated_by = $2
       WHERE key = $1 AND state = 'SCHEDULED' RETURNING id`, [key, by]);
    return r.rows.length; // the queued wake-up still arrives and no-ops
  }

  async reschedule(tx: Exec, afterCommit: (h: () => Promise<void>) => void, key: string, dueAt: Date, by: string) {
    // The version bump plus the new due_at are what make every wake already in flight for this job stale
    // (scheduler.ts `staleWake`), so the old wake is dropped instead of firing the job at the old time.
    const r = await tx.query<{ id: string; version: number }>(
      `UPDATE ops.job SET due_at = $2, wake_published_at = NULL, version = version + 1, updated_at = now(), updated_by = $3
       WHERE key = $1 AND state = 'SCHEDULED' RETURNING id, version`, [key, dueAt.toISOString(), by]);
    const row = r.rows[0];
    if (!row) return null;
    afterCommit(() => arm(this.db, this.transport, { id: row.id, dueAt, version: row.version }, this.clock()).then(() => {}));
    return { id: row.id };
  }
}
