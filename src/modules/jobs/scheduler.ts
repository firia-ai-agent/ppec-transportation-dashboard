/**
 * JobScheduler seam (PRD ADR 1.2, ADR-001). `ops.job` is the source of truth; the wake transport
 * (Vercel Queues now, pg-boss on AWS later; QStash is a Proposed contingency only, not implemented)
 * is just an alarm clock. Exactly-once *effect* comes from the guarded claim, not from the transport.
 */
import { uuidv7 } from "uuidv7";
import type { Db, Exec } from "@/db/exec";

export const MAX_DELAY_SECONDS = 7 * 24 * 3600; // Vercel Queues limit
/**
 * Claim lease (ADR-001, Option A, DECISION-LEDGER row 58 "Accepted by default (Firia, within founder locks)",
 * Firia → Rudy relay 2026-10-14 14:22 ET — the Option A retune, which supersedes the 3 s lease proposed for
 * row 38 (whose PR #10 was closed unmerged; row 38 itself reached the ledger via main, so row 58 supersedes
 * its parameters rather than editing it)):
 * short, so a consumer that dies after claiming is recovered within the 5 s bar. Handlers are DB-only and
 * short; one that outlives the lease renews it (runner.ts `startLeaseRenewal`) and is fenced by the claim
 * token either way. Row 58 made the lease conditional on TEST-INF-01 showing Vercel Queues honours
 * sub-second `delaySeconds`; **row 60 resolved that conditional the conservative way** (see
 * `wholeSecondDelay` below) and keeps the 2 s lease, because recovery no longer rests on a sub-second hop.
 */
export const LEASE_SECONDS = 2;
/** The re-wake published at claim time arrives this long after the claim. Both sides use the app clock (claim and reclaim). */
export const REWAKE_DELAY_SECONDS = LEASE_SECONDS; // reclaim uses claimed_until <= now, so the re-wake lands exactly at expiry
/** Extra wait added when a wake has to wait out a live lease (inline or by re-publishing), so it cannot act before the lease expires. */
export const REWAKE_MARGIN_MS = 250;
/**
 * How far ahead of `due_at` a delivery may still claim. Queues' `delaySeconds` is a "not before" floor, so a
 * wake should never be early — but the floor is measured on the queue's clock and `due_at` on ours, so small
 * skew between the publishing and the consuming instance shows up as earliness. Anything beyond this is
 * refused as `not-due` by `claimForWake` and re-published by `handleWake` (runner.ts `deferEarlyWake`) rather
 * than dropped. The two have to agree, which is why the slack is one constant and not two literals.
 */
export const EARLY_SLACK_MS = 1_000;
/** A handler renews its lease this often; two renewals fit in every lease, so one lost renewal is not fatal. */
export const LEASE_RENEW_EVERY_MS = (LEASE_SECONDS * 1000) / 2;
/**
 * Inline lease re-check (ADR-001, DECISION-LEDGER row 60). A wake that finds the lease **still live** with at
 * most this much of it left waits it out *inside the same invocation* — sleep to `claimed_until` +
 * REWAKE_MARGIN_MS, re-read the row, and reclaim + fire if the lease lapsed — instead of publishing another
 * wake. That is what replaces the sub-second re-wake hop row 58 assumed: a published delay is now a whole
 * second (`wholeSecondDelay`), so paying a queue hop to cover 1 ms of remaining lease would cost ≥ 1 s plus
 * delivery jitter, while waiting 1 ms + the margin here costs nothing but the invocation we are already in.
 *
 * The bound is the full lease plus the claim slack: a consumer that dies right after claiming leaves at most
 * LEASE_SECONDS of lease behind, and skew between the claiming and the waking instance can add up to
 * EARLY_SLACK_MS to what we see, so **every lease a dead consumer can leave is recovered in one invocation**.
 * Anything longer is a lease a live handler keeps renewing (runner.ts `startLeaseRenewal`) — the job is not at
 * risk there, so the cheap answer (publish a whole-second re-wake and let this invocation go) is the right one.
 */
export const INLINE_RECHECK_MAX_MS = LEASE_SECONDS * 1000 + EARLY_SLACK_MS;
/**
 * How many times one invocation may wait out the lease before giving up and publishing. More than one because
 * a renewal can land while we sleep (a handler that renewed once and then died); a fixed small number because
 * every extra pass is an invocation held open for a handler that is demonstrably alive.
 */
