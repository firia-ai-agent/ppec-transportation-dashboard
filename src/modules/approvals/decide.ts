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
 *  2. **moves the ride**, guarded on the plan version read in this same transaction — the write's
 *     own optimistic lock, and nothing else. The proposal's recorded basis is NOT compared to it
 *     (Firia, PR #75): a proposal drafted before a Save is still approvable, because the demo's
 *     own seeded card is exactly that. A plan that moves between this read and this write is the
 *     board's 409 and nothing is written. The bump rides with it, because a change that did not
 *     bump the version would leave the next optimistic write guarded on a lie.
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
 * ID-swap rule). The roles are `APPROVAL_ROLES` from `src/auth/access.ts` — a named constant, read
 * and never derived. They used to be `rolesWhoCanOpen("/exceptions")`, which Veri called a merge
 * blocker and was right to: `/exceptions` stops being a page in the redesign, and a permission read
 * off a row that is being deleted is a permission an unrelated edit can change. The site comes off
 * the approval row and goes through `requireSiteAccess`, so another site's approval id is a uniform
 * **404**, exactly as an id that exists nowhere: a 403 would tell a caller that the id is real.
 *
 * ## The plan write is a port, not a query here
 *
 * An approved change or cancel saves a new plan version through `SetChildPlacement`
 * (`plan-placement-port.ts`) — the board's own writer, which this branch does not have. Production
 * passes `null` and an approval then fails safe: nothing is claimed, nothing is queued, and the
 * coordinator reads "Couldn't update the plan" (Firia's gap-5 ruling, 2026-10-17).
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
import { Forbidden, SiteNotFound, Unauthenticated, requireSiteAccess } from "@/auth/core";
import { APPROVAL_ROLES } from "@/auth/access";
import type { Db, Exec } from "@/db/exec";
import type { Direction } from "@/domain/day/leg";
import { boardPlacementPort, type PlacementBucket, type PlanPlacementPortFor } from "./plan-placement-port";
import { DROPOFF_CHANGE_KIND } from "./dropoff-change";
import { MESSAGE_SEND_KIND } from "./message-send";
import { renderTemplate } from "@/modules/messaging/templates";
import { enqueue, type OutboxTransport } from "@/modules/outbox/outbox";
import { FAMILY_SMS, authorizedContactsForChild } from "@/modules/outbox/policy";

/** The screen these approvals are read and decided on: the "For you" tab of Family texts. */
export const APPROVALS_PAGE = "/family-texts";

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
  /**
   * `proposal ->> 'child_token'` — the child this proposal is about, as an id.
   *
   * Carried so the screen can put the card in the right *thread*. Before S1-2 the card in the
   * thread came from a fixture and the badge over the tab came from these rows, so the two could
   * disagree about what was waiting; one queue answers both now, and this is the column it is
   * keyed on (`family-texts/queue.ts`).
   */
  readonly childToken: string;
  readonly serviceDate: string;
  readonly direction: string;
  /** When the agent wrote the row, epoch ms — the card's "Agent · 3:58 PM" line. */
  readonly draftedAtMs: number;
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
  proposal: DropoffProposal & MessageProposal;
  display_name: string | null;
  /** Absent on the decide path's own read, which does not need it. */
  created_at?: Date | string | null;
};

/**
 * The shape `proposals.messageSend` writes (S1-7). Read defensively, like every other row here: a
 * row outlives the code that wrote it, and a field that is missing is a field this decision does
 * without rather than one it invents.
 */
type MessageProposal = {
  kind?: string;
  tool?: string;
  audience?: string;
  recipient_tokens?: readonly string[];
  child_token?: string | null;
  therapy_session_id?: string | null;
  trip_leg_id?: string | null;
  channel?: string;
  purpose?: string;
  recipient_rule?: string;
  template_id?: string;
  vars?: Record<string, unknown>;
};

