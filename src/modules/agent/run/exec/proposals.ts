/**
 * The `human`-tier half of §11.2: `propose_manifest_reallocation` and
 * `propose_contact_or_profile_change`.
 *
 * | Tool | Precondition → effect |
 * |---|---|
 * | `propose_manifest_reallocation(infeasible_vehicle, legs, options, rationale)` | INFEASIBLE/substitution → RED exception + Teams card; **no mutation** |
 * | `propose_contact_or_profile_change(family, category, claim, source_msg)` | any phone/custody/equipment change → change request + exception |
 *
 * These are not executors, and that is the point. The policy engine returns PROPOSAL for every
 * `human`-tier call (policy.ts step 11) and the loop never calls an executor for one — so there is
 * no code path on which a `propose_*` call mutates anything, however the model phrases it. What
 * they do produce is a row for a person to decide from, written in the **same transaction** that
 * commits the PROPOSED call: a `ops.change_request` or an `ops.approval_request`, plus the
 * exception task that puts it on the Exceptions board.
 *
 * Both rows carry `approval_key` — `approvalKey(tool, args)`, the same value the call row's
 * `args_hash` holds — so a human's decision and the exact call it would release are matched on one
 * column rather than by re-serializing arguments and hoping the key order agrees.
 *
 * What is still deferred: the Teams card (B-12) and the approval *surface* that would turn a
 * decision into an applied change. A `PROPOSED` row plus an approval request is the whole of the
 * agent's side of it.
 */
import type { Exec } from "@/db/exec";
import { actionTool } from "../../action-tools";
import { staffActionSummary } from "@/modules/actions/summary";
import {
  DROPOFF_CHANGE_KIND,
  DROPOFF_CHANGE_TASK_CATEGORY,
  DROPOFF_CHANGE_TEMPLATE,
  DROPOFF_REPLY_TEMPLATE,
} from "@/modules/approvals/dropoff-change";
import { isReplyText } from "@/modules/messaging/reply-text";
import { childByKey, stopByKey } from "@/modules/demo/fixtures/standard";
import { modelAlertWords } from "../../alert-words";
import { namedOrNull } from "@/modules/identity/names";
import { agentTasks, fill } from "@/ui/copy";
import { demoTokenForId } from "../scope-tokens";
import { planStoreIn } from "@/modules/plan/store";
import type { Direction } from "@/domain/day/leg";
import {
  CLARIFICATIONS_PER_THREAD_PER_HOUR,
  CLARIFICATION_LIMIT_TASK_CATEGORY,
  CLARIFICATION_PURPOSE,
  CLARIFICATION_RECIPIENT_RULE,
  SEND_FAILURE_TASK_CATEGORY,
  clarificationsInLastHour,
  raiseTask,
} from "./clarify";
import { MESSAGE_SEND_KIND, MESSAGE_SEND_TASK_CATEGORY } from "@/modules/approvals/message-send";
import { STAFF_NOTICE_TASK_CATEGORY, TWO_GUARDIAN_TASK_CATEGORY, resolveFollowup } from "./followup";
import { agentStaffNotice } from "@/ui/copy";
import { triggerLabel } from "../triggers";
import type { CommittedCall } from "../store";
import type { Trigger } from "../triggers";
import { threadRow } from "./effects";
import { effectId, isUuid } from "./effects";
import type { ExecutorDeps } from "./effects";

/** `ops.task.category` for the three proposals. */
export const REALLOCATION_TASK_CATEGORY = "INFEASIBLE";
/** `ops.task.category` for a confirm card the agent prepared (ledger #74 d). */
export const STAFF_ACTION_TASK_CATEGORY = "STAFF_ACTION";
/** `approval_request.proposal.kind` for the same card (a leaf, so client types can name it). */
export { STAFF_ACTION_KIND } from "@/modules/actions/confirm-view";
import { STAFF_ACTION_KIND } from "@/modules/actions/confirm-view";
export const CHANGE_REQUEST_TASK_CATEGORY = "IDENTITY_CHANGE";

