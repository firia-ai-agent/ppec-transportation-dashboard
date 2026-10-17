/**
 * SURF-05's approval half (PRD §14 "Exceptions & Approvals", §11.2 human tier): the proposals a
 * coordinator decides, and what deciding one does.
 *
 * `agent/run/exec/proposals.ts` has written `ops.approval_request` rows since B-08 slice 4 and
 * said in its own header that what was missing was "the approval *surface* that would turn a
 * decision into an applied change". This is that surface's model, for the one proposal kind this
 * change needs it for: `DROPOFF_CHANGE`. The agent proposes and changes nothing; a person reads
 * the requested time and says yes or no; and only then does the ride move.
 *
 * ## Why it exists in *this* change
 *
 * The founder's 2026-10-17 rule is about what happens when the model is **down**. Holding that
 * rule honest needs the other half on the board beside it: the same family text, with the model
 * **up**, must still not change a ride on its own. So "a stubbed model returning a time as
 * structured output produces a proposal, and only a director or a coordinator approving it moves
 * the leg" is the control case, and it needs something that can actually approve.
 *
 * ## What one approval does, in one transaction
 *
 *  1. **Claims the decision.** `UPDATE … WHERE id = $1 AND site_id = $2 AND decided_at IS NULL`,
 *     which is the race the schema comment next to the table names: two coordinators pressing at
 *     once, and the second is told it was already decided rather than applying it twice.
 *  2. **Moves the ride**, guarded on the plan version the proposal was computed against. A leg
 *     whose plan has moved since writes nothing and reports `STALE` — AT-08's rule from the other
 *     side: a manual correction invalidates a pending proposal exactly as it invalidates a queued
 *     message. The version bump rides with the write, or the next optimistic guard would be
 *     reading a number that no longer describes the row.
 *  3. **Marks the exception resolved**, so the board does not keep showing work that is done.
 *
 * Declining writes the decision and nothing else. No ride moves.
 *
 * ## What it deliberately does not do
 *
 * It queues **no message**. Telling the family their ride moved is the outbox's job through a
 * template, and wiring that send is named as a gap in this change's PR body rather than guessed
 * at here — the point under test is that a ride moves only on a human decision, and adding an
 * egress path to prove it would be the one change in this PR that could send something.
 *
 * ## The guards
 *
 * Role **and** tenant, both, and neither inferred from the fact that a button was rendered. The
 * roles come from the one access table — the same row as the page the screen is on, read through
 * `rolesWhoCanOpen` rather than named here, so `src/auth/access.ts` stays the only list of who
 * may do what. The site comes off the approval row and then goes through `requireSiteAccess`, so
 * another site's approval id is a **404** exactly like an id that exists nowhere: a 403 would
 * tell a caller that the id is real.
 */
import { requireSiteAccess, type StaffRole } from "@/auth/core";
import { rolesWhoCanOpen } from "@/auth/access";
import type { Db } from "@/db/exec";
import { DROPOFF_CHANGE_KIND } from "@/modules/agent/run/exec/proposals";
import { SITE_TIME_ZONE } from "@/ui/service-date";

/** The screen these approvals are read on. Its row in the access table decides who may decide. */
export const APPROVALS_PAGE = "/exceptions";

/**
 * The roles that may see and decide one: the page's own row.
 *
 * Read rather than written out, so the screen, the server action and this write cannot disagree,
 * and so the front desk's exclusion is a property of the access table rather than a second rule
 * here that could drift from it. Today that is DIRECTOR and COORDINATOR.
 */
export function approvalRoles(): readonly StaffRole[] {
  return rolesWhoCanOpen(APPROVALS_PAGE);
}

/** Can this role open the approvals surface at all? The rail and the board both ask. */
export function canDecideApprovals(role: StaffRole | null): boolean {
  return role !== null && approvalRoles().includes(role);
}

export type ApprovalDecision = "APPROVED" | "DECLINED";