/** The shape `proposals.dropoffChange` writes. Read defensively: a row outlives the code that wrote it. */
type DropoffProposal = {
  kind?: string;
  leg_id?: string;
  child_token?: string;
  service_date?: string;
  direction?: string;
  /**
   * `plan_run.version` for this date and leg at the moment the proposal was written — the
   * counter the BOARD guards (0009), recorded as provenance and **not checked here**.
   *
   * Firia's PR #75 ruling: no plan-version check in `decideApproval`. The write's own optimistic
   * lock is the guard — `setChildPlacement` is given the version read in the same transaction, so
   * a plan that moves between this decision's read and its write is still the board's own 409.
   * What this field does NOT do is refuse a proposal for being older than the plan: the demo's
   * own seeded row carries the basis from a day with no `plan_run` (`demo/approval-seed.ts`), and
   * a staff Auto-plan + Save before the coordinator presses Approve must not make the one card the
   * walked demo opens on undecidable.
   *
   * Not `trip_leg.plan_version`, which is what the field used to hold (Veri's S1-3.2: "two
   * different counters"). It is optional because rows written before the rename carry neither,
   * and nothing reads it to decide anything.
   */
  plan_run_version_basis?: number;
  requested_dropoff_time?: string | null;
  /** True when the family asked for the ride to be cancelled rather than moved (bucket ABSENT). */
  cancel?: boolean;
  stop_token?: string | null;
  rationale_code?: string;
  template_id?: string;
  vars?: Record<string, unknown>;
};

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
    `SELECT a.id, a.site_id, a.decided_at, a.proposal, a.created_at, c.display_name
     FROM ops.approval_request a
     LEFT JOIN ops.child_profile c
       ON c.child_token = (a.proposal ->> 'child_token')::uuid AND c.site_id = a.site_id
     WHERE a.site_id = ANY($1::uuid[]) AND a.decided_at IS NULL
       AND a.proposal ->> 'kind' IN ($2, $3)
     ORDER BY a.created_at, a.id`,
    /*
     * Both decidable kinds, named rather than "everything undecided": the other `propose_*` tools
     * write rows of their own shape, and a screen that rendered a manifest reallocation through
     * this card would be guessing at what its text says. They stay on the board as tasks until
     * their own cards land (B-12).
     */
    [siteIds, DROPOFF_CHANGE_KIND, MESSAGE_SEND_KIND],
  );
  return r.rows.map(viewOf);
}

function viewOf(row: ApprovalRow): PendingApproval {
  const p = row.proposal ?? {};
  return {
    id: row.id,
    childLabel: row.display_name ?? "",
    childToken: String(p.child_token ?? ""),
    serviceDate: String(p.service_date ?? ""),
    direction: String(p.direction ?? ""),
    draftedAtMs: msOf(row.created_at),
    text: bodyOf(p, null, row.display_name),
    templateId: String(p.template_id ?? ""),
    vars: p.vars ?? {},
    requestedTime: p.requested_dropoff_time ?? null,
    stopToken: String(p.stop_token ?? ""),
    rationaleCode: String(p.rationale_code ?? ""),
  };
}

/**
 * When the row was written, as epoch ms. `0` for a row whose timestamp cannot be read, which the
 * card renders as no "drafted at" line rather than as the epoch.
 */