/*
 * The drop-off proposal's three names are `@/modules/approvals/dropoff-change`'s, re-exported here
 * so every existing caller of this module is unchanged.
 *
 * They moved because of what importing *this* module costs: it reaches the board's plan store for
 * the version basis, and `plan/store.ts` imports `getNeonDb` as a value — so a module that wanted
 * nothing but the name of a template ended up with a runtime dependency on the database handle.
 * See that file's header for the suite it broke. Three strings should not drag a connection behind
 * them; the file they live in now has no imports at all.
 */
export {
  DROPOFF_CHANGE_KIND,
  DROPOFF_CHANGE_TASK_CATEGORY,
  DROPOFF_CHANGE_TEMPLATE,
} from "@/modules/approvals/dropoff-change";

/**
 * The stop a leg already drops at, as the short token the outbox's copy table keys its place names
 * by — or null when this deployment's data cannot say.
 *
 * `ops.stop_location` holds a label and a lat/lng and **no SMS token**: the token is a property of
 * the outbox's code-owned place table, not of the row. Everywhere else on this path the caller
 * supplies it (`eta-notice.ts` takes `stopToken` from the fixture), but a proposal has no such
 * caller — it is answering a family's text — so it is resolved here, the same demo-only way
 * `run/scope-tokens.ts` resolves everything else: the child's id read back to its fixture key, and
 * the fixture's own stop off that.
 *
 * Demo-only by construction, and null for anything the fixtures do not account for. Null is a
 * refusal upstream rather than a default: the one thing worse than not proposing a drop-off is
 * proposing a place to leave a child that nobody chose.
 */
export function legStopToken(childToken: string): string | null {
  const childKey = demoTokenForId(childToken);
  if (!childKey) return null;
  try {
    const stopKey = childByKey(childKey).stopKey;
    return stopKey ? stopByKey(stopKey).smsToken : null;
  } catch {
    // A token that reads back to a fixture key the roster no longer has. Say nothing rather than guess.
    return null;
  }
}

/** What the loop knows about a proposed call when it commits it. */
export type ProposalInput = {
  readonly runId: string;
  readonly callId: string;
  readonly siteId: string;
  readonly seq: number;
  readonly tool: string;
  /** The stored, policy-sanitized arguments (prose already redacted). */
  readonly args: Record<string, unknown>;
  readonly idempotencyKey: string;
  /** `approvalKey(tool, args)` — what a human signature binds to. */
  readonly approvalKey: string;
  /**
   * This run's committed facts, the same list an executor gets (S1-7).
   *
   * A message proposal needs two of them and can read neither off an argument: which thread this
   * run resolved (so a reply goes back to the guardian who asked) and which leg it touched (so
   * the approved send carries that leg's version). Both are facts the run committed, which is
   * exactly why they are trustworthy — the model never writes to this list.
   */
  readonly committed: readonly CommittedCall[];
  /** What started the run, for the words on a staff task. */
  readonly trigger: Pick<Trigger, "type" | "id">;
  readonly now: Date;
};

/**
 * Writes the rows one proposal implies and returns what should be added to the call's result.
 * Runs inside the transaction that commits the PROPOSED row, so the proposal and the record of it
 * cannot come apart. A tool with no entry here writes nothing, which is why `{}` is a valid answer.
 */
export type ProposalWriter = (tx: Exec, input: ProposalInput) => Promise<Record<string, unknown>>;

export function proposalWriter(_deps: ExecutorDeps): ProposalWriter {
  return async (tx, input) => {
    switch (input.tool) {
      case "propose_contact_or_profile_change":
        return contactOrProfileChange(tx, input);
      case "propose_manifest_reallocation":
        return manifestReallocation(tx, input);
      case "propose_dropoff_change":
        return dropoffChange(tx, input);
      case "send_followup":
      case "request_clarification":
        return messageSend(tx, input);
      default:
        // A confirm card (ledger #74 d, e): an action a person presses, prepared by the agent —
        // human tier always, and any action in a run with nobody to act for (policy proposeOnly).
        return actionTool(input.tool) ? staffAction(tx, input) : {};
    }
  };
}

