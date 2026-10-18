/**
 * §11.2 `send_followup(recipient_type, target_token, template_id, vars)` — "template allow-list
 * {confirmation, eta_delay, absence_to_therapist, ack_reminder, capability_req}; egress re-check;
 * notify gates", failure column "canceled_stale → recompute".
 *
 * This is the "notify" at the end of AT-01, and the whole of what makes it safe is that the model
 * chooses *which* allow-listed message goes out and to which **audience role** — never a recipient
 * and never a word of copy:
 *
 *  - the **recipients are computed here**, from the audience and the subject: the authorized
 *    contacts for that child (§6.4 `ops.contact_authorization`), the therapist who owns that
 *    session, or the provider's dispatcher. §10.3: "recipients computed at send time". There may be
 *    more than one of them — §10.1 allows a 1:1 broadcast and a family often has two authorized
 *    guardians — and which of the two guardians a message is for is decided by the table in
 *    `resolveGuardian`, never by the model.
 *  - the **copy is the outbox's**: a template id from the tool's own allow-list (schema-enforced)
 *    plus vars the outbox permits for it (`TEMPLATE_VARS`, re-checked by the policy engine before
 *    this call and again by the drainer before the message leaves).
 *  - the **audience and the template have to agree**. The schema cannot say that
 *    `therapist.absence_alert` is for a therapist and `leg.canceled` is for a family, so this
 *    module does: a template outside its audience's list is refused rather than sent to the wrong
 *    kind of person. That is the §11.2 template allow-list read as the five *families* it is.
 *  - the **egress re-check is the outbox's**, at send time, per contact: suppression, consent, the
 *    recipient's authorization for that child, the plan version, and the template's vars again
 *    (outbox/outbox.drain). This executor queues; it never sends.
 *
 * `canceled_stale → recompute`: the plan-version basis is read from the leg **this run actually
 * touched** (the committed `leg_id` fact, not an argument) at the moment of queueing. So a message
 * queued before a plan change goes CANCELED_STALE at send time, and the follow-up queued after it
 * carries the new basis and goes out — the recompute is "read the state again", which is exactly
 * what a fresh call does.
 */
import type { Exec } from "@/db/exec";
import { CHILD_TEMPLATES } from "@/modules/outbox/outbox";
import { DROPOFF_REPLY_TEMPLATE } from "@/modules/approvals/dropoff-change";
import { FAMILY_SMS, authorizedContactsForChild } from "@/modules/outbox/policy";
import type { CommittedCall } from "../store";
import { factString, isUuid, legRow, threadRow } from "./effects";

/** A follow-up that has not gone out in this long is not worth sending (cf. HELP_REPLY_NOT_AFTER_MS). */
export const FOLLOWUP_NOT_AFTER_MS = 30 * 60_000;
/** `ops.task.category` when a family has more than one authorized contact and nobody asked us. */
export const TWO_GUARDIAN_TASK_CATEGORY = "TWO_GUARDIAN_CONFLICT";

export type Audience = "GUARDIAN_OF_CHILD" | "THERAPIST_OF_SESSION" | "PROVIDER_DISPATCHER" | "STAFF";
/** The audiences a follow-up reaches by *message*; `STAFF` is the one that does not. */
type MessageAudience = Exclude<Audience, "STAFF">;

/** `ops.task.category` for a follow-up whose audience is the center's own staff. */
export const STAFF_NOTICE_TASK_CATEGORY = "AGENT_STAFF_NOTICE";
/** `ops.outbound_message.purpose` / `.recipient_rule` for a follow-up to a provider's dispatcher. */
export const DISPATCHER_PURPOSE = "DISPATCHER_PING";
export const DISPATCHER_RECIPIENT_RULE = "provider_dispatcher";

