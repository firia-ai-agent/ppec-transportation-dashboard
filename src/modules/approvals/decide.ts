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
 * module that composes from a template id and codes. A decision model that queued from under
 * `src/app/` would have been the first exception to that rule, and the first exception is how a
 * rule stops being one. So it lives here, the screen's action is the thin part that maps a status
 * to a sentence, and the invariant holds for everything.
 *
 * ## The one place a person's words reach a family: Edit (user ruling, 2026-10-18)
 *
 * Edit changes the reply's words. They go out as `dropoff.reply`'s `replyText` — the same template
 * and the same var the model's own reply fills — and they are held to the same rule the model's
 * words are (`messaging/reply-text.ts`: no links, numbers, addresses or codes, one short line),
 * checked here, again at enqueue and again at render. So an edited reply is a person filling the
 * one free-text slot the model fills, never a new way to send arbitrary copy. The edit is recorded
 * on the row (`approval_request.edited_text`), beside who decided and when.
 */
import { Forbidden, SiteNotFound, Unauthenticated, requireSiteAccess } from "@/auth/core";
import { APPROVAL_ROLES } from "@/auth/access";
import type { Db, Exec } from "@/db/exec";
import type { Direction } from "@/domain/day/leg";
import { boardPlacementPort, type PlacementBucket, type PlanPlacementPort, type PlanPlacementPortFor } from "./plan-placement-port";
import { refusalLogLine, refusalOf, type Refusal } from "@/modules/changes/refusal";
import { answeredByDecision, raiseNeedsPerson } from "@/modules/agent/needs-person";
import type { BoardView } from "@/modules/plan/store";
import { queueReplanLateNoticesIn } from "@/modules/plan/replan-notices";
import { DROPOFF_CHANGE_KIND, DROPOFF_REPLY_TEMPLATE } from "./dropoff-change";
import { MESSAGE_SEND_KIND } from "./message-send";
import { renderTemplate } from "@/modules/messaging/templates";
import { replyTextIssue } from "@/modules/messaging/reply-text";
import { approval as approvalCopy } from "@/ui/copy";
import { TASK } from "@/domain/machines";
import { transition } from "@/domain/transition";
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
  /** The centre the proposal belongs to (`approval_request.site_id`). */
  readonly siteId: string;
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
  /**
   * The reply's own words, without the template's fixed prefix — what Edit opens with. Null for a
   * card whose words are fixed copy, which therefore has no Edit (`editableReplyOf`).
   */
  readonly replyText: string | null;
  /** The time being proposed, 24-hour. Null when only the place moved. */
  readonly requestedTime: string | null;
  readonly stopToken: string;
  readonly rationaleCode: string;
  /**
   * The one line a coordinator reads about this proposal, in the model's own words
   * (`propose_dropoff_change.alert_text`, stored rendered — names, no tokens). "" for a row that
   * carries none.
   */
  readonly alertText: string;
  /** What Approve does to the route, one line each (ledger #79); empty for a row with none. */
  readonly lines: readonly string[];
};