/**
 * §11.2: "any phone/custody/equipment change → change request + exception". The claim is the
 * family's, in the model's words, already redacted; nothing about the profile or the contact is
 * touched (the prohibitions `edit_approved_profile` and `add_contact_or_relationship` are what
 * forbid even asking).
 */
async function contactOrProfileChange(tx: Exec, input: ProposalInput): Promise<Record<string, unknown>> {
  const familyToken = String(input.args.family_token ?? "");
  const category = String(input.args.category ?? "");
  const claim = String(input.args.claim_summary ?? "");
  const sourceMessageId = String(input.args.source_message_id ?? "");
  const by = `agent:${input.runId}`;

  // The children the change would be about: the change request names its subjects, and a family's
  // children are the subjects of anything said about that family.
  const children = await tx.query<{ child_token: string }>(
    "SELECT child_token FROM ops.child_profile WHERE family_group_id = $1 AND site_id = $2 ORDER BY child_token",
    [isUuid(familyToken) ? familyToken : null, input.siteId],
  );
  const basis = await tx.query<{ id: string }>(
    "SELECT id FROM ops.message WHERE id = $1 AND site_id = $2",
    [isUuid(sourceMessageId) ? sourceMessageId : null, input.siteId],
  );

  const changeRequestId = effectId(input.idempotencyKey, "change-request");
  await tx.query(
    `INSERT INTO ops.change_request (id, site_id, kind, subject_child_tokens, basis_message_id, confidence, payload, status,
       created_by, updated_by, source_mode)
     VALUES ($1, $2, $3, $4::uuid[], $5, NULL, $6::jsonb, 'NEEDS_HUMAN', $7, $7, 'SIMULATED')
     ON CONFLICT (id) DO NOTHING`,
    [
      changeRequestId,
      input.siteId,
      // The §11.2 category, as the kind: PHONE, CUSTODY, EQUIPMENT, RELATIONSHIP, IDENTITY.
      category,
      children.rows.map((r) => r.child_token),
      basis.rows[0]?.id ?? null,
      JSON.stringify({ category, claim_summary: claim, family_token: familyToken, approval_key: input.approvalKey }),
      by,
    ],
  );
  const taskId = await raiseTask(tx, {
    id: effectId(input.idempotencyKey, "exception"),
    siteId: input.siteId,
    category: CHANGE_REQUEST_TASK_CATEGORY,
    severity: "AMBER",
    words: agentTasks.proposedContactChange,
    by,
  });
  return { change_request_id: changeRequestId, exception_task_id: taskId, mutated: false };
}

/**
 * §11.2: "INFEASIBLE/substitution → RED exception + Teams card; no mutation". The options are the
 * model's arithmetic about vehicles and legs it already had in scope; committing one is a staff
 * action through the approval request, and the Teams card that would show it is B-12.
 */
async function manifestReallocation(tx: Exec, input: ProposalInput): Promise<Record<string, unknown>> {
  const by = `agent:${input.runId}`;
  const taskId = await raiseTask(tx, {
    id: effectId(input.idempotencyKey, "exception"),
    siteId: input.siteId,
    category: REALLOCATION_TASK_CATEGORY,
    severity: "RED",
    words: agentTasks.proposedReallocation,
    by,
  });
  const approvalId = effectId(input.idempotencyKey, "approval");
  await tx.query(
    `INSERT INTO ops.approval_request (id, site_id, task_id, proposal, created_by, updated_by, source_mode)
     VALUES ($1, $2, $3, $4::jsonb, $5, $5, 'SIMULATED')
     ON CONFLICT (id) DO NOTHING`,
    [
      approvalId,
      input.siteId,
      taskId,
      JSON.stringify({
        infeasible_vehicle_token: input.args.infeasible_vehicle_token ?? null,
        leg_ids: input.args.leg_ids ?? [],
        options: input.args.options ?? [],
        rationale_code: input.args.rationale_code ?? null,
        approval_key: input.approvalKey,
      }),
      by,
    ],
  );
  return { approval_request_id: approvalId, exception_task_id: taskId, mutated: false };
}