function msOf(at: Date | string | null | undefined): number {
  if (at === null || at === undefined) return 0;
  const ms = at instanceof Date ? at.getTime() : new Date(at).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * The words, through the outbox's own renderer — never a string stored at proposal time.
 *
 * `overrideTime` is the Edit control: a coordinator who moves the time sees the sentence they are
 * about to approve, not the one the agent drafted. One renderer, so what is read and what is sent
 * are the same words whichever of the two produced the time in them.
 */
export function bodyOf(
  proposal: DropoffProposal,
  overrideTime?: string | null,
  child?: string | null,
): string {
  const templateId = String(proposal.template_id ?? "");
  if (!templateId) return "";
  const vars = { ...(proposal.vars ?? {}) };
  if (overrideTime) vars.eta = overrideTime;
  try {
    /*
     * A staff surface: the child's name in the sentence, and no STOP/HELP footer or `[DEMO]` tag
     * — those are appended by the send pipeline and belong on a family's phone, not in a bubble
     * or on the card (Firia, 2026-10-17 10:51 PM ET). The words either side of them are the same
     * words, from the same renderer.
     */
    return renderTemplate(templateId, vars, { child });
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
  /**
   * The exact words the screen showed when the button was pressed (S1-7).
   *
   * Compared to what this row renders now; a mismatch is `MESSAGE_CHANGED` and nothing is sent.
   * Required for a `MESSAGE_SEND` row, where the text is the whole of what is being decided.
   */
  readonly approvedText?: string;
  readonly now: Date;
};

export type DecideResponse =
  | { readonly status: 200; readonly body: { readonly ok: true; readonly decision: ApprovalDecision; readonly text: string; readonly queued: number } }
  | { readonly status: 401 | 403 | 404 | 409 | 422 | 503; readonly body: { readonly ok: false; readonly error: DecideError } };

/** Why a decision did not land. A code: the screen maps it to words (`src/ui/copy.ts`). */
export type DecideError =
  | "SIGN_IN"
  | "NOT_YOUR_ROLE"
  | "NO_SUCH_APPROVAL"
  | "ALREADY_DECIDED"
  | "PLAN_MOVED"
  | "NOT_A_TIME"
  /**
   * The words moved under the person deciding them (S1-7). An edit that re-rendered the message,
   * a copy change deployed while the tab was open, a proposal re-drafted since it was read — all
   * of them answer this, and all of them mean the same thing: read it again and decide again.
   */
  | "MESSAGE_CHANGED"
  /**
   * The board refused to save the plan, or this day's plan has no such child.
   *
   * A real refusal with a reason behind it (`NOT_STARTED` on a day nobody has started,
   * `CHANGED` when somebody saved first, a fit rule, a child this day does not have) — not the
   * absence of a writer: `setChildPlacement` is wired (`plan-placement-port.ts`). Either way it
   * fails safe: the decision is rolled back and the family is not texted (Firia's gap-5 ruling).
   */
  | "PLAN_NOT_SAVED";

/** A 24-hour wall-clock time, the only shape a coordinator's edit may take. */
const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * The plan port this decision writes through (`plan-placement-port.ts`).
 *
 * Injected rather than imported so a test can hand in the board over PGlite, or a fake that
 * refuses, and the production default is the real board. There is no `null` any more: the writer
 * exists, so an approval that cannot save the plan is a refusal the board gave a reason for and
 * not a branch that was never wired.
 */
export type ApprovalDeps = { readonly placement: PlanPlacementPortFor };

export async function decideApproval(
  db: Db,
  transport: OutboxTransport,
  req: DecideRequest,
  deps: ApprovalDeps = { placement: boardPlacementPort() },
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
    await requireSiteAccess(db, req.userId, row.site_id, APPROVAL_ROLES);
  } catch (e) {
    if (e instanceof Unauthenticated) return { status: 401, body: { ok: false, error: "SIGN_IN" } };
    // Another site's id: uniform not-found, so a response cannot be used to find out it is real.
    if (e instanceof SiteNotFound) return { status: 404, body: { ok: false, error: "NO_SUCH_APPROVAL" } };
    if (e instanceof Forbidden) return { status: 403, body: { ok: false, error: "NOT_YOUR_ROLE" } };
    throw e;
  }

  const proposal = row.proposal ?? {};
  const kind = proposal.kind;
  if (kind !== DROPOFF_CHANGE_KIND && kind !== MESSAGE_SEND_KIND) {
    return { status: 404, body: { ok: false, error: "NO_SUCH_APPROVAL" } };
  }
  const text = bodyOf(proposal, req.editedTime ?? null, row.display_name);

  /*
   * THE EXACT TEXT APPROVED (Firia's S1-7 ruling, 2026-10-18).
   *
   * A decision names the words it is a decision about, and they have to be the words this row
   * renders right now. Anything else and "Approve" is a signature on a page that has since
   * changed — an edit the coordinator did not read, a copy change deployed while the tab was
   * open, a proposal that was re-drafted under them.
   *
   * That is also the whole of "an edit resets to pending and needs fresh approval": Edit writes
   * nothing and sends nothing, it re-renders, and the re-rendered words no longer match what the
   * old form carried. The stale press is refused here rather than sending the earlier text.
   *
   * Required for a message approval, where the text IS the thing being decided. Optional for a
   * drop-off change, which also moves a ride, so a caller that carries no text is deciding the
   * change and is held to the version check below instead — but a caller that carries one must
   * be right about it.
   */
  if (req.approvedText !== undefined && req.approvedText !== text) {
    return { status: 409, body: { ok: false, error: "MESSAGE_CHANGED" } };
  }
  if (kind === MESSAGE_SEND_KIND && req.approvedText === undefined) {
    return { status: 409, body: { ok: false, error: "MESSAGE_CHANGED" } };
  }
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

    /*
     * 2a. A MESSAGE, approved. No plan is read, no version is checked, and no plan is written
     *     (Firia's S1-7 ruling): this kind moves nothing, so there is nothing a plan change could
     *     make wrong. What guards it is the claim above — pending to approved exactly once, and a
     *     second presser gets 409 — the exact text checked before the transaction opened, and the
     *     outbox's own re-checks per contact at drain: consent, suppression, and the recipient's
     *     authorization for that child.
     *
     *     The recipients were computed when the proposal was written, from an audience role and a
     *     subject token (`agent/run/exec/followup.ts`), and are stored on the row. The model named
     *     nobody then and nothing here asks it now.
     */
    if (kind === MESSAGE_SEND_KIND) {
      const queued = await queueApprovedMessage(tx, afterCommit, transport, {
        proposal,
        siteId: row.site_id,
        approvalId: row.id,
        now: req.now,
        by,
      });
      return { status: 200, body: { ok: true, decision: req.decision, text, queued } } as const;
    }

    /*
     * 2. Save the plan, through the board's own writer and no other path — the ONE plan write
     *    this decision makes (Firia's gap-5 ruling, and S1-3 on Veri's read).
     *
     * There used to be a second one above this: an `UPDATE ops.trip_leg` that moved
     * `window_start` and bumped `plan_version`. It is gone. Three things were wrong with it and
     * only the third was obvious:
     *
     *  - it was a second writer of the plan, which is the thing gap-5 exists to prevent;
     *  - it guarded on `trip_leg.plan_version`, while the board guards `plan_run.version` (0009).
     *    Two counters for one question, so the guard either always 409'd or passed when it
     *    should not have (Veri S1-3.2);
     *  - a drop-off time is not a leg's `window_start`. The board owns where a child is; the
     *    text says what the family was told.
     *
     * There is no check of the proposal's recorded basis against the plan's version (Firia, PR
     * #75). The plan is read here through the board's own `loadBoard` (`currentPlacement`) and
     * that read's version is handed straight to the write as `expectedVersion`, which is the
     * whole lock: it refuses a plan that moves between this read and this write, and it does not
     * refuse a proposal merely for having been drafted before a Save. A proposal that has gone
     * stale in a way a coordinator should see is a thing the card shows them, not a 409 that
     * makes the row undecidable.
     *
     * A cancel is `ABSENT` for that leg, which is what the board reads absence from and what
     * makes the child show as Absent on it. A change moves nobody — the stop moved and the child
     * rides the van they already rode — so it writes them back into the bucket and van the board
     * already has them in, with that van's real id, which is what
     * `plan_assignment_van_has_vehicle` requires.
     *
     * Anything that refuses — the board, the claim, the enqueue below — rolls the
     * whole decision back: not claimed, not saved, not queued. Never a fake success, and never a
     * text to a family about a change the plan does not have.
     */
    const legId = String(proposal.leg_id ?? "");
    const childToken = String(proposal.child_token ?? "");
    const serviceDate = String(proposal.service_date ?? "");
    const direction = legOf(proposal.direction);
    if (direction === null) throw new PlanNotSaved();
    // The plan write is a step of *this* transaction (see `PlanPlacementPortFor`).
    const plan = deps.placement(tx);
    const current = await plan.currentPlacement({
      siteId: row.site_id,
      serviceDate,
      direction,
      childToken,
    });
    // A child this day's plan does not have. Uniform with every other reason the plan would not
    // take the write: the coordinator is told the plan was not saved, and nothing is sent.
    if (current === null) throw new PlanNotSaved();

    const bucket: PlacementBucket = proposal.cancel === true ? "ABSENT" : current.bucket;
    const saved = await plan.setChildPlacement({
      siteId: row.site_id,
      serviceDate,
      direction,
      childToken,
      bucket,
      vehicleId: bucket === "VAN" ? current.vehicleId : null,
      expectedVersion: current.version,
      // The board stores `saved_by` as the staff user's own id (`app_user`, DATA-MODEL §9.1), not
      // the `staff:…` string the audit columns here carry.
      actor: req.userId ?? null,
      now: req.now,
    });
    if (!saved.ok) throw new PlanNotSaved();

    /*
     * 3. Queue the family's text. The outbox re-checks everything at send time.
     *
     * The leg is READ, not written: the outbox's own staleness rule compares the queued message's
     * `plan_version_basis` to `trip_leg.plan_version` at drain (outbox.ts:219), so the text has
     * to carry the leg's current value. A leg that has gone is a refusal rather than a text about
     * a ride that no longer exists.
     */
    const legRow = await tx.query<{ id: string; child_token: string; plan_version: number }>(
      "SELECT id, child_token, plan_version FROM ops.trip_leg WHERE id = $1 AND site_id = $2",
      [isUuid(legId) ? legId : null, row.site_id],
    );
    const leg = legRow.rows[0];
    if (!leg) throw new PlanMoved(legId);

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
    if (e instanceof PlanNotSaved) return { status: 503, body: { ok: false, error: "PLAN_NOT_SAVED" } } as const;
    throw e;
  });
}