/**
 * How each §11.2 audience is reached, which allow-listed templates may go to it, and — for the
 * three that are messages — on which channel and under which purpose.
 *
 * The five §11.2 template families map onto audiences: a confirmation and an ETA delay go to a
 * family, an absence alert to a therapist, a capability request to a dispatcher. `generic.notice`
 * is fixed copy with no vars and is the one body any audience may receive, because it says only
 * "there is an update, please call us". A template outside its audience's list is refused rather
 * than sent to the wrong kind of person — which is also what keeps child data away from a
 * dispatcher, who is authorized for a vehicle and for no child at all.
 *
 * **`STAFF` is deliberately not a message.** Staff are reached on Teams (§10.4), the Teams adapter
 * is B-12, and queueing an SMS to a staff token would be a message no egress path accepts. What
 * exists today is their board, so a staff-audience follow-up writes the `ops.task` row a
 * coordinator reads and queues nothing. The *words* of that row are `ui/copy.ts`'s rather than a
 * rendered template, so the template allow-list for this audience collapses to the fixed notice:
 * there is no body to render until there is a card to render it on.
 *
 * One consequence of that, named because it is the one place the two layers have to agree:
 * `send_followup` is a `send`-effect tool, so the policy engine consent-checks its **subject**
 * before this executor runs (policy.ts step 9) — but *not* for the STAFF audience, where nothing
 * leaves the building. A staff follow-up about a child whose family has opted out therefore goes
 * through and writes its task (founder ruling, DECISION-LEDGER #65, 2026-10-16: an opted-out family
 * is a thing staff may be told about; it is not a family staff may text). The family scope still
 * binds it to this run's own family, and every audience below that *is* a message stays
 * consent-checked. The agreement this rests on is `AUDIENCE_RULES.STAFF` being `staff_task`: the
 * day STAFF becomes a real channel (Teams, B-12) it becomes an egress path, and the exemption on
 * the policy row has to come off with it.
 */
type AudienceRule =
  | {
      readonly kind: "outbox";
      readonly templates: readonly string[];
      readonly channel: "SMS_1TO1";
      readonly purpose: string;
      readonly recipientRule: string;
    }
  | { readonly kind: "staff_task"; readonly templates: readonly string[] };

/**
 * EVERY BODY THE AGENT MAY SEND A FAMILY, named so a test can read the list.
 *
 * No `leg.changed` and no `dropoff.changed` (Firia, 2026-10-17 11:00 PM ET; Veri S1-1). The two
 * bodies that tell a family their child's ride changed are `approvals/decide.ts`'s alone, sent
 * after a person approves. The tool's own allow-list (`FOLLOWUP_TEMPLATE_FAMILIES`,
 * src/modules/agent/tools.ts) drops them from the schema as well, so a model asking for one is
 * refused before it reaches here; this is the second of the two locks, and the one that answers
 * `TEMPLATE_NOT_FOR_AUDIENCE` if the first is ever widened.
 */
export const GUARDIAN_SEND_TEMPLATES: readonly string[] = [
  "leg.canceled", "pickup.eta", "dropoff.eta", "generic.notice",
];

const AUDIENCE_RULES: Readonly<Record<Audience, AudienceRule>> = {
  GUARDIAN_OF_CHILD: {
    kind: "outbox",
    templates: GUARDIAN_SEND_TEMPLATES,
    // One definition of "how a family is reached" (outbox/policy.ts `FAMILY_SMS`), shared with the
    // deterministic ETA notice: the same purpose on the same channel under the same rule.
    channel: FAMILY_SMS.channel,
    purpose: FAMILY_SMS.purpose,
    recipientRule: FAMILY_SMS.recipientRule,
  },
  THERAPIST_OF_SESSION: {
    kind: "outbox",
    templates: ["therapist.absence_alert", "therapist.late_alert", "generic.notice"],
    channel: "SMS_1TO1",
    purpose: "THERAPIST_ALERT",
    recipientRule: "therapist_of_session",
  },
  PROVIDER_DISPATCHER: {
    kind: "outbox",
    // Fixed copy only: everything else in the allow-list is about a child, and a dispatcher is
    // authorized for a vehicle. The capability question itself has its own tool (§11.2
    // `request_provider_capability`), which is also where the dispatcher egress path lives.
    templates: ["generic.notice"],
    channel: "SMS_1TO1",
    purpose: DISPATCHER_PURPOSE,
    recipientRule: DISPATCHER_RECIPIENT_RULE,
  },
  STAFF: { kind: "staff_task", templates: ["generic.notice"] },
};

/**
 * Which templates are a **decision** rather than a notice, and the whole of why the fan-out below
 * is shaped the way it is.
 *
 * A cancellation or a change confirms *what somebody asked us for*, so it goes back to whoever
 * asked and to nobody else: the other parent did not make that request, and telling them it was
 * made is a disclosure about the first one. Everything else — an ETA, a fixed notice — is news
 * about a ride that is happening, which every authorized contact is entitled to (§10.1 "Fan-out
 * 1:1 broadcast").
 */