/**
 * §11.2 human tier: a drop-off a family asked for → an approval request and an exception, and no
 * mutation at all. The leg keeps its time and its stop until a coordinator says otherwise.
 *
 * ## The row carries the text, as a template and its variables
 *
 * The approval screen has to show a coordinator **the exact words the family will get** — that is
 * the whole of what they are deciding. The obvious way to do that would be to render the body here
 * and store the string, and it would be wrong: the outbox renders at send time, so a stored string
 * is a second rendering that can drift from the first, and the screen would be showing a text that
 * is merely *like* the one that goes out.
 *
 * So what is stored is the template id and the vars, and the screen renders them through the same
 * `renderTemplate` the outbox uses. One renderer, one set of words, and if the copy changes the
 * screen and the send change together.
 *
 * The vars are read off the **leg row**, not off the call: the date a family is told about is the
 * service date the leg actually has, and the stop is the one being proposed or the one the leg
 * already holds. Nothing a model wrote reaches the body — `dropoff.changed` takes a date, a clock
 * time and a stop token, and no var on it can carry prose (Veri #12).
 */
async function dropoffChange(tx: Exec, input: ProposalInput): Promise<Record<string, unknown>> {
  const legId = String(input.args.leg_id ?? "");
  const requestedTime = input.args.requested_dropoff_time === null ? null : String(input.args.requested_dropoff_time ?? "");
  const requestedStop = input.args.requested_stop_token === null ? null : String(input.args.requested_stop_token ?? "");
  const rationale = String(input.args.rationale_code ?? "");
  const sourceMessageId = String(input.args.source_message_id ?? "");
  const by = `agent:${input.runId}`;
  /*
   * THE MODEL'S REPLY TO THE PARENT, IN NAMES (Firia, 2026-10-18 11:04 AM ET; founder 2026-10-18).
   *
   * The model wrote it in the prompt's tokens ("Hi F2, yes — C2 can be dropped at 5"), because every
   * prompt is token-only; this is where the people come back as the first names the family uses
   * (`identity/names.namedOrNull`, the roster that replaced them). Checked here as well as at the
   * gateway, which already refused a reply that could not be named or breaks the shape: this is the
   * field that becomes the words a family reads.
   *
   * There is NO TEMPLATE BEHIND IT. A reply that does not pass is no proposal at all — the call is
   * recorded as refused and no card is written — because a card worded by this app while the model
   * is up is exactly what the founder ruled out. On the agent's own path it cannot happen: the
   * schema refuses the call first.
   */
  const named = namedOrNull(input.args.reply);
  const reply = named !== null && isReplyText(named) ? named : null;
  if (reply === null) return { proposal_refused: "NO_REPLY_IN_NAMES", mutated: false };

  /*
   * The leg, at this site. A leg at another site cannot be reached — the policy engine's scope
   * check refused it long before this runs — and the `site_id` here says so again, because a
   * writer that trusted the scope check would be the one place the tenant boundary was implied
   * rather than stated (DATA-MODEL §5).
   */
  const leg = await tx.query<{
    id: string; child_token: string; service_date: string; direction: string; plan_version: number;
  }>(
    `SELECT id, child_token, service_date::text AS service_date, direction::text AS direction, plan_version
     FROM ops.trip_leg WHERE id = $1 AND site_id = $2`,
    [isUuid(legId) ? legId : null, input.siteId],
  );
  const row = leg.rows[0];
  if (!row) return { proposal_refused: "NO_SUCH_LEG", mutated: false };

  // The place the family would be told. The proposed stop when there is one, otherwise the one the
  // leg already drops at — and if neither can be named, nothing is proposed at all.
  const stopToken = requestedStop ?? legStopToken(row.child_token);
  if (!stopToken) return { proposal_refused: "NO_STOP_FOR_LEG", mutated: false };

  /*
   * THE VERSION A STAFF APPROVAL WILL BE GUARDED ON: `plan_run.version`, read through the board's
   * own store, for this date and leg.
   *
   * Not `trip_leg.plan_version`, which is what this used to record. The board guards
   * `plan_run.version` (0009) and `setChildPlacement` is what an approval writes through, so a
   * proposal carrying the other counter meant the guard either always 409'd or passed when it
   * should not have (Veri's S1-3.2; Firia's S1-3, 2026-10-17 11:00 PM ET). `loadPlan` is the
   * board's own reader, in this transaction — not a second query of `plan_run`.
   *
   * `0` when no plan has been saved for this date and leg, which is the same `0` `loadBoard`
   * reports and the same one a first save names.
   */
  const direction = legOf(row.direction);
  if (direction === null) return { proposal_refused: "NO_SUCH_LEG", mutated: false };
  const savedPlan = await planStoreIn(tx).loadPlan(input.siteId, row.service_date, direction);
  const planRunVersion = savedPlan?.version ?? 0;

  const basis = await tx.query<{ id: string }>(
    "SELECT id FROM ops.message WHERE id = $1 AND site_id = $2",
    [isUuid(sourceMessageId) ? sourceMessageId : null, input.siteId],
  );

  /*
   * WHAT THE ALERT SAYS: the model's own sentence from this very call (Firia, 2026-10-18 11:15 AM
   * ET), falling back to the named copy line when it wrote nothing fit for a screen. The order and
   * the reasons are `agent/alert-words.ts`; the one thing worth repeating here is that the general
   * "A family asked for a different drop-off" row is gone from this path — the words a coordinator
   * reads beside the thread are now either the model's or the row's own fields, never a sentence
   * about the *kind* of thing this is.
   *
   * `input.args.alert_text` is the policy engine's sanitized copy (`sanitizeStaffText`, a declared
   * `staffTextFields` entry), so a number or an address somebody tried to smuggle into it arrives
   * here already replaced by a class placeholder — and a line carrying one fails `isAlertText` and
   * lands on the fallback rather than on a card.
   */
  const alertWords = modelAlertWords(input.args.alert_text);
  if (alertWords === null) return { proposal_refused: "NO_ALERT_IN_NAMES", mutated: false };

  /*
   * WHO ASKED (PPE-98): the guardian on the thread of the message that started this run. Read off
   * the trigger's own message row, never off an argument the model wrote, and carried on the
   * proposal so Approve records *that* adult as the receiver rather than whichever contact the
   * child's file lists first.
   */
  const asker =
    input.trigger.type === "msg.inbound"
      ? await tx.query<{ counterparty_token: string | null }>(
          `SELECT t.counterparty_token FROM ops.message m
           JOIN ops.conversation_thread t ON t.id = m.thread_id AND t.site_id = m.site_id
           WHERE m.id = $1 AND m.site_id = $2`,
          [isUuid(input.trigger.id) ? input.trigger.id : null, input.siteId],
        )
      : { rows: [] };
  const requestedByContact = asker.rows[0]?.counterparty_token ?? null;

  const taskId = await raiseTask(tx, {
    id: effectId(input.idempotencyKey, "exception"),
    siteId: input.siteId,
    category: DROPOFF_CHANGE_TASK_CATEGORY,
    severity: "AMBER",
    words: { ...agentTasks.proposedDropoffChange, summary: alertWords },
    by,
  });

  const approvalId = effectId(input.idempotencyKey, "approval");
  const proposal = {
    kind: DROPOFF_CHANGE_KIND,
    leg_id: row.id,
    child_token: row.child_token,
    service_date: row.service_date,
    direction: row.direction,
    /**
     * The version a staff approval is guarded on (AT-08: a saved plan invalidates this). It is
     * `plan_run.version` — the board's counter — and the field is named for it, so a row written
     * before Firia's S1-3 ruling cannot be read as if it held the new meaning. `decide.ts`
     * refuses a proposal with no basis on it.
     */
    plan_run_version_basis: planRunVersion,
    requested_dropoff_time: requestedTime,
    /** The stop as proposed, or the one the leg already holds when only the time moved. */
    stop_token: stopToken,
    rationale_code: rationale,
    /**
     * The words on the alert, on the proposal as well as on its task: the card in the bubble is
     * drawn from the approval row, and a reader that had to join back to `ops.task` for the one
     * sentence it shows would be one join away from showing the wrong one. Stored as rendered —
     * names, no tokens — because this field is read by screens and by nothing else.
     */
    alert_text: alertWords,
    /** The guardian whose message asked for this, for Approve's receiver record (PPE-98). */
    requested_by_contact: requestedByContact,
    basis_message_id: basis.rows[0]?.id ?? null,
    /**
     * THE WORDS: the model's reply, through the one renderer the card and the outbox share.
     * `dropoff.reply`'s whole body is `replyText`; `reply_text` beside it is provenance.
     */
    template_id: DROPOFF_REPLY_TEMPLATE,
    reply_text: reply,
    vars: {
      replyText: reply,
      legDate: row.service_date,
      ...(requestedTime ? { eta: requestedTime } : {}),
      stopLabel: stopToken,
    },
    approval_key: input.approvalKey,
  };
  await tx.query(
    `INSERT INTO ops.approval_request (id, site_id, task_id, proposal, created_by, updated_by, source_mode)
     VALUES ($1, $2, $3, $4::jsonb, $5, $5, 'SIMULATED')
     ON CONFLICT (id) DO NOTHING`,
    [approvalId, input.siteId, taskId, JSON.stringify(proposal), by],
  );
  return { approval_request_id: approvalId, exception_task_id: taskId, mutated: false };
}

