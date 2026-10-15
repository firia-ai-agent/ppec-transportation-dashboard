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
import { CHILD_TEMPLATES, enqueue } from "@/modules/outbox/outbox";
import { agentTasks } from "@/ui/copy";
import type { ToolExecution, ToolExecutor } from "../executors";
import { raiseTask } from "./clarify";
import {
  type ExecutorDeps,
  actor,
  effectId,
  factString,
  failed,
  isUuid,
  legRow,
  notFound,
  threadRow,
} from "./effects";

/** A follow-up that has not gone out in this long is not worth sending (cf. HELP_REPLY_NOT_AFTER_MS). */
export const FOLLOWUP_NOT_AFTER_MS = 30 * 60_000;
/** `ops.task.category` when a family has more than one authorized contact and nobody asked us. */
export const TWO_GUARDIAN_TASK_CATEGORY = "TWO_GUARDIAN_CONFLICT";

export type Audience = "GUARDIAN_OF_CHILD" | "THERAPIST_OF_SESSION" | "PROVIDER_DISPATCHER" | "STAFF";

/**
 * The two audiences this slice can actually reach, and why the other two are refused rather than
 * half-built:
 *
 *  - `STAFF` are reached on Teams, and the Teams adapter is B-12. Queueing an SMS to a staff token
 *    would be a message no egress path accepts.
 *  - `PROVIDER_DISPATCHER` needs the dispatcher-link channel *and* an identity record the egress
 *    authorizer can check (`identity.external_person_identity` is not wired into
 *    `dbRecipientAuthorizer` yet), so such a message would queue and then be blocked at send time.
 *    It lands with `request_provider_capability`, the tool §11.2 actually gives that job to.
 */
const UNREACHABLE_AUDIENCES: Readonly<Record<string, string>> = {
  STAFF: "teams_adapter_not_wired",
  PROVIDER_DISPATCHER: "dispatcher_egress_not_wired",
};

/**
 * Which allow-listed template may go to which audience, and on which channel and purpose.
 *
 * The five §11.2 template families map onto audiences: a confirmation and an ETA delay go to a
 * family, an absence alert to a therapist, a capability request to a dispatcher. `generic.notice`
 * is fixed copy with no vars and is the one body any audience may receive, because it says only
 * "there is an update, please call us".
 */
type ReachableAudience = "GUARDIAN_OF_CHILD" | "THERAPIST_OF_SESSION";

