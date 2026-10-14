/**
 * JobScheduler seam (PRD ADR 1.2, ADR-001). `ops.job` is the source of truth; the wake transport
 * (Vercel Queues now, pg-boss on AWS later; QStash is a Proposed contingency only, not implemented)
 * is just an alarm clock. Exactly-once *effect* comes from the guarded claim, not from the transport.
 */
import { uuidv7 } from "uuidv7";
import type { Db, Exec } from "@/db/exec";

export const MAX_DELAY_SECONDS = 7 * 24 * 3600; // Vercel Queues limit
export const LEASE_SECONDS = 60;
export const MAX_ATTEMPTS = 5;

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
