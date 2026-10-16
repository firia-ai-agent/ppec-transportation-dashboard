/**
 * The per-run lease (PR #35 review **F2**; the §11.1 row "the run is not yet a *queue* job").
 *
 * Before this module, two drivers on one run were bounded by the `(run_id, seq)` unique index and
 * the per-call idempotency key: nothing could happen twice, but two processes could both take model
 * turns on the same run and only find out at the commit. That is a wasted turn, a wasted dollar and
 * a confusing audit trail, and `driveRun`'s docstring said so rather than pretending otherwise.
 * The lease is what the queue slice adds: **one driver at a time**, refused up front.
 *
 * It belongs here, with the thing that *delivers* work, for the reason B-03's claim belongs to its
 * consumer (`jobs/runner.ts claimForWake`) and not to its handlers — and it is deliberately the
 * same shape, down to the refusal-is-a-no-op rule:
 *
 *   SELECT … FOR UPDATE  →  re-check  →  compare-and-set, in **one** transaction.
 *
 * **No schema change.** `ops.agent_run` has no claim columns and is not getting any in this slice
 * (migration 0007 is frozen, and a 0008 is sequenced behind the Neon snapshot swap), so the lease
 * is built from the three columns the row already has:
 *
 *   `state`       — only a QUEUED or RUNNING run is claimable at all. The claim moves it to
 *                   RUNNING through the same edges `RUN_EDGES` already allows, so a lease is not a
 *                   new lifecycle, it is the one the loop already had with a name on it.
 *   `updated_by`  — the **holder slot**: the claim's identity *and* its deadline, because the token
 *                   carries the instant it was taken (`leaseToken`). A release writes `runActor`
 *                   back. A non-token actor in there means nobody holds this run, which is why
 *                   every write the loop makes to the row re-states the token it was driven under
 *                   (`DriveOpts.actor`) instead of standing the claim down mid-drive.
 *   `version`     — the fence on the claim itself: the UPDATE matches the version the re-check
 *                   read, so two deliveries that somehow get past the row lock cannot both win.
 *
 * The deadline rides **in the token** rather than being read off `updated_at`, and that is not
 * decoration. `updated_at` is the audit column: every write to the row moves it, and those writes
 * are stamped `now()` by the database while a lease is arithmetic in the app's clock (as B-03's
 * `claimed_until` is). Mixing the two would make "has this lease expired" depend on the skew
 * between them — and worse, would quietly *renew* a claim every time the loop wrote a prompt hash,
 * which is the one thing an unrenewed lease must not do. In the token, the claim instant is written
 * once, by the claim, and is preserved exactly by every re-stamp.
 *
 * **Why there is no lease renewal, unlike B-03.** A B-03 lease is 2 s because a timer must be
 * recovered inside NFR-03's 5 s, so a handler outlives its lease and has to heartbeat. An agent
 * run has no such bar: the lease here is longer than the agent route's own `maxDuration`, so the
 * platform kills a stuck driver *before* its lease can expire, and an expired lease therefore means
 * a driver that is genuinely gone.
 *
 * The honest residual: a driver that is alive but wedged past the lease (a clock
 * jump, a hung socket the platform does not reap) can be reclaimed while it still believes it is
 * driving. That window is exactly where the pre-lease bounds still do their job — the loop's
 * per-turn claim check ends the losing drive, `commitCall` is fenced on PENDING, and every effect
 * is keyed on the call's idempotency key — so the worst case is the one we had before, not a worse
 * one.
 *
 * Everything here is site-fenced (F3). A run id travels on a queue payload, and a payload is not
 * an authorization: the claim, the release and the drive all carry the site the caller is acting
 * for, and a run belonging to anyone else is refused without being touched.
 */
import { uuidv7 } from "uuidv7";
import type { Db, Exec } from "@/db/exec";
import { type Clock, systemClock } from "@/modules/jobs/scheduler";
import { type RunDeps, type RunResult, driveRun } from "./loop";
import { type RunState, TERMINAL_RUN_STATES, runActor } from "./store";