/** The shape `proposals.dropoffChange` writes. Read defensively: a row outlives the code wrote it. */
type DropoffProposal = {
  kind?: string;
  leg_id?: string | null;
  child_token?: string | null;
  requested_dropoff_time?: string | null;
  plan_version_basis?: number | null;
  rationale_code?: string | null;
};

/** One undecided proposal, as the board shows it. */
export type PendingApproval = {
  readonly id: string;
  readonly siteId: string;
  readonly taskId: string;
  readonly childToken: string | null;
  readonly legId: string | null;
  /** The time being proposed, 24-hour. The only place a requested time comes from. */
  readonly requestedTime: string | null;
  readonly planVersionBasis: number | null;
  readonly rationaleCode: string | null;
};

type ApprovalRow = {
  id: string;
  site_id: string;
  task_id: string;
  decided_at: Date | string | null;
  proposal: DropoffProposal;
};

/**
 * The undecided drop-off proposals at the sites this caller is a member of, oldest first.
 *
 * Only `DROPOFF_CHANGE` rows: the other two `propose_*` tools write approval and change requests
 * of their own shape, and a screen that rendered all of them through one card would be guessing
 * at what a manifest reallocation says. They stay on the board as tasks until their own cards
 * land (B-12).
 */
export async function pendingApprovals(db: Db, siteIds: readonly string[]): Promise<PendingApproval[]> {
  if (siteIds.length === 0) return [];
  const r = await db.query<ApprovalRow>(
    `SELECT a.id, a.site_id, a.task_id, a.decided_at, a.proposal
     FROM ops.approval_request a
     WHERE a.site_id = ANY($1::uuid[])
       AND a.decided_at IS NULL
       AND a.proposal ->> 'kind' = $2
     ORDER BY a.created_at, a.id`,
    [siteIds, DROPOFF_CHANGE_KIND],
  );
  return r.rows.map(toPending);
}

function toPending(row: ApprovalRow): PendingApproval {
  const p = row.proposal ?? {};
  return {
    id: row.id,
    siteId: row.site_id,
    taskId: row.task_id,
    childToken: p.child_token ?? null,
    legId: p.leg_id ?? null,
    requestedTime: p.requested_dropoff_time ?? null,
    planVersionBasis: typeof p.plan_version_basis === "number" ? p.plan_version_basis : null,
    rationaleCode: p.rationale_code ?? null,
  };
}

/**
 * What came of a decision. Everything here is a *business* outcome; an authorization problem is
 * thrown (`Unauthenticated` / `SiteNotFound` / `Forbidden`), because those three have one
 * mapping each and the caller already has to handle them for every other guarded write.
 */
export type DecideResult =
  | { readonly status: "APPLIED"; readonly legId: string; readonly planVersion: number }
  | { readonly status: "DECLINED" }
  | { readonly status: "ALREADY_DECIDED" }
  | { readonly status: "NOT_FOUND" }
  | { readonly status: "STALE" }
  | { readonly status: "UNSUPPORTED" };

export type DecideInput = {
  readonly approvalId: string;
  readonly decision: ApprovalDecision;
  /** The signed-in user. Memberships and role are re-read from the database, never passed in. */
  readonly userId: string | undefined;
  readonly by: string;
};

/**
 * Decide one proposal.
 *
 * The order is the design. The row is read first *only* to learn which site it belongs to; the
 * authorization runs before anything is written; and the write claims the decision before it
 * touches a leg, so a lost race cannot move a ride. A caller who may not decide gets the same
 * answer whether or not they pressed first.
 */
