/**
 * SURF-05's approval half (PRD §14 "Exceptions & Approvals", §18.2 steps 9–10, §11.2 human tier;
 * AT-01, AT-09): the proposals a coordinator decides, and what deciding one does.
 *
 * `agent/run/exec/proposals.ts` has written `ops.approval_request` rows since B-08 slice 4 and
 * said so in its own header: "what is still deferred … the approval *surface* that would turn a
 * decision into an applied change". This is that surface's model. The agent raises a proposal and
 * changes nothing; a person reads the exact text the family would get and says yes or no; and
 * only then does anything move.
 *
 * ## What one approval does, in one transaction
 *
 *  1. **claims the decision.** `UPDATE … WHERE id = $1 AND site_id = $2 AND decided_at IS NULL`,
 *     which is the race the schema comment next to the table names: two coordinators pressing at
 *     once, and the second gets 409 ALREADY_DECIDED rather than a second send.
 *  2. **moves the ride**, guarded on the plan version the proposal was computed against. A leg
 *     whose plan has moved since is `409` and nothing is written — AT-08's rule, from the other
 *     side: a manual correction invalidates a queued message, and it invalidates a *pending
 *     proposal* for the same reason. The bump rides with it, because a change that did not bump
 *     the version would leave the next optimistic write guarded on a lie.
 *  3. **queues the family's text**, through the outbox and nothing else. Same template, same vars,
 *     same `enqueue` the agent's own sends use, so every §11.2 egress re-check still happens at
 *     send time: consent, suppression, the recipient's authorization for that child, and the plan
 *     version it was queued against. Approving does not send — it queues, and the outbox decides.
 *
 * Declining writes the decision and nothing else: no ride moves and no message is queued. That is
 * the whole of what "Don't send" means, and `familyTexts.declined` says it on screen.
 *
 * ## The guards
 *
 * Role **and** tenant, both, and neither inferred from the fact that a button was rendered (the
 * ID-swap rule). The roles come from the one access table — the same row as the page the screen is
 * on, read through `rolesWhoCanOpen` rather than named here — and the site comes off the approval
 * row, then goes through `requireSiteAccess`. So another site's approval id is a uniform **404**,
 * exactly as an id that exists nowhere: a 403 would tell a caller that the id is real.
 *
 * Never throws for an authorization problem. Like `modules/demo/reset.ts`, it answers
 * `{status, body}` and the server action maps it, so the screen always has something to say.
 *
 * ## Why this is a module and not the screen's own file
 *
 * Because it queues a message, and `free-text-egress.test.ts` holds a rule about that: **no route
 * and no server action may put a message in the outbox.** Every caller of `enqueue` is a domain
 * module that composes from a template id and codes, and none of them takes copy from a caller —
 * which is what makes "no free text to a family" structural rather than a habit. A decision model
 * that queued from under `src/app/` would have been the first exception to that rule, and the
 * first exception is how a rule stops being one. So it lives here, the screen's action is the thin
 * part that maps a status to a sentence, and the invariant holds for everything.
 */
import { Forbidden, SiteNotFound, Unauthenticated, requireSiteAccess, type StaffRole } from "@/auth/core";
import { rolesWhoCanOpen } from "@/auth/access";
import type { Db, Exec } from "@/db/exec";
import { SITE_TIME_ZONE } from "@/ui/service-date";
import { renderTemplate } from "@/modules/messaging/templates";
import { enqueue, type OutboxTransport } from "@/modules/outbox/outbox";
import { FAMILY_SMS, authorizedContactsForChild } from "@/modules/outbox/policy";

/** The screen these approvals are read on. Its row in the access table decides who may decide. */
export const APPROVALS_PAGE = "/exceptions";

/** The roles that may decide one: the page's own row, so the screen and the write cannot disagree. */
export function approvalRoles(): readonly StaffRole[] {
  return rolesWhoCanOpen(APPROVALS_PAGE);
}

/**
 * How long an approved text stays worth sending. The same bound the ETA notice uses and for the
 * same reason: a message about an afternoon drop-off is worthless the next morning, so the outbox
 * drops it rather than telling a family about a ride that is over (`not_after`).
 */
export const APPROVED_TEXT_NOT_AFTER_MS = 2 * 60 * 60 * 1000;

export type ApprovalDecision = "APPROVED" | "DECLINED";

/** One proposal, as the screen shows it. Staff-facing, so the child is named (COPY-GUIDE §1). */
export type PendingApproval = {
  readonly id: string;
  /** "Noah O." — the label every staff screen uses, off the child's own row. */
  readonly childLabel: string;
  readonly serviceDate: string;
  readonly direction: string;
  /** The exact body the family would get, rendered by the outbox's own renderer. */
  readonly text: string;
  /**
   * The template and the vars the text was rendered from, so the screen can re-render it for an
   * edited time through the same renderer. Carried rather than rebuilt: a second place that knew
   * which template a drop-off change uses would be a second place to get it wrong.
   */
  readonly templateId: string;
  readonly vars: Readonly<Record<string, unknown>>;
  /** The time being proposed, 24-hour, for the Edit control. Null when only the place moved. */
  readonly requestedTime: string | null;
  readonly stopToken: string;
  readonly rationaleCode: string;
};