/**
 * How long a claim is good for, unrenewed.
 *
 * Bigger than the agent route's `maxDuration`: a live driver cannot outlive its lease, because the
 * platform stops the invocation first. So "the lease expired" means "that driver is gone", which is
 * what makes a reclaim safe without a heartbeat.
 */
export const AGENT_RUN_LEASE_SECONDS = 150;

/**
 * The holder slot's grammar: `agent:<runId>:lease:<nonce>@<claimed-at>`, and nothing else in the
 * codebase writes `:lease:` into an actor string.
 */
const LEASE_ACTOR = /:lease:([^@]+)@(\d{4}-\d\d-\d\dT[\d:.]+Z)$/;

/**
 * One claim's identity, written to `ops.agent_run.updated_by`.
 *
 * Three things in one string, because one text column is all this slice has:
 *  - it starts with `runActor(runId)`, so the audit column still reads as "the agent, on this run"
 *    to everything that does not care about leases;
 *  - a per-claim nonce, so two drivers never write the same token — which is what lets a release
 *    and a renewal-free ownership check be fenced on it;
 *  - the instant the claim was taken, which is what it expires from.
 */
export function leaseToken(runId: string, claimedAt: Date, nonce: string = uuidv7()): string {
  return `${runActor(runId)}:lease:${nonce}@${claimedAt.toISOString()}`;
}

/** When the claim in an actor string was taken, or null if it is not a claim at all. */
export function leaseClaimedAt(by: string | null | undefined): Date | null {
  const m = typeof by === "string" ? LEASE_ACTOR.exec(by) : null;
  if (!m) return null;
  const at = new Date(m[2]);
  return Number.isNaN(at.getTime()) ? null : at;
}

/** True for a token `leaseToken` minted: an actor that represents a *held* run. */
export function isLeaseActor(by: string | null | undefined): boolean {
  return leaseClaimedAt(by) !== null;
}

export type RunLease = {
  readonly runId: string;
  readonly siteId: string;
  /** The holder token in `ops.agent_run.updated_by`; the fence on renewing nothing and releasing. */
  readonly token: string;
  /** The run's version after the claim — the generation this driver claimed. */
  readonly version: number;
  /** `claimedAt + AGENT_RUN_LEASE_SECONDS`: after this another driver may reclaim the run. */
  readonly expiresAt: Date;
};

/**
 * Why a run was not claimed. Every one of these is a **no-op** for the caller — nothing about the
 * run is written, and the queue consumer acks — because every one of them is ordinary traffic for
 * an at-least-once, unordered queue rather than an error:
 *
 *   `missing`     no such run (a payload from another environment, a hand-written replay)
 *   `wrong-site`  the run belongs to another tenant than the caller is acting for (F3)
 *   `finished`    SUCCEEDED / FAILED / ABORTED_SUPERSEDED_BY_HUMAN — nothing re-drives it
 *   `parked`      WAITING_TOOL: §11.1 says the timer re-triggers it, not a second delivery
 *   `leased`      another driver holds a live claim — the F2 refusal itself
 *
 * `missing` and `wrong-site` are told apart *in the log*, deliberately, and only there: both are
 * the same silent no-op to whoever delivered the message, so nothing crosses a tenant boundary —
 * the distinction exists because an operator reading our own logs needs it.
 */
export type LeaseRefusal = "missing" | "wrong-site" | "finished" | "parked" | "leased";

export type LeaseOutcome =
  | {
      readonly ok: true;
      readonly lease: RunLease;
      /** True when the claim took a run off a driver whose lease had expired. */
      readonly reclaimed: boolean;
    }
  | {
      readonly ok: false;
      readonly reason: LeaseRefusal;
      /** The state that refused, when there was a row to read one from. */
      readonly state?: RunState;
      /** For `leased`: when the holder's claim runs out, so a caller can log how long it waited. */
      readonly heldUntil?: Date;
    };