/**
 * QUEUE AN APPROVED MESSAGE — one per recipient, in the decision's own transaction.
 *
 * The same `enqueue` every other send in this app goes through, so every §11.2 egress re-check
 * still happens at drain and not here. Approving does not send; it queues, and the outbox decides.
 *
 * The plan version it carries is the LEG's current one, read now, where the proposal names a leg
 * — the outbox's staleness rule compares it to `trip_leg.plan_version` at drain, so a ride that
 * has been corrected since cancels the text rather than telling a family something that is no
 * longer true. That is not the `plan_run` version check: that one guards a plan write, and this
 * decision makes none.
 *
 * One idempotency key per approval per recipient, so a redelivered action queues nothing new and
 * a second press that somehow got past the claim could still not produce a second text.
 */
async function queueApprovedMessage(
  tx: Exec,
  afterCommit: (h: () => Promise<void>) => void,
  transport: OutboxTransport,
  a: {
    readonly proposal: MessageProposal;
    readonly siteId: string;
    readonly approvalId: string;
    readonly now: Date;
    readonly by: string;
  },
): Promise<number> {
  const p = a.proposal;
  const recipients = Array.isArray(p.recipient_tokens) ? p.recipient_tokens : [];
  const legId = String(p.trip_leg_id ?? "");
  const leg = legId
    ? (
        await tx.query<{ id: string; plan_version: number }>(
          "SELECT id, plan_version FROM ops.trip_leg WHERE id = $1 AND site_id = $2",
          [isUuid(legId) ? legId : null, a.siteId],
        )
      ).rows[0] ?? null
    : null;

  let queued = 0;
  for (const recipientToken of recipients) {
    const sent = await enqueue(tx, afterCommit, transport, {
      siteId: a.siteId,
      purpose: String(p.purpose ?? FAMILY_SMS.purpose),
      recipientRule: String(p.recipient_rule ?? FAMILY_SMS.recipientRule),
      recipientToken,
      channel: (p.channel ?? FAMILY_SMS.channel) as "SMS_1TO1",
      templateId: String(p.template_id ?? ""),
      vars: p.vars ?? {},
      childToken: p.child_token ?? null,
      tripLegId: leg?.id ?? null,
      therapySessionId: p.therapy_session_id ?? null,
      planVersionBasis: leg?.plan_version ?? 0,
      notAfter: new Date(a.now.getTime() + APPROVED_TEXT_NOT_AFTER_MS),
      idempotencyKey: `approval:${a.approvalId}:${recipientToken}`,
      by: a.by,
    });
    if (!sent.duplicate) queued += 1;
  }
  return queued;
}

/**
 * The leg a proposal names, or `null` for a row that names neither.
 *
 * The board writes one leg at a time, so a proposal whose direction is not one of the two is not
 * something to guess at: it is a plan write that cannot be made.
 */
function legOf(direction: string | undefined): Direction | null {
  return direction === "AM" || direction === "PM" ? direction : null;
}

/**
 * The leg the proposal names is not there to text a family about. Rolls the decision back with it.
 *
 * One thrower since PR #75 (the leg read in step 3): the plan's version is no longer compared to
 * the proposal's recorded basis, so "the ride moved" now means the ride is *gone*.
 */
class PlanMoved extends Error {}

/** The plan could not be saved, or there is no writer to save it with. Rolls everything back. */
class PlanNotSaved extends Error {}

/** A uuid, so a non-uuid id is a clean not-found rather than a Postgres cast error. */
function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