/**
 * §11.2 `send_followup` and `request_clarification`, as of Firia's S1-7 ruling (2026-10-18): a
 * message a person has to approve, and nothing queued.
 *
 * Both tools used to execute — they resolved an audience and put a text in the outbox on the
 * agent's own authority. Run 7's open question was whether that is what "no free text to a
 * family" is supposed to mean, and the answer is no: a **templated** message is still a message
 * to a family, and goal 4 is that a person decides those. So both are `human` tier with a
 * `propose` effect now, the loop has no executor to reach for (`registry.ts`), and what they
 * write is a `MESSAGE_SEND` row (`modules/approvals/message-send.ts`) for the "For you" tab.
 *
 * ## What the row carries, and what it deliberately does not
 *
 *  - **the recipients, resolved now.** `resolveFollowup` computes them from the audience role and
 *    the subject token, exactly as the executor did — the model never names a person. Storing
 *    them is what lets the card show a coordinator who this actually goes to.
 *  - **the template id and the vars**, so the card and the outbox render the same words through
 *    the same renderer. Never a stored string: a second rendering is a second set of words.
 *  - **the leg**, when the run touched one, so the approved send can read that leg's plan version
 *    at the moment it queues — the outbox's own staleness rule.
 *  - **no `plan_run_version_basis`.** A message writes no plan, so there is no plan write to
 *    guard and no version check at decide time (Firia, S1-7). What a message approval *is*
 *    guarded on is the exact text approved, and the outbox's per-contact re-checks at drain.
 *
 * The preconditions each tool already had are checked here rather than being dropped on the way:
 * a clarification still needs an ACTIVE thread with a counterparty and still counts against the
 * two-an-hour limit — a family asked twice in an hour and still not understood is a phone call,
 * not a third proposal.
 */