export type AcquireOpts = {
  /** The tenant the caller is driving runs for. Never read off the run row (F3). */
  readonly siteId: string;
  readonly now: Date;
  readonly leaseSeconds?: number;
  /** The token to claim with; defaults to a fresh one. Supplied by tests that assert on it. */
  readonly token?: string;
};

type LeaseDbRow = {
  id: string; site_id: string; state: RunState; version: number;
  updated_by: string;
};

/**
 * The live holder of a row, or null when nobody holds it (free, or the claim has run out).
 *
 * `leaseSeconds` is the *reader's*, not the claimer's: the lease length is one constant for a
 * deployment, so the token records when the claim was taken and whoever reads it applies the same
 * number. (The parameter exists so a suite can shorten both ends of that at once.)
 */
function holder(row: LeaseDbRow, now: Date, leaseSeconds: number): { by: string; until: Date } | null {
  const claimedAt = leaseClaimedAt(row.updated_by);
  if (row.state !== "RUNNING" || !claimedAt) return null;
  const until = new Date(claimedAt.getTime() + leaseSeconds * 1000);
  return until.getTime() > now.getTime() ? { by: row.updated_by, until } : null;
}

/**
 * Claim one run for one driver, or say why not.
 *
 * The re-check and the compare-and-set are in the **same transaction**, holding the row lock across
 * both, for the reason `claimForWake` gives: two deliveries that each read "free" and then claimed
 * in a second statement could interleave between the two and both believe they won. With the lock
 * held, exactly one wins and the other reads the winner's claim and is refused `leased`.
 */
export async function acquireRunLease(db: Db, runId: string, opts: AcquireOpts): Promise<LeaseOutcome> {
  const leaseSeconds = opts.leaseSeconds ?? AGENT_RUN_LEASE_SECONDS;
  const claimedAt = opts.now;
  const token = opts.token ?? leaseToken(runId, claimedAt);
  return db.tx(async (tx) => {
    const r = await tx.query<LeaseDbRow>(
      `SELECT id, site_id, state, version, updated_by FROM ops.agent_run WHERE id = $1 FOR UPDATE`,
      [runId],
    );
    const row = r.rows[0];
    if (!row) return { ok: false, reason: "missing" };
    // No `state` on this one, unlike the refusals below it: the row belongs to another tenant, so
    // its state is not ours to carry back even inside the process (policy.ts step 7's rule — a
    // refusal that can be told apart from "no such run" is an existence oracle for every site).
    if (row.site_id !== opts.siteId) return { ok: false, reason: "wrong-site" };
    if (TERMINAL_RUN_STATES.has(row.state)) return { ok: false, reason: "finished", state: row.state };
    // §11.1: a parked run is re-triggered by its timer (which moves it back to QUEUED), so a claim
    // on one now would be the waiting session the PRD forbids, taken by the wrong process.
    if (row.state === "WAITING_TOOL") return { ok: false, reason: "parked", state: row.state };
    const held = holder(row, claimedAt, leaseSeconds);
    if (held) return { ok: false, reason: "leased", state: row.state, heldUntil: held.until };

    // QUEUED → RUNNING (a driver takes a fresh or re-triggered run) and RUNNING → RUNNING (a
    // reclaim after a dead driver) are both already `RUN_EDGES` (store.ts); the lease adds the
    // version fence and the site fence, which is why this is not `setRunState`.
    const u = await tx.query<{ version: number }>(
      `UPDATE ops.agent_run SET state = 'RUNNING', version = version + 1, updated_at = now(), updated_by = $3
       WHERE id = $1 AND site_id = $4 AND version = $2 AND state IN ('QUEUED', 'RUNNING')
       RETURNING version`,
      [runId, row.version, token, opts.siteId],
    );
    const claimed = u.rows[0];
    // Unreachable while the row lock is held; kept because "somebody else got there first" is the
    // only thing a lost compare-and-set can mean, and it is a refusal rather than an error.
    if (!claimed) return { ok: false, reason: "leased", state: row.state };
    return {
      ok: true,
      reclaimed: isLeaseActor(row.updated_by),
      lease: {
        runId,
        siteId: opts.siteId,
        token,
        version: claimed.version,
        expiresAt: new Date(claimedAt.getTime() + leaseSeconds * 1000),
      },
    };
  });
}