const AUDIENCE_RULES: Readonly<Record<ReachableAudience, {
  readonly templates: readonly string[];
  readonly channel: "SMS_1TO1";
  readonly purpose: string;
  readonly recipientRule: string;
}>> = {
  GUARDIAN_OF_CHILD: {
    templates: ["leg.canceled", "leg.changed", "pickup.eta", "dropoff.eta", "generic.notice"],
    channel: "SMS_1TO1",
    purpose: "TRANSPORT_UPDATE",
    recipientRule: "guardian_of_child",
  },
  THERAPIST_OF_SESSION: {
    templates: ["therapist.absence_alert", "therapist.late_alert", "generic.notice"],
    channel: "SMS_1TO1",
    purpose: "THERAPIST_ALERT",
    recipientRule: "therapist_of_session",
  },
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
const DECISION_TEMPLATES: ReadonlySet<string> = new Set(["leg.canceled", "leg.changed"]);

/** What the subject resolved to: who gets it, and the child reference the message carries. */
type Resolved = {
  /** One or more authorized contacts, in send order — the asker first when there is one. */
  readonly recipientTokens: readonly string[];
  readonly childToken: string | null;
  readonly therapySessionId: string | null;
};

export function sendFollowupExecutor(deps: ExecutorDeps): ToolExecutor {
  return async (call) => {
    const audience = call.args.audience as Audience;
    const subject = String(call.args.subject_token ?? "");
    const templateId = String(call.args.template_id ?? "");
    const vars = (call.args.vars ?? {}) as Record<string, unknown>;
    const by = actor(call.runId);

    const unreachable = UNREACHABLE_AUDIENCES[audience];
    if (unreachable) return failed("UNSUPPORTED_AUDIENCE", { audience, reason_code: unreachable });
    const rule = AUDIENCE_RULES[audience as ReachableAudience];
    if (!rule) return failed("UNSUPPORTED_AUDIENCE", { audience });
    if (!rule.templates.includes(templateId)) {
      return failed("TEMPLATE_NOT_FOR_AUDIENCE", { audience, template_id: templateId });
    }
    if (!isUuid(subject)) return notFound("subject");

    // Who asked, read from the thread this run resolved — so a confirmation goes back to the
    // guardian who texted us, and no contact token ever passes through the prompt to get here.
    const senderThreadId = factString(call.committed, "resolve_sender", "sender_thread_id");
    const askedBy = senderThreadId
      ? (await threadRow(deps.db, { siteId: call.siteId, threadId: senderThreadId }))?.counterparty_token ?? null
      : null;

    const resolved = await resolveAudience(deps, {
      audience: audience as ReachableAudience, subject, siteId: call.siteId, askedBy, templateId,
    });
    if ("error" in resolved) {
      if (resolved.error === "TWO_GUARDIAN_CONFLICT") {
        // §10.3: "two-guardian conflict → exception". The agent does not pick which parent to text.
        await raiseTask(deps.db, {
          id: effectId(call.idempotencyKey, "two-guardian"),
          siteId: call.siteId,
          category: TWO_GUARDIAN_TASK_CATEGORY,
          severity: "AMBER",
          words: agentTasks.proposedContactChange,
          childToken: resolved.childToken ?? null,
          by,
        });
      }
      return failed(resolved.error, resolved.detail);
    }

    // A child template must carry a child reference, and the outbox refuses it otherwise. This is
    // the earlier, clearer refusal: the audience resolved to somebody, but not to a child.
    if (CHILD_TEMPLATES.has(templateId) && !resolved.childToken) {
      return failed("CHILD_REFERENCE_MISSING", { template_id: templateId });
    }

    // The leg this run touched, with its plan version read now: the basis the send-time check
    // compares against (§10.3 "version check at send"). A follow-up about no particular leg — a
    // generic notice, a therapist alert for a whole session — carries no leg and no basis.
    const legId = factString(call.committed, "cancel_attendance_or_leg", "leg_id")
      ?? factString(call.committed, "get_leg_state", "leg_id");
    const leg = legId ? await legRow(deps.db, { siteId: call.siteId, legId }) : null;
    const boundLeg = leg && leg.child_token === resolved.childToken ? leg : null;
    const staleBefore = boundLeg ? await canceledStaleFor(deps.db, { legId: boundLeg.id, templateId }) : 0;

    try {
      // One message per recipient, in one transaction: a fan-out either queues for everybody or
      // for nobody, so a crash cannot tell one parent and not the other.
      const queued = await deps.db.tx(async (tx, afterCommit) => {
        const out: { id: string; duplicate: boolean; recipientToken: string }[] = [];
        for (const recipientToken of resolved.recipientTokens) {
          const message = await enqueue(tx, afterCommit, deps.transport, {
            siteId: call.siteId,
            purpose: rule.purpose,
            recipientRule: rule.recipientRule,
            recipientToken,
            channel: rule.channel,
            templateId,
            vars,
            childToken: resolved.childToken,
            tripLegId: boundLeg?.id ?? null,
            therapySessionId: resolved.therapySessionId,
            planVersionBasis: boundLeg?.plan_version ?? 0,
            notAfter: new Date(call.now.getTime() + FOLLOWUP_NOT_AFTER_MS),
            idempotencyKey: fanOutKey(call.idempotencyKey, resolved.recipientTokens, recipientToken),
            by,
          });
          out.push({ ...message, recipientToken });
        }
        return out;
      });
      return {
        status: "executed",
        data: {
          outbound_message_id: queued[0].id,
          ...(queued.length > 1 ? { outbound_message_ids: queued.map((q) => q.id) } : {}),
          duplicate: queued.every((q) => q.duplicate),
          recipients: queued.length,
          audience,
          template_id: templateId,
          trip_leg_id: boundLeg?.id ?? null,
          plan_version_basis: boundLeg?.plan_version ?? 0,
          // §11.2 "canceled_stale → recompute": how many earlier attempts about this leg were
          // refused for a stale plan, and therefore what this basis was recomputed after.
          recomputed_after_stale: staleBefore,
        },
        promptFacts: {
          followup_queued: true,
          audience,
          template_id: templateId,
          // A count, never the contacts: who got it is the outbox's record, not the prompt's.
          recipients: queued.length,
          ...(boundLeg ? { plan_version_basis: boundLeg.plan_version } : {}),
          ...(staleBefore > 0 ? { recomputed_after_stale: staleBefore } : {}),
        },
      };
    } catch (e) {
      // The outbox refused to even hold it: an unknown template, a var it does not permit, child
      // data with no child reference. Those are policy failures the engine should have caught, so
      // the honest outcome is a failed step and a run that stops.
      return failed("ENQUEUE_REFUSED", { reason: (e instanceof Error ? e.message : String(e)).slice(0, 200) });
    }
  };
}

/* ───────────────────────────── resolving the audience ───────────────────────────── */

type ResolveFailure = { error: string; detail: Record<string, unknown>; childToken?: string | null };

async function resolveAudience(
  deps: ExecutorDeps,
  a: { audience: ReachableAudience; subject: string; siteId: string; askedBy: string | null; templateId: string },
): Promise<Resolved | ResolveFailure> {
  return a.audience === "GUARDIAN_OF_CHILD" ? resolveGuardian(deps, a) : resolveTherapist(deps.db, a);
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
  deps: ExecutorDeps,
  a: { subject: string; siteId: string; askedBy: string | null; templateId: string },
): Promise<Resolved | ResolveFailure> {
  const child = await deps.db.query<{ child_token: string }>(
    "SELECT child_token FROM ops.child_profile WHERE child_token = $1 AND site_id = $2",
    [a.subject, a.siteId],
  );
  if (!child.rows[0]) return { error: "NOT_FOUND", detail: { object: "child_profile" } };

  const contacts = await deps.db.query<{ contact_token: string }>(
    `SELECT DISTINCT contact_token FROM ops.contact_authorization
     WHERE site_id = $1 AND child_token = $2 AND channel = 'SMS_1TO1'
       AND scope = 'RECEIVE_TRANSPORT_UPDATES'
       AND valid_from <= now() AND (valid_to IS NULL OR valid_to > now())
     ORDER BY contact_token`,
    [a.siteId, a.subject],
  );
  const authorized = contacts.rows.map((r) => r.contact_token);
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

/** How many earlier messages about this leg and template were refused for a stale plan. */
async function canceledStaleFor(db: Exec, a: { legId: string; templateId: string }): Promise<number> {
  const r = await db.query<{ n: number }>(
    `SELECT count(*)::int n FROM ops.outbound_message
     WHERE trip_leg_id = $1 AND template_id = $2 AND state = 'CANCELED_STALE'`,
    [a.legId, a.templateId],
  );
  return r.rows[0]?.n ?? 0;
}