async function messageSend(tx: Exec, input: ProposalInput): Promise<Record<string, unknown>> {
  const by = `agent:${input.runId}`;
  const resolved =
    input.tool === "request_clarification"
      ? await clarificationProposal(tx, input)
      : await followupProposal(tx, input);
  if ("refused" in resolved) return { proposal_refused: resolved.refused, ...resolved.detail, mutated: false };
  if ("staffTaskId" in resolved) return { staff_task_id: resolved.staffTaskId, delivered_as: "staff_task", mutated: false };

  const taskId = await raiseTask(tx, {
    id: effectId(input.idempotencyKey, "exception"),
    siteId: input.siteId,
    category: MESSAGE_SEND_TASK_CATEGORY,
    severity: "AMBER",
    words: agentTasks.proposedFamilyMessage,
    childToken: resolved.proposal.child_token,
    by,
  });
  const approvalId = effectId(input.idempotencyKey, "approval");
  await tx.query(
    `INSERT INTO ops.approval_request (id, site_id, task_id, proposal, created_by, updated_by, source_mode)
     VALUES ($1, $2, $3, $4::jsonb, $5, $5, 'SIMULATED')
     ON CONFLICT (id) DO NOTHING`,
    [approvalId, input.siteId, taskId, JSON.stringify({ ...resolved.proposal, approval_key: input.approvalKey }), by],
  );
  return { approval_request_id: approvalId, exception_task_id: taskId, queued: 0, mutated: false };
}