/**
 * Stand the claim down: put `runActor` back in the holder slot, so the next driver finds the run
 * free instead of waiting out a lease nobody is using.
 *
 * Fenced on the token **and** the site. A driver whose lease expired and was reclaimed while it was
 * still working therefore cannot release the *new* holder's claim — it matches zero rows and learns
 * it no longer owns the run, which is the same answer `commitCall` gives it one step later.
 *
 * `false` is not an error: it is also what a run that a human took over, or that another driver
 * reclaimed, correctly returns.
 */
export async function releaseRunLease(db: Exec, lease: RunLease): Promise<boolean> {
  const r = await db.query(
    `UPDATE ops.agent_run SET updated_by = $3, updated_at = now()
     WHERE id = $1 AND site_id = $4 AND updated_by = $2 RETURNING id`,
    [lease.runId, lease.token, runActor(lease.runId), lease.siteId],
  );
  return r.rows.length === 1;
}

/** Who holds a run right now, for a log line or an assertion. Site-fenced like everything else. */
export async function runLeaseHolder(
  db: Exec,
  runId: string,
  opts: { siteId: string; now: Date; leaseSeconds?: number },
): Promise<{ by: string; until: Date } | null> {
  const r = await db.query<LeaseDbRow>(
    `SELECT id, site_id, state, version, updated_by FROM ops.agent_run WHERE id = $1 AND site_id = $2`,
    [runId, opts.siteId],
  );
  const row = r.rows[0];
  return row ? holder(row, opts.now, opts.leaseSeconds ?? AGENT_RUN_LEASE_SECONDS) : null;
}

export type LeasedRun =
  | { readonly claimed: false; readonly reason: LeaseRefusal; readonly state?: RunState; readonly heldUntil?: Date }
  | {
      readonly claimed: true;
      readonly reclaimed: boolean;
      readonly result: RunResult;
      /** False when the drive ended on a run this driver no longer held (reclaimed, or taken over). */
      readonly released: boolean;
    };

/**
 * Claim a run, drive it, release it. The whole F2 answer in one function, and the shape B-03's
 * `fire()` has: the claim is the consumer's, the work underneath knows nothing about it.
 *
 * The release is the *drive's* end, not the run's: a run that parked on a timer, succeeded or
 * failed has already left RUNNING, so its claim stopped being one at that moment and the release
 * only tidies the holder slot. The release that matters is the other case — a drive that gave up
 * with the run still RUNNING (a lost commit, a human takeover, a reclaim) — which hands the run
 * straight to the next driver instead of making it wait out a lease.
 *
 * It does not catch what the drive throws. A `driveRun` that throws is a bug or a dead process, and
 * both want the run left exactly as it is: the claim is released on the way out if we still hold
 * it, and if this process is gone the expiry is what frees the run.
 */
export async function driveRunLeased(
  deps: RunDeps,
  runId: string,
  opts: { siteId: string; leaseSeconds?: number },
): Promise<LeasedRun> {
  const clock: Clock = deps.now ?? systemClock;
  const got = await acquireRunLease(deps.db, runId, {
    siteId: opts.siteId,
    now: clock(),
    leaseSeconds: opts.leaseSeconds,
  });
  if (!got.ok) return { claimed: false, reason: got.reason, state: got.state, heldUntil: got.heldUntil };
  try {
    const result = await driveRun(deps, runId, { siteId: opts.siteId, actor: got.lease.token });
    return {
      claimed: true,
      reclaimed: got.reclaimed,
      result,
      released: await releaseRunLease(deps.db, got.lease),
    };
  } catch (e) {
    try {
      await releaseRunLease(deps.db, got.lease);
    } catch {
      /* the lease expiry is the backstop for a release that could not be written */
    }
    throw e;
  }
}