export const INLINE_RECHECK_MAX_ITERATIONS = 3;
/** Worst case time one invocation spends re-checking: iterations × (bound + margin). Must stay under TIMER_CONSUMER_BUDGET_SECONDS. */
export const INLINE_RECHECK_TOTAL_MAX_MS = INLINE_RECHECK_MAX_ITERATIONS * (INLINE_RECHECK_MAX_MS + REWAKE_MARGIN_MS);
/**
 * The timer consumer's own time budget: `maxDuration` in src/app/api/queues/timer/route.ts. A Next.js route
 * segment config has to be a literal, so the route cannot import this; jobs.test.ts pins the two together.
 */
export const TIMER_CONSUMER_BUDGET_SECONDS = 60;
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
 * the recovery window we designed around (ledger row 58) instead of the 60 s default, which would park a
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
 * **Every `delaySeconds` we hand the transport goes through here** (DECISION-LEDGER row 60): a non-negative
 * whole number of seconds, never fractional, never above the 7-day maximum.
 *
 * Why whole seconds. Row 58 made 2 s leases + millisecond re-wake delays conditional on TEST-INF-01 showing
 * that Vercel Queues honours sub-second `delaySeconds`. The client half is settled — @vercel/queue 0.8.0 types
 * it `delaySeconds?: number` and sends `options.delaySeconds.toString()` as the `Vqs-Delay-Seconds` header
 * without validating or rounding — but the **server** half is not: the Queues docs describe the field only as
 * "Delay in seconds" and state no sub-second precision anywhere. An undocumented behaviour of a Beta service
 * is not a thing to put the NFR-03 recovery bound on, so we treat delays as whole-second-only (row 38's
 * granularity) and recover the sub-second part of the lease *inside the invocation* instead
 * (INLINE_RECHECK_MAX_MS). Rounding is **up**: `delaySeconds` is a "not before" floor, and rounding down
 * would ask for a delivery before the thing we are waiting for has happened.
 */
export function wholeSecondDelay(delaySeconds: number) {
  if (!Number.isFinite(delaySeconds)) throw new Error(`delaySeconds must be a finite number, got ${delaySeconds}`);
  return Math.min(MAX_DELAY_SECONDS, Math.max(0, Math.ceil(delaySeconds)));
}

/** Is this value publishable as-is: a whole number of seconds, ≥ 0 and within the Queues maximum? */
export function isWholeSecondDelay(delaySeconds: number) {
  return Number.isInteger(delaySeconds) && delaySeconds >= 0 && delaySeconds <= MAX_DELAY_SECONDS;
}

/**
 * Delay for a re-wake that has to wait out a lease this consumer decided not to wait out inline: the rest of
 * the lease plus REWAKE_MARGIN_MS, rounded **up to a whole second** (never 0, so the next delivery cannot land
 * in the same millisecond), because a reclaim needs `claimed_until <= now` and would otherwise no-op and leave
 * recovery to the 1-minute sweep (Veri #10, blocker 1).
 *
 * Only two paths reach this now (row 60): a lease longer than INLINE_RECHECK_MAX_MS — i.e. one a live handler
 * is renewing — and an inline re-check that ran out of iterations. The early-arrival recovery path, which is
 * what the millisecond precision of row 58 was for, is handled inline instead and pays no queue hop at all.
 */
export function rewakeDelaySeconds(remainingLeaseMs: number) {
  return Math.max(1, wholeSecondDelay((Math.max(0, remainingLeaseMs) + REWAKE_MARGIN_MS) / 1000));
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
  /**
   * Deliver a WakeMessage to the timer consumer after delaySeconds. At-least-once and unordered is fine.
   * `delaySeconds` must satisfy `isWholeSecondDelay` (row 60): fractional delays are not a thing Vercel
   * Queues documents, so every caller rounds up through `wholeSecondDelay`/`rewakeDelaySeconds`/`delayFor`
   * and both implementations check it — the production one normalises and warns, the fake one throws.
   */
  publish(msg: WakeMessage, opts: { delaySeconds: number; idempotencyKey: string }): Promise<void>;
}

export type Clock = () => Date;
export const systemClock: Clock = () => new Date();
/** Injectable `await sleep(ms)`, so the inline lease re-check is deterministic in tests (runner.ts). */
export type Sleep = (ms: number) => Promise<void>;
export const systemSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

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
 * Delay for the wake published at schedule time: whole seconds, rounded up (ledger row 60). Rounding **up**
 * costs this path up to 1 s of lateness — well inside the 5 s bar, since a first wake pays no recovery hop —
 * and is the only safe direction: rounding down would ask Queues to deliver before `due_at`, and a wake more
 * than EARLY_SLACK_MS early cannot claim (runner.ts `claimForWake` → `not-due`), so it would buy lateness
 * rather than save it. All PRD timers are whole-second anyway (T−90, 10 min, 15 min, EOD).
 */
export function delayFor(dueAt: Date, now: Date) {
  return wholeSecondDelay((dueAt.getTime() - now.getTime()) / 1000);
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
