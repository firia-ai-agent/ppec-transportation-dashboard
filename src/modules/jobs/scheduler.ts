/**
 * JobScheduler seam (PRD ADR 1.2, ADR-001). `ops.job` is the source of truth; the wake transport
 * (Vercel Queues now, pg-boss on AWS later; QStash is a Proposed contingency only, not implemented)
 * is just an alarm clock. Exactly-once *effect* comes from the guarded claim, not from the transport.
 */
import { uuidv7 } from "uuidv7";
import type { Db, Exec } from "@/db/exec";

export const MAX_DELAY_SECONDS = 7 * 24 * 3600; // Vercel Queues limit
/**
 * Claim lease (ADR-001, Option A, DECISION-LEDGER row 38 "Accepted by default (Firia, within founder locks)",
 * Firia → Rudy relay 2026-10-14): short, so a consumer that dies after claiming is recovered within the 5 s bar.
 * Handlers are DB-only and short; one that outlives the lease renews it (runner.ts `startLeaseRenewal`) and is
 * fenced by the claim token either way.
 */
export const LEASE_SECONDS = 3;
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

/**
 * Delay for a re-wake that arrived while the lease was still live (queue jitter, or clock skew between the
 * claiming and the waking instance): the rest of the lease plus REWAKE_MARGIN_MS, because a reclaim needs
 * `claimed_until <= now` and would otherwise no-op and leave recovery to the 1-minute sweep (Veri #10, blocker 1).
 * Whole seconds, rounded up: `delaySeconds` reaches Vercel Queues as the `Vqs-Delay-Seconds` header and
 * sub-second precision is Unverified (ADR-001 Evidence), so a fractional value the server floors could arrive
 * early again. The 1 s floor also bounds how fast a run of early arrivals can re-publish.
 */
export function rewakeDelaySeconds(remainingLeaseMs: number) {
  return Math.max(1, Math.ceil((Math.max(0, remainingLeaseMs) + REWAKE_MARGIN_MS) / 1000));
}

/**
 * Bounded exponential backoff for queue redelivery after a handler failure. `deliveryCount` starts at 1
 * (@vercel/queue `MessageMetadata`). Without it Queues redelivers at once and a few seconds of DB or provider
 * trouble burns all MAX_ATTEMPTS attempts and marks the job DEAD (Veri #10, point 3).
 */
export function redeliveryDelaySeconds(deliveryCount: number) {
  return Math.min(RETRY_MAX_SECONDS, RETRY_BASE_SECONDS * 2 ** Math.max(0, Math.floor(deliveryCount) - 1));
}

export interface WakeTransport {
  /** Deliver {jobId, dueAt} to the timer consumer after delaySeconds. At-least-once is fine. */
  publish(msg: { jobId: string; dueAt: string }, opts: { delaySeconds: number; idempotencyKey: string }): Promise<void>;
}

export type Clock = () => Date;
export const systemClock: Clock = () => new Date();

export type ScheduleInput = { siteId: string; key: string; kind: string; payload: unknown; dueAt: Date; by: string };
export type JobRow = { id: string; key: string; kind: string; payload: unknown; due_at: Date; state: string; attempts: number; site_id: string };

export interface JobScheduler {
  schedule(tx: Exec, afterCommit: (h: () => Promise<void>) => void, input: ScheduleInput): Promise<{ id: string }>;
  cancel(tx: Exec, key: string, by: string): Promise<number>;
  reschedule(tx: Exec, afterCommit: (h: () => Promise<void>) => void, key: string, dueAt: Date, by: string): Promise<{ id: string } | null>;
}

export function delayFor(dueAt: Date, now: Date) {
  return Math.min(MAX_DELAY_SECONDS, Math.max(0, Math.ceil((dueAt.getTime() - now.getTime()) / 1000)));
}

/** Publish a wake-up and record it; failures leave wake_published_at NULL for the sweeper. */
export async function arm(db: Exec, transport: WakeTransport, job: { id: string; dueAt: Date }, now: Date) {
  if (job.dueAt.getTime() - now.getTime() > MAX_DELAY_SECONDS * 1000) return false; // re-armed later by the sweeper
  await transport.publish({ jobId: job.id, dueAt: job.dueAt.toISOString() },
    { delaySeconds: delayFor(job.dueAt, now), idempotencyKey: `${job.id}:${job.dueAt.toISOString()}` });
  await db.query("UPDATE ops.job SET wake_published_at = now() WHERE id = $1 AND state = 'SCHEDULED'", [job.id]);
  return true;
}

export class VercelQueueScheduler implements JobScheduler {
  constructor(private db: Db, private transport: WakeTransport, private clock: Clock = systemClock) {}

  async schedule(tx: Exec, afterCommit: (h: () => Promise<void>) => void, i: ScheduleInput) {
    const id = uuidv7();
    // Partial unique index on live key makes double-schedule fail loudly inside the caller's tx.
    await tx.query(
      `INSERT INTO ops.job (id, site_id, key, kind, payload, due_at, created_by, updated_by, source_mode)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7, 'SIMULATED')`,
      [id, i.siteId, i.key, i.kind, JSON.stringify(i.payload ?? {}), i.dueAt.toISOString(), i.by]);
    afterCommit(() => arm(this.db, this.transport, { id, dueAt: i.dueAt }, this.clock()).then(() => {}));
    return { id };
  }

  async cancel(tx: Exec, key: string, by: string) {
    const r = await tx.query(
      `UPDATE ops.job SET state = 'CANCELED', version = version + 1, updated_at = now(), updated_by = $2
       WHERE key = $1 AND state = 'SCHEDULED' RETURNING id`, [key, by]);
    return r.rows.length; // the queued wake-up still arrives and no-ops
  }

  async reschedule(tx: Exec, afterCommit: (h: () => Promise<void>) => void, key: string, dueAt: Date, by: string) {
    const r = await tx.query<{ id: string }>(
      `UPDATE ops.job SET due_at = $2, wake_published_at = NULL, version = version + 1, updated_at = now(), updated_by = $3
       WHERE key = $1 AND state = 'SCHEDULED' RETURNING id`, [key, dueAt.toISOString(), by]);
    const id = r.rows[0]?.id;
    if (!id) return null;
    afterCommit(() => arm(this.db, this.transport, { id, dueAt }, this.clock()).then(() => {}));
    return { id };
  }
}