type ApprovalRow = {
  id: string;
  site_id: string;
  decided_at: Date | string | null;
  task_id?: string;
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
   * What this field does NOT do is refuse a proposal for being older than the plan: a proposal
   * may carry the basis from a day with no `plan_run` (the demo's former seeded row did), and
   * a staff Auto-plan + Save before the coordinator presses Approve must not make the one card the
   * walked demo opens on undecidable.
   *
   * Not `trip_leg.plan_version`, which is what the field used to hold (Veri's S1-3.2: "two
   * different counters"). It is optional because rows written before the rename carry neither,
   * and nothing reads it to decide anything.
   */
  plan_run_version_basis?: number;
  requested_dropoff_time?: string | null;
  /**
   * The route Approve saves with the reply (ledger #79): the moves — each with the agreed time it
   * holds — and any departures, as `modules/changes/plan-change.ts` previewed them.
   */
  plan?: {
    moves?: readonly { readonly child_token: string; readonly bucket: PlacementBucket; readonly van_id?: string | null; readonly not_before?: string }[];
    departures?: Readonly<Record<string, string>>;
  };
  /** What that route does to the day, one line each, for the panel. */
  lines?: readonly string[];
  /** The family's message this proposal answers, when there was one. */
  basis_message_id?: string | null;
  /** True when the family asked for the ride to be cancelled rather than moved (bucket ABSENT). */
  cancel?: boolean;
  stop_token?: string | null;
  rationale_code?: string;
  /**
   * The model's own reply to the parent, when the proposal carries one (Firia, 2026-10-18 11:04 AM
   * ET). Provenance, not a second copy of the words: what is rendered and what is sent is
   * `template_id` + `vars.replyText`, through the one renderer, exactly as every other kind of
   * proposal renders. A reader that wants to know whether a card was drafted or fell back to the
   * fixed template reads this; nothing decides anything on it.
   */
  reply_text?: string;
  /** The model's one line for the coordinator, as stored by the proposal writer. */
  alert_text?: string;
  /** The guardian whose message asked for this change: the receiver Approve records (PPE-98). */
  requested_by_contact?: string | null;
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
    siteId: row.site_id,
    childLabel: row.display_name ?? "",
    childToken: String(p.child_token ?? ""),
    serviceDate: String(p.service_date ?? ""),
    direction: String(p.direction ?? ""),
    draftedAtMs: msOf(row.created_at),
    text: bodyOf(p, null, row.display_name),
    templateId: String(p.template_id ?? ""),
    vars: p.vars ?? {},
    replyText: editableReplyOf(p),
    requestedTime: p.requested_dropoff_time ?? null,
    stopToken: String(p.stop_token ?? ""),
    rationaleCode: String(p.rationale_code ?? ""),
    alertText: typeof p.alert_text === "string" ? p.alert_text : "",
    lines: Array.isArray(p.lines) ? p.lines.filter((l): l is string => typeof l === "string") : [],
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
 * The reply's editable words, or null when this card's words are fixed copy.
 *
 * Only `dropoff.reply` has words of its own — `replyText`, the one free-text slot a template
 * allows. Every other template is fixed copy over codes, so there is nothing a person could edit
 * that the template would carry, and the card offers no Edit.
 */
export function editableReplyOf(proposal: DropoffProposal | MessageProposal): string | null {
  if (String(proposal.template_id ?? "") !== DROPOFF_REPLY_TEMPLATE) return null;
  const words = proposal.vars?.replyText;
  return typeof words === "string" ? words : null;
}

/**
 * The words, through the outbox's own renderer — never a string stored at proposal time.
 *
 * `editedReply` is Edit: the coordinator's words in the reply's own slot (`vars.replyText`), so the
 * card, the decision and the outbox render one sentence from one template. Ignored for a card whose
 * words are fixed copy (`editableReplyOf`), which `decideApproval` refuses before it gets here.
 */
export function bodyOf(
  proposal: DropoffProposal,
  editedReply?: string | null,
  child?: string | null,
): string {
  const vars = { ...(proposal.vars ?? {}) };
  const templateId = String(proposal.template_id ?? "");
  if (!templateId) return "";
  if (typeof editedReply === "string" && templateId === DROPOFF_REPLY_TEMPLATE) vars.replyText = editedReply;
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
  /**
   * The reply's words as a coordinator edited them ("Edit"). Null or absent keeps the model's.
   * Held to the model's own rule (`replyTextIssue`); only a `dropoff.reply` card takes one.
   */
  readonly editedText?: string | null;
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
  | { readonly status: 401 | 403 | 404 | 409 | 422 | 503; readonly body: { readonly ok: false; readonly error: DecideError; readonly refusal?: Refusal } };

/** Why a decision did not land. A code: the screen maps it to words (`src/ui/copy.ts`). */
export type DecideError =
  | "SIGN_IN"
  | "NOT_YOUR_ROLE"
  | "NO_SUCH_APPROVAL"
  | "ALREADY_DECIDED"
  /** Edit on a card whose words are fixed copy: there is no slot for a person's words to go in. */
  | "NOT_EDITABLE"
  /** The edited words break the reply rule: a link, a number, an address, a code, or too long. */
  | "EDIT_NOT_SENDABLE"
  /**
   * The words moved under the person deciding them (S1-7). An edit that re-rendered the message,
   * a copy change deployed while the tab was open, a proposal re-drafted since it was read — all
   * of them answer this, and all of them mean the same thing: read it again and decide again.
   */
  | "MESSAGE_CHANGED"
  /**
   * The plan would not take the change (ledger #80): the board's own reason, and the van and child
   * it names, travel in `refusal` — nothing is claimed, saved or sent, and a person is told.
   */
  | "REFUSED";

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
  // One line, as the reply rule wants it: a line break typed in the box is a space, not a refusal.
  const edited = typeof req.editedText === "string" ? req.editedText.normalize("NFKC").replace(/\s+/g, " ").trim() : null;
  if (edited !== null && replyTextIssue(edited) !== null) {
    return { status: 422, body: { ok: false, error: "EDIT_NOT_SENDABLE" } };
  }

  const found = await db.query<ApprovalRow>(
    `SELECT a.id, a.site_id, a.task_id, a.decided_at, a.proposal, c.display_name
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
  if (edited !== null && editableReplyOf(proposal) === null) {
    return { status: 422, body: { ok: false, error: "NOT_EDITABLE" } };
  }
  const text = bodyOf(proposal, edited, row.display_name);

  /*
   * THE EXACT TEXT APPROVED (Firia's S1-7 ruling, 2026-10-18).
   *
   * A decision names the words it is a decision about, and they have to be the words this row
   * renders right now. Anything else and "Approve" is a signature on a page that has since
   * changed — an edit the coordinator did not read, a copy change deployed while the tab was
   * open, a proposal that was re-drafted under them.
   *
   * An edited reply is its own signature: the words the coordinator typed are the words decided
   * on, so there is nothing older for them to disagree with, and the check is the model's draft
   * only when the decision carries no edit.
   *
   * Required for a message approval, where the text IS the thing being decided. Optional for a
   * drop-off change, which also moves a ride, so a caller that carries no text is deciding the
   * change and is held to the version check below instead — but a caller that carries one must
   * be right about it.
   */
  if (edited === null && req.approvedText !== undefined && req.approvedText !== text) {
    return { status: 409, body: { ok: false, error: "MESSAGE_CHANGED" } };
  }
  if (edited === null && kind === MESSAGE_SEND_KIND && req.approvedText === undefined) {
    return { status: 409, body: { ok: false, error: "MESSAGE_CHANGED" } };
  }
  const by = `staff:${req.userId}`;

  const decided = await db.tx(async (tx, afterCommit) => {
    // 1. Claim the decision. The second presser gets 409 and no second send (schema note on the table).
    const claimed = await tx.query<{ id: string }>(
      `UPDATE ops.approval_request
       SET decision = $3, decided_by = $4, decided_at = $5, updated_at = $5, updated_by = $6, version = version + 1,
           edited_text = $7
       WHERE id = $1 AND site_id = $2 AND decided_at IS NULL
       RETURNING id`,
      [row.id, row.site_id, req.decision, req.userId, req.now, by, req.decision === "APPROVED" ? edited : null],
    );
    if (claimed.rows.length !== 1) {
      return { status: 409, body: { ok: false, error: "ALREADY_DECIDED" } } as const;
    }
    // The exception the proposal was raised on is answered by this decision, whichever way it went —
    // and so is any "needs a person" card a refused press on it raised (ledger #80).
    if (row.task_id) await resolveTask(tx, row.task_id, req.decision, by);
    await answeredByDecision(tx, row.id, (t, id) => resolveTask(t, id, req.decision, by));
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
     * There used to be a second one above this: an inline `UPDATE ops.trip_leg` that moved
     * `window_start` and guarded on `plan_version`. That inline write is gone; the agreed time
     * still reaches the leg, through `applyDropoffPlan` → `setLegDropoffWindow` below, and the
     * route's own hold through `saveRoute`. Three things were wrong with the old write and only
     * the third was obvious:
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
    // The plan half of Approve — the same function the agent rehearsed the card with (ledger #80).
    const applied = await applyDropoffPlan(tx, deps.placement(tx), {
      siteId: row.site_id, proposal, actor: req.userId ?? null, by, now: req.now,
    });
    if (!applied.ok) throw new ChangeRefused(applied.refusal);
    const { leg, contacts } = applied;
    // The families the route made later are told with it, in this same transaction (ledger #79).
    if (applied.routed) {
      await queueReplanLateNoticesIn(tx, afterCommit, transport, {
        siteId: row.site_id, before: applied.routed.before, after: applied.routed.after, now: req.now, by,
      });
    }

    let queued = 0;
    for (const recipientToken of contacts) {
      const sent = await enqueue(tx, afterCommit, transport, {
        siteId: row.site_id,
        purpose: FAMILY_SMS.purpose,
        recipientRule: FAMILY_SMS.recipientRule,
        recipientToken,
        channel: FAMILY_SMS.channel,
        templateId: String(proposal.template_id ?? ""),
        vars: { ...(proposal.vars ?? {}), ...(edited !== null ? { replyText: edited } : {}) },
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
    if (e instanceof ChangeRefused) return { status: 409, body: { ok: false, error: "REFUSED", refusal: e.refusal } } as const;
    throw e;
  });
  /*
   * THE CARD LEAVES ONE LINE SAYING HOW IT WENT (ledger #75 c, #79) — the same field a confirmed
   * change writes (`actions/confirm.ts`), so the bubble's thread ends every card the same way
   * instead of a decided reply simply vanishing from it.
   */
  /*
   * A REFUSED APPROVE IS LOUD (ledger #80): nothing was claimed, saved or sent, so the family is
   * still waiting — a person is told, with the board's own reason and where to fix it, and the log
   * says what happened. The card stays pending for when the cause is fixed.
   */
  if (!decided.body.ok && "refusal" in decided.body && decided.body.refusal) {
    console.warn(refusalLogLine("approve", decided.body.refusal));
    await raiseNeedsPerson(db, {
      siteId: row.site_id,
      messageId: typeof proposal.basis_message_id === "string" ? proposal.basis_message_id : null,
      reason: "refused",
      refusal: decided.body.refusal,
      key: `approval:${row.id}:${decided.body.refusal.reason}`,
      approvalId: row.id,
      by,
    }).catch((e) => console.error("[approve] needs-person not raised", e instanceof Error ? e.message : e));
  }
  if (decided.status === 200) {
    await db.query(
      "UPDATE ops.approval_request SET proposal = proposal || jsonb_build_object('outcome', $2::text) WHERE id = $1",
      [row.id, decisionOutcome(decided.body.decision, decided.body.queued, proposal.lines ?? [])],
    );
  }
  return decided;
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
 * CLOSE THE EXCEPTION THE PROPOSAL WAS RAISED ON — in the decision's own transaction.
 *
 * Every proposal hangs off an `ops.task` (`approval_request.task_id`), and a decided proposal left
 * that task OPEN: still on the board, still in the model's own context as unfinished work. The task
 * machine's staff path is the only way out (`domain/machines.ts`): `OPEN → IN_PROGRESS →
 * RESOLVED_*`, with a snoozed task woken first. Approve is `RESOLVED_APPROVED`; Don't send is the
 * staff overriding the agent, `RESOLVED_OVERRIDE`. `CLOSED_VERIFIED` stays the system's to set.
 *
 * The row is locked before it is read, so the version handed to each `transition` is this
 * transaction's own and a concurrent writer waits rather than racing it. A task already resolved
 * is left as it is.
 */
export async function resolveTask(tx: Exec, taskId: string, decision: ApprovalDecision, by: string): Promise<void> {
  const found = await tx.query<{ state: string; version: number }>(
    "SELECT state, version FROM ops.task WHERE id = $1 FOR UPDATE",
    [taskId],
  );
  const task = found.rows[0];
  if (!task) return;
  type TaskState = (typeof TASK.states)[number];
  let state = task.state as TaskState;
  let version = task.version;
  const step = async (to: TaskState) => {
    ({ version } = await transition(tx, TASK, "ops.task", { id: taskId, version, from: state, to, actor: "S", by }));
    state = to;
  };
  if (state === "SNOOZED") await step("OPEN");
  if (state === "OPEN") await step("IN_PROGRESS");
  if (state === "IN_PROGRESS") await step(decision === "APPROVED" ? "RESOLVED_APPROVED" : "RESOLVED_OVERRIDE");
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
 * THE PLAN HALF OF APPROVING A DROP-OFF CHANGE (ledger #79, #80), on the caller's transaction:
 * the agreed time onto the leg, the route the card showed (or the child kept where they are), and
 * the adult who will receive them. Approve runs it for real; the agent runs it as a rehearsal
 * before it drafts the card (`changes/rehearse.ts`), so a card is only ever a promise Approve can
 * keep. Any step the plan refuses comes back as the board's own `Refusal`, never thrown away.
 */
export async function applyDropoffPlan(
  tx: Exec,
  plan: PlanPlacementPort,
  a: { readonly siteId: string; readonly proposal: DropoffProposal; readonly actor: string | null; readonly by: string; readonly now: Date },
): Promise<
  | { readonly ok: true; readonly leg: { id: string; child_token: string; plan_version: number }; readonly contacts: readonly string[]; readonly routed: { before: BoardView; after: BoardView } | null }
  | { readonly ok: false; readonly refusal: Refusal }
> {
  const { proposal } = a;
  const childToken = String(proposal.child_token ?? "");
  const serviceDate = String(proposal.service_date ?? "");
  const direction = legOf(proposal.direction) ?? "PM";
  const at = { date: serviceDate, leg: direction };
  const refused = async (r: { reason: string; vanId?: string | null; childToken?: string | null }) => ({
    ok: false as const,
    refusal: refusalOf(r, at, await plan.readBoard({ siteId: a.siteId, serviceDate, direction }).catch(() => null)),
  });

  const current = await plan.currentPlacement({ siteId: a.siteId, serviceDate, direction, childToken });
  if (current === null) return refused({ reason: "NOT_THIS_DAY", childToken });

  const route = proposal.cancel !== true && proposal.plan?.moves && proposal.plan.moves.length > 0 ? proposal.plan : null;
  if (!route) {
    // A stop change or a cancel: the child keeps their van, or is marked away for this ride.
    const bucket: PlacementBucket = proposal.cancel === true ? "ABSENT" : current.bucket;
    const saved = await plan.setChildPlacement({
      siteId: a.siteId, serviceDate, direction, childToken, bucket,
      vehicleId: bucket === "VAN" ? current.vehicleId : null,
      expectedVersion: current.version, actor: a.actor, now: a.now,
    });
    if (!saved.ok) return refused(saved);
  }

  // The leg is read, not written, for the text's plan-version basis (the outbox's staleness rule).
  const legRow = await tx.query<{ id: string; child_token: string; plan_version: number }>(
    "SELECT id, child_token, plan_version FROM ops.trip_leg WHERE id = $1 AND site_id = $2",
    [isUuid(String(proposal.leg_id ?? "")) ? proposal.leg_id : null, a.siteId],
  );
  const leg = legRow.rows[0];
  if (!leg) return refused({ reason: "NOT_THIS_DAY", childToken });
  const contacts = await authorizedContactsForChild(tx, { siteId: a.siteId, childToken: leg.child_token, at: a.now });

  // The agreed time onto the leg first, so the route is saved against the window the family holds.
  const agreed = String(proposal.requested_dropoff_time ?? "").trim();
  if (proposal.cancel !== true && agreed !== "") {
    const moved = await plan.setDropoffWindow({ siteId: a.siteId, legId: leg.id, serviceDate, time: agreed, now: a.now, by: a.by });
    if (!moved.ok) return refused({ reason: moved.reason, childToken });
  }

  let routed: { before: BoardView; after: BoardView } | null = null;
  if (route) {
    const saved = await plan.saveRoute({
      siteId: a.siteId, serviceDate, direction,
      moves: (route.moves ?? []).map((m) => ({
        childToken: m.child_token, bucket: m.bucket, vanId: m.van_id ?? null,
        ...(m.not_before ? { notBefore: m.not_before } : {}),
      })),
      departures: route.departures,
      expectedVersion: current.version, actor: a.actor, now: a.now,
    });
    if (!saved.ok) return refused(saved);
    routed = { before: saved.before, after: saved.after };
  }

  // The adult who will be there, when nobody on the child's file may receive them yet (AT-13).
  if (proposal.cancel !== true && direction === "PM" && contacts.length > 0) {
    const onFile = await tx.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM ops.contact_authorization
        WHERE site_id = $1 AND child_token = $2 AND scope = 'RECEIVE_CHILD'
          AND (valid_to IS NULL OR valid_to > $3)`,
      [a.siteId, leg.child_token, a.now],
    );
    if ((onFile.rows[0]?.n ?? 0) === 0) {
      const recorded = await plan.recordReceiver({
        siteId: a.siteId, legId: leg.id, childToken: leg.child_token,
        contactToken: typeof proposal.requested_by_contact === "string" ? proposal.requested_by_contact : null,
        now: a.now, by: a.by,
      });
      if (!recorded.ok) return refused({ reason: recorded.reason, childToken });
    }
  }
  return { ok: true, leg, contacts, routed };
}

/** How a decided reply reads in the agent's thread: what changed on the route, and who was texted. */
function decisionOutcome(decision: ApprovalDecision, queued: number, lines: readonly string[]): string {
  if (decision === "DECLINED") return approvalCopy.declined;
  const said = queued === 0 ? approvalCopy.sentToNobody : approvalCopy.sent;
  return lines.length > 0 ? `${lines.join(". ")}. ${said}` : said;
}

/** The plan would not take the change: the board's own refusal, kept whole. Rolls everything back. */
export class ChangeRefused extends Error {
  constructor(readonly refusal: Refusal) {
    super(`refused ${refusal.reason}`);
  }
}

/** A uuid, so a non-uuid id is a clean not-found rather than a Postgres cast error. */
function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
