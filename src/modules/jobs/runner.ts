/**
 * Timer consumer + sweeper (ADR-001, ARCHITECTURE §6). Both fire through the same guarded claim.
 * Handlers must be DB-only: external effects go through the outbox (ADR-003).
 */
import { uuidv7 } from "uuidv7";
import type { Db, Exec } from "@/db/exec";
import { arm, LEASE_SECONDS, MAX_ATTEMPTS, MAX_DELAY_SECONDS, REWAKE_DELAY_SECONDS, type Clock, type JobRow, type WakeTransport, systemClock } from "./scheduler";

export type Handler = (tx: Exec, job: JobRow) => Promise<void>;
export type Handlers = Record<string, Handler>;
export type FirePath = "QUEUE" | "SWEEPER" | "LOCAL";
export type WakeResult = "fired" | "noop" | "inactive-deployment" | "failed" | "dead";
export type FireOpts = { transport?: WakeTransport };

/** Test-only: a handler throws this to model the process dying after the claim (nothing after the claim runs). */
export class SimulatedCrash extends Error {}

/** Deployment pinning: a consumer on a non-active deployment acks without claiming. */
export async function isActiveDeployment(db: Exec, deploymentId: string) {
  const r = await db.query<{ active_deployment_id: string }>("SELECT active_deployment_id FROM ops.runtime_marker WHERE id = 1", []);
  return r.rows.length === 0 || r.rows[0].active_deployment_id === deploymentId;
}

async function claim(db: Exec, jobId: string, token: string, now: Date) {
  const r = await db.query<JobRow>(
    `UPDATE ops.job SET state = 'CLAIMED', claimed_at = $3, claimed_by = $2,
       claimed_until = $3::timestamptz + make_interval(secs => ${LEASE_SECONDS})
     WHERE id = $1 AND state = 'SCHEDULED' AND due_at <= $3::timestamptz + interval '1 second'
     RETURNING id, key, kind, payload, due_at, state, attempts, site_id`, [jobId, token, now.toISOString()]);
  return r.rows[0];
}

/** An expired lease (dead consumer) goes back to SCHEDULED with attempts+1, or DEAD + RED task after MAX_ATTEMPTS. */
export async function reclaimIfExpired(db: Db, job: Pick<JobRow, "id" | "key" | "kind" | "site_id">, now: Date, by: string): Promise<"reclaimed" | "dead" | "skip"> {
  return db.tx(async (tx) => {
    const r = await tx.query<{ attempts: number }>(
      `UPDATE ops.job SET attempts = attempts + 1, claimed_until = NULL, wake_published_at = NULL,
         state = CASE WHEN attempts + 1 >= ${MAX_ATTEMPTS} THEN 'DEAD'::job_state ELSE 'SCHEDULED'::job_state END,
         last_error = 'lease expired', version = version + 1, updated_at = now(), updated_by = $3
       WHERE id = $1 AND state = 'CLAIMED' AND claimed_until <= $2 RETURNING attempts`, [job.id, now.toISOString(), by]);
    if (!r.rows.length) return "skip";
    if (r.rows[0].attempts >= MAX_ATTEMPTS) { await raiseDeadTask(tx, job, by); return "dead"; }
    return "reclaimed";
  });
}

async function markFailed(db: Db, job: JobRow, err: unknown, by: string, token: string): Promise<WakeResult> {
  const msg = (err instanceof Error ? err.message : String(err)).slice(0, 500);
  return db.tx(async (tx) => {
    const r = await tx.query<{ attempts: number }>(
      `UPDATE ops.job SET attempts = attempts + 1, last_error = $2, claimed_until = NULL, wake_published_at = NULL,
         state = CASE WHEN attempts + 1 >= ${MAX_ATTEMPTS} THEN 'DEAD'::job_state ELSE 'SCHEDULED'::job_state END,
         version = version + 1, updated_at = now(), updated_by = $3
       WHERE id = $1 AND state = 'CLAIMED' AND claimed_by = $4 RETURNING attempts`, [job.id, msg, by, token]);
    const attempts = r.rows[0]?.attempts ?? 0;
    if (attempts >= MAX_ATTEMPTS) {
      await raiseDeadTask(tx, job, by);
      return "dead";
    }
    return "failed";
  });
}

export async function raiseDeadTask(tx: Exec, job: Pick<JobRow, "id" | "key" | "kind" | "site_id">, by: string) {
  await tx.query(
    `INSERT INTO ops.task (id, site_id, category, severity, summary, next_step, completion_predicate, created_by, updated_by, source_mode)
     VALUES ($1, $2, 'TIMER_DEAD', 'RED', $3, 'Check the job and fire or cancel it by hand', $4, $5, $5, 'SIMULATED')`,
    [uuidv7(), job.site_id, `Timer ${job.kind} (${job.key}) failed ${MAX_ATTEMPTS} times`, `job ${job.id} DONE or CANCELED`, by]);
}