type ApprovalRow = {
  id: string;
  site_id: string;
  decided_at: Date | string | null;
  proposal: DropoffProposal;
  display_name: string | null;
};

/** The shape `proposals.dropoffChange` writes. Read defensively: a row outlives the code that wrote it. */
type DropoffProposal = {
  kind?: string;
  leg_id?: string;
  child_token?: string;
  service_date?: string;
  direction?: string;
  plan_version_basis?: number;
  requested_dropoff_time?: string | null;
  stop_token?: string | null;
  rationale_code?: string;
  template_id?: string;
  vars?: Record<string, unknown>;
};

const DROPOFF_CHANGE = "DROPOFF_CHANGE";

/**
 * The undecided drop-off proposals at the sites this caller is a member of, oldest first.
 *
 * Only `DROPOFF_CHANGE` rows: the other two `propose_*` tools write approval requests and change
 * requests of their own shape, and a screen that rendered all of them through this one card would
 * be guessing at what a manifest reallocation's text says. They stay on the board as tasks until
 * their own cards land (B-12).
 */
export async function pendingApprovals(db: Exec, siteIds: readonly string[]): Promise<PendingApproval[]> {
  if (siteIds.length === 0) return [];
  const r = await db.query<ApprovalRow>(
    `SELECT a.id, a.site_id, a.decided_at, a.proposal, c.display_name
     FROM ops.approval_request a
     LEFT JOIN ops.child_profile c
       ON c.child_token = (a.proposal ->> 'child_token')::uuid AND c.site_id = a.site_id
     WHERE a.site_id = ANY($1::uuid[]) AND a.decided_at IS NULL
       AND a.proposal ->> 'kind' = $2
     ORDER BY a.created_at, a.id`,
    [siteIds, DROPOFF_CHANGE],
  );
  return r.rows.map(viewOf);
}

function viewOf(row: ApprovalRow): PendingApproval {
  const p = row.proposal ?? {};
  return {
    id: row.id,
    childLabel: row.display_name ?? "",
    serviceDate: String(p.service_date ?? ""),
    direction: String(p.direction ?? ""),
    text: bodyOf(p),
    templateId: String(p.template_id ?? ""),
    vars: p.vars ?? {},
    requestedTime: p.requested_dropoff_time ?? null,
    stopToken: String(p.stop_token ?? ""),
    rationaleCode: String(p.rationale_code ?? ""),
  };
}

/**
 * The words, through the outbox's own renderer — never a string stored at proposal time.
 *
 * `overrideTime` is the Edit control: a coordinator who moves the time sees the sentence they are
 * about to approve, not the one the agent drafted. One renderer, so what is read and what is sent
 * are the same words whichever of the two produced the time in them.
 */
export function bodyOf(proposal: DropoffProposal, overrideTime?: string | null): string {
  const templateId = String(proposal.template_id ?? "");
  if (!templateId) return "";
  const vars = { ...(proposal.vars ?? {}) };
  if (overrideTime) vars.eta = overrideTime;
  try {
    return renderTemplate(templateId, vars);
  } catch {
    // A row whose vars the current copy will not render. Say nothing rather than a broken sentence;
    // the screen shows `approval.draftFailed` and a person writes the reply themselves.
    return "";
  }
}

export type DecideRequest = {
  readonly userId?: string;
  readonly approvalId: string;
  readonly decision: ApprovalDecision;
  /** A time a coordinator typed instead of the one proposed ("Edit"). Null keeps the proposal's. */
  readonly editedTime?: string | null;
  readonly now: Date;
};

export type DecideResponse =
  | { readonly status: 200; readonly body: { readonly ok: true; readonly decision: ApprovalDecision; readonly text: string; readonly queued: number } }
  | { readonly status: 401 | 403 | 404 | 409 | 422; readonly body: { readonly ok: false; readonly error: DecideError } };

/** Why a decision did not land. A code: the screen maps it to words (`src/ui/copy.ts`). */
export type DecideError =
  | "SIGN_IN"
  | "NOT_YOUR_ROLE"
  | "NO_SUCH_APPROVAL"
  | "ALREADY_DECIDED"
  | "PLAN_MOVED"
  | "NOT_A_TIME";

/** A 24-hour wall-clock time, the only shape a coordinator's edit may take. */
const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;