export async function decide(db: Db, input: DecideInput): Promise<DecideResult> {
  const found = await db.query<ApprovalRow>(
    "SELECT id, site_id, task_id, decided_at, proposal FROM ops.approval_request WHERE id = $1",
    [input.approvalId],
  );
  const row = found.rows[0];
  // An id that exists nowhere and an id at a site this caller cannot see read the same from here.
  // `requireSiteAccess` below answers the second with a 404 for the same reason.
  if (!row) return { status: "NOT_FOUND" };

  // Throws Unauthenticated (401), SiteNotFound (404) or Forbidden (403). The front desk is a real
  // member of the site and lands on the third: they may not open /exceptions, so they may not
  // decide what is on it.
  await requireSiteAccess(db, input.userId, row.site_id, approvalRoles());

  if (row.proposal?.kind !== DROPOFF_CHANGE_KIND) return { status: "UNSUPPORTED" };
  if (row.decided_at !== null) return { status: "ALREADY_DECIDED" };

  const proposal = toPending(row);

  return db.tx(async (tx) => {
    const claimed = await tx.query<{ id: string }>(
      `UPDATE ops.approval_request
         SET decision = $3, decided_by = $4, decided_at = now(), updated_by = $5, updated_at = now()
       WHERE id = $1 AND site_id = $2 AND decided_at IS NULL
       RETURNING id`,
      [proposal.id, proposal.siteId, input.decision, input.userId ?? null, input.by],
    );
    if (claimed.rows.length === 0) return { status: "ALREADY_DECIDED" } as const;

    if (input.decision === "DECLINED") {
      await resolveTask(tx, proposal, input.by, "RESOLVED_OVERRIDE");
      return { status: "DECLINED" } as const;
    }

    if (proposal.legId === null || proposal.requestedTime === null) return { status: "UNSUPPORTED" } as const;

    // The ride itself, guarded on the version the proposal was computed against. The new
    // `window_start` is built from the leg's **own** service date and the site's time zone — the
    // proposal carries a wall-clock time, and the day it belongs to is the leg's, not the
    // decider's browser's.
    const moved = await tx.query<{ id: string; plan_version: number }>(
      `UPDATE ops.trip_leg
         SET window_start = ((service_date::text || ' ' || $3)::timestamp AT TIME ZONE $4),
             plan_version = plan_version + 1,
             updated_by = $5, updated_at = now()
       WHERE id = $1 AND site_id = $2 AND plan_version = $6
       RETURNING id, plan_version`,
      [
        proposal.legId,
        proposal.siteId,
        proposal.requestedTime,
        SITE_TIME_ZONE,
        input.by,
        proposal.planVersionBasis,
      ],
    );
    // Nothing written and the decision rolls back with it: a stale proposal must not end up
    // marked decided, or the coordinator loses the ability to decide it against the new plan.
    if (moved.rows.length === 0) throw new StaleProposal();

    await resolveTask(tx, proposal, input.by, "RESOLVED_APPROVED");
    return { status: "APPLIED", legId: moved.rows[0].id, planVersion: moved.rows[0].plan_version } as const;
  }).catch((e) => {
    if (e instanceof StaleProposal) return { status: "STALE" } as const;
    throw e;
  });
}

/** Thrown inside the transaction so a stale proposal rolls the claimed decision back with it. */
class StaleProposal extends Error {}

/**
 * The exception row this proposal put on the board, closed out with the decision.
 *
 * `RESOLVED_APPROVED` / `RESOLVED_OVERRIDE` rather than `CLOSED_VERIFIED`: the `ops.task` check
 * constraint reserves the latter for a row carrying completion evidence, and "a person decided
 * this" is a decision, not evidence that the ride happened.
 */
async function resolveTask(
  tx: { query: Db["query"] },
  proposal: PendingApproval,
  by: string,
  state: "RESOLVED_APPROVED" | "RESOLVED_OVERRIDE",
): Promise<void> {
  await tx.query(
    `UPDATE ops.task SET state = $3, updated_by = $4, updated_at = now()
     WHERE id = $1 AND site_id = $2 AND state IN ('OPEN', 'IN_PROGRESS')`,
    [proposal.taskId, proposal.siteId, state, by],
  );
}