export const DECISION_TEMPLATES: ReadonlySet<string> = new Set([
  "leg.canceled",
  "leg.changed",
  "dropoff.changed",
  /*
   * The model-written reply (Firia, 2026-10-18 11:04 AM ET). It is the most decision-shaped body
   * there is — a sentence a coordinator signed, word for word — so it belongs on this list for the
   * same reason the other three do, and it is not on `send_followup`'s schema at all: the only
   * writer is `propose_dropoff_change`'s proposal row and the only sender is `approvals/decide.ts`.
   */
  DROPOFF_REPLY_TEMPLATE,
]);

/** What the subject resolved to: who gets it, and the child reference the message carries. */
type Resolved = {
  /** One or more authorized contacts, in send order — the asker first when there is one. */
  readonly recipientTokens: readonly string[];
  readonly childToken: string | null;
  readonly therapySessionId: string | null;
};

/**
 * WHAT A FOLLOW-UP RESOLVES TO, now that it is a proposal and not a send (Firia's S1-7 ruling,
 * 2026-10-18).
 *
 * Everything above this line is unchanged: the audience rules, who a template may go to, and the
 * fact that **recipients are computed here** from an audience role and a subject token, never
 * named by the model. What changed is the last step. This used to end at `enqueue`; it now ends
 * at one of three answers, and only a person pressing Approve turns the first of them into a
 * message (`modules/approvals/decide.ts`):
 *
 *  - `proposal` — who it would go to, which template, and which leg it is about. The caller
 *    writes the `MESSAGE_SEND` approval row (`agent/run/exec/proposals.ts`).
 *  - `staff` — the `STAFF` audience, which is a board row and not a message (see
 *    `AUDIENCE_RULES`). Nothing leaves the building, so there is nothing to approve: the task is
 *    written as it always was.
 *  - `refused` — the call named something that cannot be reached. Nothing is written, and the
 *    refusal is recorded on the call.
 *
 * The recipients are resolved **now**, at proposal time, and stored on the row: that is what lets
 * a coordinator be shown a real "this goes to Dara O." instead of a promise. Consent, suppression
 * and each recipient's authorization are re-checked **again** per contact at drain, which is the
 * check that actually decides whether a message leaves (§10.3; Firia, S1-7).
 */
export type FollowupResolution =
  | {
      readonly kind: "proposal";
      readonly audience: Audience;
      readonly recipientTokens: readonly string[];
      readonly childToken: string | null;
      readonly therapySessionId: string | null;
      readonly templateId: string;
      readonly vars: Record<string, unknown>;
      readonly channel: "SMS_1TO1";
      readonly purpose: string;
      readonly recipientRule: string;
      readonly tripLegId: string | null;
    }
  | { readonly kind: "staff"; readonly childToken: string; readonly tripLegId: string | null; readonly templateId: string }
  | { readonly kind: "refused"; readonly code: string; readonly detail: Record<string, unknown>; readonly childToken?: string | null };

/**
 * Resolve one `send_followup` call against the day, without writing anything.
 *
 * `askedBy` comes from the thread this run resolved — so a reply goes back to the guardian who
 * texted us — and the leg from the leg this run actually touched, both read off the run's own
 * committed facts rather than off an argument the model wrote.
 */