export async function decideApproval(
  db: Db,
  transport: OutboxTransport,
  req: DecideRequest,
): Promise<DecideResponse> {
  if (!req.userId) return { status: 401, body: { ok: false, error: "SIGN_IN" } };
  if (req.editedTime !== undefined && req.editedTime !== null && !CLOCK.test(req.editedTime)) {
    return { status: 422, body: { ok: false, error: "NOT_A_TIME" } };
  }

  const found = await db.query<ApprovalRow>(
    `SELECT a.id, a.site_id, a.decided_at, a.proposal, c.display_name
     FROM ops.approval_request a
     LEFT JOIN ops.child_profile c
       ON c.child_token = (a.proposal ->> 'child_token')::uuid AND c.site_id = a.site_id
     WHERE a.id = $1`,
    [isUuid(req.approvalId) ? req.approvalId : null],
  );
  const row = found.rows[0];
  // An id that exists nowhere and an id this caller may not see answer identically. The membership
  // check below is what makes that true for another site's id; this is the "nowhere" half.
  if (!row) return { status: 404, body: { ok: false, error: "NO_SUCH_APPROVAL" } };

  try {
    await requireSiteAccess(db, req.userId, row.site_id, approvalRoles());
  } catch (e) {
    if (e instanceof Unauthenticated) return { status: 401, body: { ok: false, error: "SIGN_IN" } };
    // Another site's id: uniform not-found, so a response cannot be used to find out it is real.
    if (e instanceof SiteNotFound) return { status: 404, body: { ok: false, error: "NO_SUCH_APPROVAL" } };
    if (e instanceof Forbidden) return { status: 403, body: { ok: false, error: "NOT_YOUR_ROLE" } };
    throw e;
  }

  const proposal = row.proposal ?? {};
  if (proposal.kind !== DROPOFF_CHANGE) {
    return { status: 404, body: { ok: false, error: "NO_SUCH_APPROVAL" } };
  }
  const time = req.editedTime ?? proposal.requested_dropoff_time ?? null;
  const text = bodyOf(proposal, req.editedTime ?? null);
  const by = `staff:${req.userId}`;

  return db.tx(async (tx, afterCommit) => {
    // 1. Claim the decision. The second presser gets 409 and no second send (schema note on the table).
    const claimed = await tx.query<{ id: string }>(
      `UPDATE ops.approval_request
       SET decision = $3, decided_by = $4, decided_at = $5, updated_at = $5, updated_by = $6, version = version + 1
       WHERE id = $1 AND site_id = $2 AND decided_at IS NULL
       RETURNING id`,
      [row.id, row.site_id, req.decision, req.userId, req.now, by],
    );
    if (claimed.rows.length !== 1) {
      return { status: 409, body: { ok: false, error: "ALREADY_DECIDED" } } as const;
    }
    if (req.decision === "DECLINED") {
      // Nothing else. No ride moves and the family is not texted — that is what "Don't send" is.
      return { status: 200, body: { ok: true, decision: req.decision, text, queued: 0 } } as const;
    }

    // 2. Move the ride, guarded on the version the proposal was computed against (AT-08).
    const legId = String(proposal.leg_id ?? "");
    const moved = await tx.query<{ id: string; child_token: string; plan_version: number }>(
      `UPDATE ops.trip_leg
       SET window_start = CASE WHEN $4::text IS NULL THEN window_start
                               ELSE (service_date + $4::time) AT TIME ZONE $7 END,
           plan_version = plan_version + 1, version = version + 1, updated_at = $5, updated_by = $6
       WHERE id = $1 AND site_id = $2 AND plan_version = $3
       RETURNING id, child_token, plan_version`,
      [isUuid(legId) ? legId : null, row.site_id, proposal.plan_version_basis ?? -1, time, req.now, by, SITE_TIME_ZONE],
    );
    if (moved.rows.length !== 1) {
      // The plan moved under the proposal, or the leg is gone. Rolled back by the throw below, so
      // the decision is not claimed either: a coordinator may read the new state and decide again.
      throw new PlanMoved(legId);
    }

    // 3. Queue the family's text. The outbox re-checks everything at send time.
    const leg = moved.rows[0];
    const contacts = await authorizedContactsForChild(tx, {
      siteId: row.site_id,
      childToken: leg.child_token,
      at: req.now,
    });
    let queued = 0;
    for (const recipientToken of contacts) {
      const sent = await enqueue(tx, afterCommit, transport, {
        siteId: row.site_id,
        purpose: FAMILY_SMS.purpose,
        recipientRule: FAMILY_SMS.recipientRule,
        recipientToken,
        channel: FAMILY_SMS.channel,
        templateId: String(proposal.template_id ?? ""),
        vars: { ...(proposal.vars ?? {}), ...(req.editedTime ? { eta: req.editedTime } : {}) },
        childToken: leg.child_token,
        tripLegId: leg.id,
        // The version the ride now has: a later correction makes this text stale, as it should.
        planVersionBasis: leg.plan_version,
        notAfter: new Date(req.now.getTime() + APPROVED_TEXT_NOT_AFTER_MS),
        // One key per approval per contact: a redelivered action queues nothing new.
        idempotencyKey: `approval:${row.id}:${recipientToken}`,
        by,
      });
      if (!sent.duplicate) queued += 1;
    }
    return { status: 200, body: { ok: true, decision: req.decision, text, queued } } as const;
  }).catch((e) => {
    if (e instanceof PlanMoved) return { status: 409, body: { ok: false, error: "PLAN_MOVED" } } as const;
    throw e;
  });
}

/** The ride moved since the proposal was drafted. Rolls the decision back with it. */
class PlanMoved extends Error {}

/** A uuid, so a non-uuid id is a clean not-found rather than a Postgres cast error. */
function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
