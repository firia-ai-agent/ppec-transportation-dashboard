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
import { FAMILY_SMS, authorizedContactsForChild } from "@/modules/outbox/policy";
import { agentStaffNotice, agentTasks, fill } from "@/ui/copy";
import type { ToolExecution, ToolExecutor } from "../executors";
import { triggerLabel } from "../triggers";
import {
  type ExecutorDeps,
  actor,
  effectId,
  factString,
  failed,
  isUuid,
  legRow,
  notFound,
  raiseTask,
  threadRow,
} from "./effects";

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
export const DECISION_TEMPLATES: ReadonlySet<string> = new Set(["leg.canceled", "leg.changed", "dropoff.changed"]);

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

    const rule = AUDIENCE_RULES[audience];
    if (!rule) return failed("UNSUPPORTED_AUDIENCE", { audience });
    if (!rule.templates.includes(templateId)) {
      return failed("TEMPLATE_NOT_FOR_AUDIENCE", { audience, template_id: templateId });
    }
    if (!isUuid(subject)) return notFound("subject");
    // Staff are reached on their board, not by message (see `AUDIENCE_RULES`).
    if (rule.kind === "staff_task") {
      return staffNotice(deps, call, { subject, templateId, by });
    }

    // Who asked, read from the thread this run resolved — so a confirmation goes back to the
    // guardian who texted us, and no contact token ever passes through the prompt to get here.
    const senderThreadId = factString(call.committed, "resolve_sender", "sender_thread_id");
    const askedBy = senderThreadId
      ? (await threadRow(deps.db, { siteId: call.siteId, threadId: senderThreadId }))?.counterparty_token ?? null
      : null;

    const resolved = await resolveAudience(deps, {
      audience: audience as MessageAudience, subject, siteId: call.siteId, askedBy, templateId,
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
  a: { audience: MessageAudience; subject: string; siteId: string; askedBy: string | null; templateId: string },
): Promise<Resolved | ResolveFailure> {
  if (a.audience === "GUARDIAN_OF_CHILD") return resolveGuardian(deps, a);
  if (a.audience === "THERAPIST_OF_SESSION") return resolveTherapist(deps.db, a);
  return resolveDispatcher(deps.db, a);
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

  // §6.4, read through the one shared query (outbox/policy.ts): the same authorization the
  // drainer re-checks per contact at send time.
  const authorized = await authorizedContactsForChild(deps.db, {
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
 * §11.2's `STAFF` audience: one GREEN `ops.task` row, and nothing queued.
 *
 * The subject is the thing staff are being told about — a child, or one leg of their day — and it
 * is resolved here so the row points at it: a coordinator opening the task gets the child and,
 * where there is one, the ride. A subject that is neither is refused rather than written down
 * against nothing.
 *
 * Idempotent on the call's key like every other row in this directory, so a re-driven follow-up
 * does not tell the same coordinator twice.
 */
async function staffNotice(
  deps: ExecutorDeps,
  call: Parameters<ToolExecutor>[0],
  a: { subject: string; templateId: string; by: string },
): Promise<ToolExecution> {
  const leg = await legRow(deps.db, { siteId: call.siteId, legId: a.subject });
  const child = leg
    ? leg.child_token
    : (await deps.db.query<{ child_token: string }>(
        "SELECT child_token FROM ops.child_profile WHERE child_token = $1 AND site_id = $2",
        [a.subject, call.siteId],
      )).rows[0]?.child_token ?? null;
  if (!child) return notFound("subject");

  const taskId = effectId(call.idempotencyKey, "staff-notice");
  await raiseTask(deps.db, {
    id: taskId,
    siteId: call.siteId,
    category: STAFF_NOTICE_TASK_CATEGORY,
    // A follow-up is news, not an exception; `escalate_exception` is the tool for the other thing.
    severity: "GREEN",
    words: {
      summary: fill(agentStaffNotice.locator, {
        summary: agentStaffNotice.summary,
        trigger: triggerLabel(call.trigger),
        step: call.seq,
      }),
      nextStep: agentStaffNotice.nextStep,
      predicate: agentStaffNotice.predicate,
    },
    childToken: child,
    tripLegId: leg?.id ?? null,
    by: a.by,
  });
  return {
    status: "executed",
    data: {
      audience: "STAFF",
      template_id: a.templateId,
      // Said plainly in the record, because it is the one audience that is not a send.
      delivered_as: "staff_task",
      staff_task_id: taskId,
      child_token: child,
      trip_leg_id: leg?.id ?? null,
      recipients: 1,
    },
    promptFacts: { staff_notified: true, audience: "STAFF", recipients: 1 },
  };
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