export async function resolveFollowup(
  db: Exec,
  a: {
    readonly siteId: string;
    readonly args: Record<string, unknown>;
    readonly committed: readonly CommittedCall[];
  },
): Promise<FollowupResolution> {
  const audience = a.args.audience as Audience;
  const subject = String(a.args.subject_token ?? "");
  const templateId = String(a.args.template_id ?? "");
  const vars = (a.args.vars ?? {}) as Record<string, unknown>;

  const rule = AUDIENCE_RULES[audience];
  if (!rule) return { kind: "refused", code: "UNSUPPORTED_AUDIENCE", detail: { audience } };
  if (!rule.templates.includes(templateId)) {
    return { kind: "refused", code: "TEMPLATE_NOT_FOR_AUDIENCE", detail: { audience, template_id: templateId } };
  }
  if (!isUuid(subject)) return { kind: "refused", code: "NOT_FOUND", detail: { object: "subject" } };

  // Staff are reached on their board, not by message (see `AUDIENCE_RULES`). No egress, so
  // nothing for a person to approve — the task is the whole effect.
  if (rule.kind === "staff_task") {
    const leg = await legRow(db, { siteId: a.siteId, legId: subject });
    const child = leg
      ? leg.child_token
      : (await db.query<{ child_token: string }>(
          "SELECT child_token FROM ops.child_profile WHERE child_token = $1 AND site_id = $2",
          [subject, a.siteId],
        )).rows[0]?.child_token ?? null;
    if (!child) return { kind: "refused", code: "NOT_FOUND", detail: { object: "subject" } };
    return { kind: "staff", childToken: child, tripLegId: leg?.id ?? null, templateId };
  }

  // Who asked, read from the thread this run resolved — so a confirmation goes back to the
  // guardian who texted us, and no contact token ever passes through the prompt to get here.
  const senderThreadId = factString(a.committed, "resolve_sender", "sender_thread_id");
  const askedBy = senderThreadId
    ? (await threadRow(db, { siteId: a.siteId, threadId: senderThreadId }))?.counterparty_token ?? null
    : null;

  const resolved = await resolveAudience(db, {
    audience: audience as MessageAudience, subject, siteId: a.siteId, askedBy, templateId,
  });
  if ("error" in resolved) {
    return { kind: "refused", code: resolved.error, detail: resolved.detail, childToken: resolved.childToken ?? null };
  }

  // A child template must carry a child reference, and the outbox refuses it otherwise. This is
  // the earlier, clearer refusal: the audience resolved to somebody, but not to a child.
  if (CHILD_TEMPLATES.has(templateId) && !resolved.childToken) {
    return { kind: "refused", code: "CHILD_REFERENCE_MISSING", detail: { template_id: templateId } };
  }

  /*
   * The leg this run touched. It is carried on the proposal so the approved send can read that
   * leg's plan version at the moment it queues (§10.3 "version check at send") — the outbox's own
   * staleness rule, which is NOT the `plan_run` version check: that one guards a plan write, and
   * a message writes no plan (Firia, S1-7).
   */
  const legId = factString(a.committed, "cancel_attendance_or_leg", "leg_id")
    ?? factString(a.committed, "get_leg_state", "leg_id");
  const leg = legId ? await legRow(db, { siteId: a.siteId, legId }) : null;
  const boundLeg = leg && leg.child_token === resolved.childToken ? leg : null;

  return {
    kind: "proposal",
    audience,
    recipientTokens: resolved.recipientTokens,
    childToken: resolved.childToken,
    therapySessionId: resolved.therapySessionId,
    templateId,
    vars,
    channel: rule.channel,
    purpose: rule.purpose,
    recipientRule: rule.recipientRule,
    tripLegId: boundLeg?.id ?? null,
  };
}

/* ───────────────────────────── resolving the audience ───────────────────────────── */

type ResolveFailure = { error: string; detail: Record<string, unknown>; childToken?: string | null };

async function resolveAudience(
  db: Exec,
  a: { audience: MessageAudience; subject: string; siteId: string; askedBy: string | null; templateId: string },
): Promise<Resolved | ResolveFailure> {
  if (a.audience === "GUARDIAN_OF_CHILD") return resolveGuardian(db, a);
  if (a.audience === "THERAPIST_OF_SESSION") return resolveTherapist(db, a);
  return resolveDispatcher(db, a);
}

/**
 * The family side, and the §10.3 two-guardian rule in full.
 *
 * The candidates are the contacts §6.4 authorizes for this child, on this channel, right now — and
 * which of them this message is *for* depends on two things, neither of them the model's:
 *
 * | | somebody asked (this run resolved a sender) | nobody asked (a timer, a sweeper, an event) |
 * |---|---|---|
 * | **decision** copy (`leg.canceled`, `leg.changed`) | the guardian who asked, and no one else | one authorized contact → them; several → §10.3 **two-guardian conflict**: an AMBER exception and no send |
 * | **notice** copy (an ETA, a fixed notice) | every authorized contact, the asker first (§10.1 1:1 broadcast) | same as above |
 *
 * The asymmetry is the point. A confirmation is about a request one parent made, so it goes back to
 * them (AT-01); an ETA is about a ride both parents are entitled to know about. And with nobody
 * having asked, two authorized contacts is the case where the agent would have to *pick*, which
 * §10.3 says is an exception rather than a guess — PRD §6.6 settles the same conflict the same way
 * ("most-restrictive wins; staff resolves"), and no send is the most restrictive thing there is.
 *
 * Nothing here is a recipient the model chose: the asker comes from the thread this run resolved,
 * and the rest from `ops.contact_authorization`. Consent is re-checked **per contact** at send time
 * by the outbox, so a fan-out to a family where one parent has opted out sends to the other and
 * visibly refuses the first (§10.3 "recipients computed at send time").
 */