/** Claim and run one job. Handler + DONE + fire log commit together, so a crash leaves it CLAIMED (lease reclaims it). */
export async function fire(db: Db, jobId: string, deploymentId: string, handlers: Handlers, path: FirePath, clock: Clock = systemClock, opts: FireOpts = {}): Promise<WakeResult> {
  const now = clock();
  // Claim token fences the finish: a consumer whose lease was reclaimed cannot mark the job DONE.
  const token = `${deploymentId}:${uuidv7()}`;
  const job = await claim(db, jobId, token, now);
  if (!job) return "noop"; // already fired, canceled, rescheduled later, early, or claimed by someone else
  const by = `system:job:${path.toLowerCase()}`;
  // Option A: arm a re-wake for when the lease expires. If this consumer dies, the re-wake reclaims and fires.
  if (opts.transport) {
    try {
      await opts.transport.publish({ jobId: job.id, dueAt: new Date(job.due_at).toISOString() },
        { delaySeconds: REWAKE_DELAY_SECONDS, idempotencyKey: `rewake:${token}` });
    } catch { /* the sweeper still reclaims expired leases */ }
  }
  try {
    await db.tx(async (tx) => {
      const h = handlers[job.kind];
      if (!h) throw new Error(`no handler for kind ${job.kind}`);
      await h(tx, job);
      const done = await tx.query(
        `UPDATE ops.job SET state = 'DONE', fired_at = now(), claimed_until = NULL, version = version + 1, updated_at = now(), updated_by = $2
         WHERE id = $1 AND state = 'CLAIMED' AND claimed_by = $3 RETURNING id`, [job.id, by, token]);
      if (done.rows.length !== 1) throw new Error("lease lost before commit");
      await tx.query(
        `INSERT INTO ops.job_fire_log (job_id, deployment_id, late_ms, path) VALUES ($1, $2, GREATEST(0, (extract(epoch from (clock_timestamp() - $3::timestamptz)) * 1000)::int), $4)`,
        [job.id, deploymentId, new Date(job.due_at).toISOString(), path]);
    });
    return "fired";
  } catch (e) {
    if (e instanceof SimulatedCrash) throw e;
    return markFailed(db, job, e, by, token);
  }
}

/** Queue consumer entry point (/api/queues/timer). */
export async function handleWake(db: Db, msg: { jobId: string }, deploymentId: string, handlers: Handlers, clock: Clock = systemClock, opts: FireOpts = {}): Promise<WakeResult> {
  if (!(await isActiveDeployment(db, deploymentId))) return "inactive-deployment";
  // A re-wake (or redelivery) for a job whose lease expired reclaims it first, then fires through the same claim.
  const j = await db.query<JobRow>(`SELECT id, key, kind, payload, due_at, state, attempts, site_id FROM ops.job WHERE id = $1 AND state = 'CLAIMED'`, [msg.jobId]);
  if (j.rows[0]) {
    const r = await reclaimIfExpired(db, j.rows[0], clock(), "system:job:rewake");
    if (r === "dead") return "dead";
  }
  return fire(db, msg.jobId, deploymentId, handlers, "QUEUE", clock, opts);
}

export type SweepReport = { rearmed: number; reclaimed: number; dead: number; fired: number; republished: number; activated: boolean };

/**
 * Every-minute safety net (/api/cron/sweep). On production Vercel Cron calls it; on previews the
 * harness calls it (DECISION-LEDGER: previews call the sweep route themselves).
 */
export async function sweep(db: Db, transport: WakeTransport, deploymentId: string, handlers: Handlers, clock: Clock = systemClock): Promise<SweepReport> {
  const now = clock();
  const rep: SweepReport = { rearmed: 0, reclaimed: 0, dead: 0, fired: 0, republished: 0, activated: false };

  // 1. First sweep of a new deployment: take over the marker and force every pending wake-up to re-publish.
  const marker = await db.query<{ id: number }>(
    `INSERT INTO ops.runtime_marker (id, active_deployment_id, rearmed_at) VALUES (1, $1, now())
     ON CONFLICT (id) DO UPDATE SET active_deployment_id = EXCLUDED.active_deployment_id, rearmed_at = now()
       WHERE ops.runtime_marker.active_deployment_id <> EXCLUDED.active_deployment_id
     RETURNING id`, [deploymentId]);
  if (marker.rows.length) {
    rep.activated = true;
    const r = await db.query("UPDATE ops.job SET wake_published_at = NULL WHERE state = 'SCHEDULED' RETURNING id", []);
    rep.rearmed = r.rows.length;
  }

  // 2. Expired leases (crashed consumer) go back to SCHEDULED; DEAD after MAX_ATTEMPTS with a RED task.
  const expired = await db.query<JobRow>(
    `SELECT id, key, kind, payload, due_at, state, attempts, site_id FROM ops.job WHERE state = 'CLAIMED' AND claimed_until < $1`, [now.toISOString()]);
  for (const j of expired.rows) {
    const res = await reclaimIfExpired(db, j, now, "system:sweeper");
    if (res === "dead") rep.dead++; else if (res === "reclaimed") rep.reclaimed++;
  }

  // 3. Overdue (more than 5 s past due) SCHEDULED jobs fire directly through the same claim.
  const overdue = await db.query<{ id: string }>(
    `SELECT id FROM ops.job WHERE state = 'SCHEDULED' AND due_at < $1::timestamptz - interval '5 seconds' ORDER BY due_at LIMIT 200`, [now.toISOString()]);
  for (const j of overdue.rows) if ((await fire(db, j.id, deploymentId, handlers, "SWEEPER", clock, { transport })) === "fired") rep.fired++;

  // 4. Pending jobs within the 7-day window that have no live wake-up get one.
  const unarmed = await db.query<{ id: string; due_at: Date }>(
    `SELECT id, due_at FROM ops.job WHERE state = 'SCHEDULED' AND wake_published_at IS NULL
       AND due_at <= $1::timestamptz + make_interval(secs => ${MAX_DELAY_SECONDS}) ORDER BY due_at LIMIT 500`, [now.toISOString()]);
  for (const j of unarmed.rows) {
    try { if (await arm(db, transport, { id: j.id, dueAt: new Date(j.due_at) }, now)) rep.republished++; } catch { /* next sweep retries */ }
  }
  return rep;
}