/** What a message proposal holds, before the approval key is put on it. */
type MessageProposal = {
  kind: string;
  tool: string;
  audience: string;
  recipient_tokens: readonly string[];
  child_token: string | null;
  therapy_session_id: string | null;
  trip_leg_id: string | null;
  channel: string;
  purpose: string;
  recipient_rule: string;
  template_id: string;
  vars: Record<string, unknown>;
  basis_message_id?: string | null;
  thread_id?: string | null;
};

type ProposalOutcome =
  | { proposal: MessageProposal }
  | { staffTaskId: string }
  | { refused: string; detail: Record<string, unknown> };

/** `send_followup`: the audience rules decide who, and `AUDIENCE_RULES.STAFF` is still a task. */
async function followupProposal(tx: Exec, input: ProposalInput): Promise<ProposalOutcome> {
  const by = `agent:${input.runId}`;
  const resolved = await resolveFollowup(tx, {
    siteId: input.siteId,
    args: input.args,
    committed: input.committed,
  });
  if (resolved.kind === "refused") {
    if (resolved.code === "TWO_GUARDIAN_CONFLICT") {
      // §10.3: "two-guardian conflict → exception". The agent does not pick which parent to text,
      // and it does not propose a guess either.
      await raiseTask(tx, {
        id: effectId(input.idempotencyKey, "two-guardian"),
        siteId: input.siteId,
        category: TWO_GUARDIAN_TASK_CATEGORY,
        severity: "AMBER",
        words: agentTasks.proposedContactChange,
        childToken: resolved.childToken ?? null,
        by,
      });
    }
    return { refused: resolved.code, detail: resolved.detail };
  }
  if (resolved.kind === "staff") {
    const taskId = effectId(input.idempotencyKey, "staff-notice");
    await raiseTask(tx, {
      id: taskId,
      siteId: input.siteId,
      category: STAFF_NOTICE_TASK_CATEGORY,
      // A follow-up is news, not an exception; `escalate_exception` is the tool for the other thing.
      severity: "GREEN",
      words: {
        summary: fill(agentStaffNotice.locator, {
          summary: agentStaffNotice.summary,
          trigger: triggerLabel(input.trigger),
          step: input.seq,
        }),
        nextStep: agentStaffNotice.nextStep,
        predicate: agentStaffNotice.predicate,
      },
      childToken: resolved.childToken,
      tripLegId: resolved.tripLegId,
      by,
    });
    return { staffTaskId: taskId };
  }
  return {
    proposal: {
      kind: MESSAGE_SEND_KIND,
      tool: input.tool,
      audience: resolved.audience,
      recipient_tokens: resolved.recipientTokens,
      child_token: resolved.childToken,
      therapy_session_id: resolved.therapySessionId,
      trip_leg_id: resolved.tripLegId,
      channel: resolved.channel,
      purpose: resolved.purpose,
      recipient_rule: resolved.recipientRule,
      template_id: resolved.templateId,
      vars: resolved.vars,
    },
  };
}

/**
 * `request_clarification`: the thread decides who, and the two §11.2 preconditions still hold.
 *
 * The 15-minute await is gone with the send: there is nothing to wait for until a person has
 * approved the question, and §11.1 has no notion of a run that waits for an approval. What is
 * left behind is the row and the task.
 */