async function resolveGuardian(
  db: Exec,
  a: { subject: string; siteId: string; askedBy: string | null; templateId: string },
): Promise<Resolved | ResolveFailure> {
  const child = await db.query<{ child_token: string }>(
    "SELECT child_token FROM ops.child_profile WHERE child_token = $1 AND site_id = $2",
    [a.subject, a.siteId],
  );
  if (!child.rows[0]) return { error: "NOT_FOUND", detail: { object: "child_profile" } };

  // §6.4, read through the one shared query (outbox/policy.ts): the same authorization the
  // drainer re-checks per contact at send time.
  const authorized = await authorizedContactsForChild(db, {
    siteId: a.siteId,
    childToken: a.subject,
  });
  if (authorized.length === 0) {
    return { error: "NO_AUTHORIZED_CONTACT", detail: { object: "contact_authorization" }, childToken: a.subject };
  }
  const asker = a.askedBy && authorized.includes(a.askedBy) ? a.askedBy : null;
  if (asker) {
    // The asker always first, so the one message a decision produces is theirs and a fan-out
    // reaches them before anyone else.
    const recipientTokens = DECISION_TEMPLATES.has(a.templateId)
      ? [asker]
      : [asker, ...authorized.filter((c) => c !== asker)];
    return { recipientTokens, childToken: a.subject, therapySessionId: null };
  }
  if (authorized.length > 1) {
    return {
      error: "TWO_GUARDIAN_CONFLICT",
      detail: { authorized_contacts: authorized.length },
      childToken: a.subject,
    };
  }
  return { recipientTokens: [authorized[0]], childToken: a.subject, therapySessionId: null };
}

/** The therapist who owns this session, and the child the session is about. */
async function resolveTherapist(
  db: Exec,
  a: { subject: string; siteId: string },
): Promise<Resolved | ResolveFailure> {
  const r = await db.query<{ person_token: string; child_token: string; id: string }>(
    `SELECT t.person_token, s.child_token, s.id FROM ops.therapy_session s
     JOIN ops.therapist t ON t.id = s.therapist_id
     WHERE s.id = $1 AND s.site_id = $2 AND s.status <> 'CANCELED'`,
    [a.subject, a.siteId],
  );
  const row = r.rows[0];
  if (!row) return { error: "NOT_FOUND", detail: { object: "therapy_session" } };
  return { recipientTokens: [row.person_token], childToken: row.child_token, therapySessionId: row.id };
}

/**
 * The provider's dispatcher, from the provider row the subject names. The contact point is
 * `ops.provider.dispatcher_person_token` and the person behind it is
 * `identity.external_person_identity`, which the egress authorizer re-checks at send time
 * (`outbox/policy.dbRecipientAuthorizer`, kind "dispatcher") — so a dispatcher who has been taken
 * off file, or who has texted STOP, is refused there rather than here.
 *
 * No child token and no session: a message to a dispatcher is about a vehicle, and the audience's
 * template list is fixed copy for exactly that reason.
 */
async function resolveDispatcher(
  db: Exec,
  a: { subject: string; siteId: string },
): Promise<Resolved | ResolveFailure> {
  const r = await db.query<{ dispatcher_person_token: string | null }>(
    "SELECT dispatcher_person_token FROM ops.provider WHERE id = $1 AND site_id = $2",
    [a.subject, a.siteId],
  );
  const row = r.rows[0];
  if (!row) return { error: "NOT_FOUND", detail: { object: "provider" } };
  if (!row.dispatcher_person_token) {
    return { error: "NO_DISPATCHER_CONTACT", detail: { provider_token: a.subject } };
  }
  return { recipientTokens: [row.dispatcher_person_token], childToken: null, therapySessionId: null };
}

/**
 * The idempotency key of one message in a fan-out.
 *
 * A single-recipient send keeps the call's own key, which is the sink-side half of the resume
 * contract everywhere else in this directory (and what `ops.outbound_message.idempotency_key`
 * already holds for every slice-3 send). Each *additional* contact's message is keyed on that key
 * plus the contact's token — derived, not generated, so a re-driven call computes the same keys and
 * the unique index turns the second attempt into a no-op per contact rather than a second text.
 */
export function fanOutKey(
  callKey: string,
  recipients: readonly string[],
  recipientToken: string,
): string {
  return recipients[0] === recipientToken ? callKey : `${callKey}:${recipientToken}`;
}