async function clarificationProposal(tx: Exec, input: ProposalInput): Promise<ProposalOutcome> {
  const threadId = String(input.args.thread_id ?? "");
  const templateId = String(input.args.draft_template_id ?? "");
  const by = `agent:${input.runId}`;

  const thread = await threadRow(tx, { siteId: input.siteId, threadId });
  if (!thread) return { refused: "NOT_FOUND", detail: { object: "conversation_thread" } };
  // "thread ACTIVE": OPEN is the only state the agent may write into.
  if (thread.state !== "OPEN") return { refused: "THREAD_NOT_ACTIVE", detail: { thread_state: thread.state } };
  if (!thread.counterparty_token) {
    // An unknown-sender thread has nobody to ask (AT-09: it is answered by nobody).
    await raiseTask(tx, {
      id: effectId(input.idempotencyKey, "send-failure"),
      siteId: input.siteId,
      category: SEND_FAILURE_TASK_CATEGORY,
      severity: "AMBER",
      words: agentTasks.clarificationSendFailure,
      by,
    });
    return { refused: "NO_COUNTERPARTY", detail: {} };
  }
  const asked = await clarificationsInLastHour(tx, { siteId: input.siteId, threadId, now: input.now });
  if (asked >= CLARIFICATIONS_PER_THREAD_PER_HOUR) {
    await raiseTask(tx, {
      id: effectId(input.idempotencyKey, "clarification-limit"),
      siteId: input.siteId,
      category: CLARIFICATION_LIMIT_TASK_CATEGORY,
      severity: "AMBER",
      words: agentTasks.clarificationLimit,
      by,
    });
    return { refused: "CLARIFICATION_RATE_LIMIT", detail: { asked_in_last_hour: asked, task_raised: true } };
  }
  return {
    proposal: {
      kind: MESSAGE_SEND_KIND,
      tool: input.tool,
      audience: "GUARDIAN_OF_CHILD",
      recipient_tokens: [thread.counterparty_token],
      // No child reference and no plan behind a question: `generic.notice` names no child and
      // this message is not about one leg (outbox.assertChildReference).
      child_token: null,
      therapy_session_id: null,
      trip_leg_id: null,
      channel: thread.channel,
      purpose: CLARIFICATION_PURPOSE,
      recipient_rule: CLARIFICATION_RECIPIENT_RULE,
      template_id: templateId,
      vars: {},
      thread_id: thread.id,
    },
  };
}

/**
 * The board writes one leg at a time, so a leg row whose direction is not one of the two is not
 * something a proposal can be guarded against. The same two-value check `approvals/decide.ts`
 * makes of the proposal it reads back.
 */
function legOf(direction: string | undefined): Direction | null {
  return direction === "AM" || direction === "PM" ? direction : null;
}

/**
 * A CONFIRM CARD (ledger #74 d). An action PRD §11.2 forbids the agent to take on its own — changing
 * approved needs, deciding a card, Restart — arrives here as a proposal: the action, the model's
 * arguments (already policy-sanitized) and one line of what it would do. Nothing runs. Confirming
 * the card runs the action through the one action layer, as the person who confirms it
 * (`modules/actions/confirm.ts`), with the board's version read then rather than now.
 */
async function staffAction(tx: Exec, input: ProposalInput): Promise<Record<string, unknown>> {
  const tool = actionTool(input.tool)!;
  const by = `agent:${input.runId}`;
  const taskId = await raiseTask(tx, {
    id: effectId(input.idempotencyKey, "exception"),
    siteId: input.siteId,
    category: STAFF_ACTION_TASK_CATEGORY,
    severity: "AMBER",
    words: agentTasks.proposedStaffAction,
    by,
  });
  const approvalId = effectId(input.idempotencyKey, "approval");
  await tx.query(
    `INSERT INTO ops.approval_request (id, site_id, task_id, proposal, created_by, updated_by, source_mode)
     VALUES ($1, $2, $3, $4::jsonb, $5, $5, 'SIMULATED')
     ON CONFLICT (id) DO NOTHING`,
    [
      approvalId,
      input.siteId,
      taskId,
      JSON.stringify({
        kind: STAFF_ACTION_KIND,
        tool: tool.name,
        action: tool.action,
        args: input.args,
        summary: staffActionSummary(tool.name, input.args),
        // The model's own sentence for the card, when it wrote one (action-tools.ts `NOTE`).
        ...(typeof input.args.note === "string" && input.args.note.trim() ? { note: input.args.note.trim() } : {}),
        approval_key: input.approvalKey,
      }),
      by,
    ],
  );
  return { approval_request_id: approvalId, exception_task_id: taskId, mutated: false };
}
