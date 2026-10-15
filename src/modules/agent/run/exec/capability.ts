/**
 * The two §11.2 tools about what a vehicle can carry today.
 *
 * | Tool | Precondition → effect | Failure |
 * |---|---|---|
 * | `request_provider_capability(vehicle, provider, route, required)` | capability UNKNOWN at T−90 or on substitution → signed dispatcher link; state REQUESTED | no reply → escalate |
 * | `record_capability_report(vehicle, parsed, source_msg)` | from provider contact point → observation | low confidence → staff review |
 *
 * `request_provider_capability(vehicle, provider, route, required)` — "capability UNKNOWN at
 * T−90 or on substitution → signed dispatcher link; state REQUESTED", failure column "no reply →
 * escalate".
 *
 * This is the one tool that reaches **outside the center and outside a family**: the recipient is a
 * provider's dispatcher, not a guardian, and the thing being asked about is a vehicle rather than a
 * child. Three parts, each with its own guard:
 *
 *  - **the precondition is a time, and it is read here.** "T−90" is ninety minutes before the route
 *    starts, and the route's start is `min(window_start)` over the legs on that manifest — the
 *    planned pickup window, which is the only start time this schema holds. The other half of the
 *    precondition is "or on substitution": a capability row that has been *reset* to UNKNOWN after a
 *    `CHANGED` (machines.ts: `* → CHANGED` by P/S, then `CHANGED → UNKNOWN` by Y) is a vehicle that
 *    was swapped, and that is asked about at once rather than at T−90. A fresh row is UNKNOWN at
 *    version 1; one that has been round that loop is UNKNOWN at a higher version, which is how the
 *    two are told apart without a column that says so.
 *  - **the state moves on the §6.3 machine**: `UNKNOWN → REQUESTED` as actor `A` (machines.ts
 *    `CAPABILITY` names the agent on exactly that edge and on no other), guarded on the version read
 *    with the row. The agent can never reach VERIFIED — that edge is staff's, and `tools.ts` will not
 *    even let the call be expressed.
 *  - **the ask is a dispatcher link plus a notice.** The link is `ops.dispatcher_link`: single use,
 *    hashed, expiring at route start or in four hours, whichever is sooner (ARCHITECTURE §3.3). The
 *    hash comes from the `DispatcherLinkSigner` seam, and **P1 configures none** — the link page and
 *    its key are a later milestone — so with no signer the link is recorded as an *intent*
 *    (`link_state: INTENT_RECORDED`) rather than invented. Either way the dispatcher gets the
 *    fixed-copy notice through the outbox, which is what a dispatcher ping is today: the URL itself
 *    needs an outbound template with a link var, and no template in `outbox.TEMPLATE_VARS` has one
 *    (B-05 owns the bodies).
 *
 * A provider with **no dispatcher contact point** is refused by name and raises a staff task: there
 * is nobody to ask, and moving the row to REQUESTED would record a question that was never put.
 *
 * `record_capability_report(vehicle, parsed, source_msg)` is the answer coming back, and §11.2
 * marks it `auto (REPORTED only)`:
 *
 *  - **"from provider contact point"** is a check, not a description. The evidence message's blind
 *    index has to be the one `identity.external_person_identity` holds for *that vehicle's
 *    provider's* dispatcher — so a guardian, a stranger or another provider reporting about this van
 *    is refused. A phone match is recognition, never authority (RES-02), which is why the match has
 *    to be against the contact point the provider row names rather than against any known number.
 *  - **the observation is the vehicle-day row itself**: `REQUESTED → REPORTED` as actor `P` (the
 *    provider reports; the agent only records what they said), with `observed_at`, `observed_by` and
 *    `evidence_message_id` written in the same transaction. The parsed layout and seat counts have
 *    no column there — the solver reads layouts from `ops.vehicle_layout` — so they stay on the call
 *    row as the observation's evidence and reach capability only when staff verify it.
 *  - **"low confidence → staff review"**: below `CAPABILITY_REPORT_MIN_CONFIDENCE` the observation
 *    is still recorded (the provider did answer) and an AMBER task asks a person to confirm it
 *    before the solver is trusted with it.
 *
 * `VERIFIED` is unreachable from here twice over: `tools.ts` types the state argument as the literal
 * `REPORTED`, and `machines.ts` gives `REPORTED → VERIFIED` to staff alone.
 */
import type { Exec } from "@/db/exec";
import { CAPABILITY } from "@/domain/machines";
import { IllegalTransition, StaleOrConflict, transition } from "@/domain/transition";
import { enqueue } from "@/modules/outbox/outbox";
import { agentTasks, agentWaits } from "@/ui/copy";
import type { ToolExecution, ToolExecutor } from "../executors";
import { raiseTask } from "./clarify";
import {
  type ExecutorDeps,
  actor,
  effectId,
  factString,
  failed,
  isUuid,
  notFound,
} from "./effects";
import { PREDICATE_CAPABILITY_REPORTED } from "./predicate";

/** §11.2: "capability UNKNOWN at T−90". */
export const CAPABILITY_REQUEST_LEAD_MINUTES = 90;
/** ARCHITECTURE §3.3: the link expires "at route start or 4 h", whichever is sooner. */
export const CAPABILITY_LINK_MAX_HOURS = 4;
/**
 * How long the dispatcher has before §11.2's "no reply → escalate" fires. T−90 to T−60 is the gap
 * the demo's own follow-up timers use (ARCHITECTURE §3.3: T−90, T−60, T−45), so the first deadline
 * is thirty minutes.
 */
export const CAPABILITY_REPLY_SECONDS = 30 * 60;
export const CAPABILITY_REQUEST_PURPOSE = "CAPABILITY_REQUEST";
export const CAPABILITY_REQUEST_RECIPIENT_RULE = "provider_dispatcher";
/** `ops.dispatcher_link.purpose` (schema.ts names this value in its own comment). */
export const CAPABILITY_LINK_PURPOSE = "CAPABILITY_VERIFY";
/** `ops.task.category` when there is no dispatcher to ask. §11.2's own exception category. */
export const CAPABILITY_TASK_CATEGORY = "CAPABILITY_UNKNOWN";
/** `ops.task.category` for §11.2's "low confidence → staff review". */
export const CAPABILITY_REVIEW_TASK_CATEGORY = "CAPABILITY_REVIEW";
/**
 * Below this, a parsed report is recorded but asked about: the provider answered, and how well we
 * read their answer is a different question. Chosen rather than derived — there is no calibration
 * to derive it from until live traffic — and deliberately high, because the thing downstream of it
 * is whether a child fits in a van.
 */
export const CAPABILITY_REPORT_MIN_CONFIDENCE = 0.7;
/** What the result says about the link when no signer is configured (see the file header). */
export const LINK_INTENT_RECORDED = "INTENT_RECORDED";
export const LINK_CREATED = "CREATED";

type RouteRow = {
  readonly provider_id: string;
  readonly dispatcher_person_token: string | null;
  readonly service_date: string;
  readonly manifest_vehicle_id: string | null;
  readonly manifest_provider_id: string | null;
  readonly route_start: Date | string | null;
};

type CapabilityRow = { readonly id: string; readonly state: string; readonly version: number };

export function requestProviderCapabilityExecutor(deps: ExecutorDeps): ToolExecutor {
  return async (call) => {
    const vehicleId = String(call.args.vehicle_token ?? "");
    const providerId = String(call.args.provider_token ?? "");
    const routeId = String(call.args.route_token ?? "");
    const required = Array.isArray(call.args.required) ? (call.args.required as string[]) : [];
    const by = actor(call.runId);

    if (!isUuid(vehicleId) || !isUuid(providerId) || !isUuid(routeId)) return notFound("manifest");
    const route = await routeRow(deps.db, { siteId: call.siteId, vehicleId, providerId, routeId });
    if (!route) return notFound("manifest");
    // The route has to be this vehicle's and this provider's, or the three arguments describe
    // something that is not a run anybody drives.
    if (
      (route.manifest_vehicle_id !== null && route.manifest_vehicle_id !== vehicleId)
      || (route.manifest_provider_id !== null && route.manifest_provider_id !== providerId)
    ) {
      return failed("ROUTE_NOT_THIS_VEHICLE", { route_token: routeId });
    }

    const capability = await capabilityRow(deps.db, {
      siteId: call.siteId, vehicleId, serviceDate: route.service_date,
    });
    if (!capability) return notFound("vehicle_capability_day");
    // Already asked — by an earlier run, by the T−90 job, or by this call before it was interrupted.
    // "Asked twice" is not an effect anybody wants, so the answer is the state we found.
    if (capability.state === "REQUESTED") {
      return requested({
        capability, routeId, required, serviceDate: route.service_date,
        linkState: LINK_INTENT_RECORDED, idempotent: true,
      });
    }
    if (capability.state !== "UNKNOWN") {
      return failed("CAPABILITY_NOT_UNKNOWN", { capability_state: capability.state });
    }

    // "at T−90 or on substitution" — see the file header for why a version above 1 is the
    // substitution: the row has been through CHANGED and been reset.
    const substitution = capability.version > 1;
    const minutesToRoute = minutesUntil(route.route_start, call.now);
    if (!substitution && (minutesToRoute === null || minutesToRoute > CAPABILITY_REQUEST_LEAD_MINUTES)) {
      return failed("NOT_YET_DUE", {
        lead_minutes: CAPABILITY_REQUEST_LEAD_MINUTES,
        ...(minutesToRoute === null ? { route_start: null } : { minutes_until_route: minutesToRoute }),
      });
    }

    if (!route.dispatcher_person_token) {
      // Nobody to ask. §11.2's exception category for this is CAPABILITY_UNKNOWN, and a person
      // phones the provider — the row stays UNKNOWN, because no question was put.
      await raiseTask(deps.db, {
        id: effectId(call.idempotencyKey, "no-dispatcher"),
        siteId: call.siteId,
        category: CAPABILITY_TASK_CATEGORY,
        severity: "AMBER",
        words: agentTasks.noDispatcherContact,
        by,
      });
      return failed("NO_DISPATCHER_CONTACT", { provider_token: providerId, task_raised: true });
    }

    const expiresAt = linkExpiry(route.route_start, call.now);
    const linkId = effectId(call.idempotencyKey, "dispatcher-link");
    const signed = deps.linkSigner
      ? await deps.linkSigner.sign({ linkId, siteId: call.siteId, expiresAt })
      : null;

    try {
      const queued = await deps.db.tx(async (tx, afterCommit) => {
        await transition(tx, CAPABILITY, "ops.vehicle_capability_day", {
          id: capability.id,
          version: capability.version,
          from: "UNKNOWN",
          to: "REQUESTED",
          // machines.ts CAPABILITY: `UNKNOWN → REQUESTED` by Y or A. Asking is the agent's; the
          // answer is the provider's (`REPORTED` by P) and the verification staff's.
          actor: "A",
          by,
        });
        if (signed) {
          await tx.query(
            `INSERT INTO ops.dispatcher_link (id, site_id, provider_id, vehicle_id, service_date, purpose,
               token_hash, expires_at, created_by, updated_by, source_mode)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9, 'SIMULATED')
             ON CONFLICT (id) DO NOTHING`,
            [linkId, call.siteId, providerId, vehicleId, route.service_date, CAPABILITY_LINK_PURPOSE,
              signed.tokenHash, expiresAt.toISOString(), by],
          );
        }
        return enqueue(tx, afterCommit, deps.transport, {
          siteId: call.siteId,
          purpose: CAPABILITY_REQUEST_PURPOSE,
          recipientRule: CAPABILITY_REQUEST_RECIPIENT_RULE,
          // Computed here from the provider row, never named by the model (§10.3, tools.ts rule 1).
          recipientToken: route.dispatcher_person_token!,
          // An SMS, so SMS_1TO1 — which is also the channel a dispatcher's own STOP would be
          // recorded on, so the consent check at send time is about the message we are sending.
          // The DISPATCHER_LINK channel is the link *page*, which the outbox does not drain.
          channel: "SMS_1TO1",
          // Fixed copy with no vars, and no child reference: a capability question is about a
          // vehicle. The requirement codes stay on the call row and reach the dispatcher through
          // the link, never through an SMS body.
          templateId: "generic.notice",
          vars: {},
          planVersionBasis: 0,
          notAfter: expiresAt,
          idempotencyKey: call.idempotencyKey,
          by,
        });
      });
      return requested({
        capability, routeId, required, serviceDate: route.service_date,
        linkState: signed ? LINK_CREATED : LINK_INTENT_RECORDED,
        linkId: signed ? linkId : null,
        outboundMessageId: queued.id,
        duplicate: queued.duplicate,
        substitution,
      });
    } catch (e) {
      if (e instanceof StaleOrConflict) return failed("VERSION_CONFLICT", { http_status: 412 });
      if (e instanceof IllegalTransition) return failed("ILLEGAL_TRANSITION", { reason: e.message.slice(0, 200) });
      return failed("ENQUEUE_REFUSED", { reason: (e instanceof Error ? e.message : String(e)).slice(0, 200) });
    }
  };
}

/* ───────────────────────── record_capability_report ───────────────────────── */

export function recordCapabilityReportExecutor(deps: ExecutorDeps): ToolExecutor {
  return async (call) => {
    const vehicleId = String(call.args.vehicle_token ?? "");
    const messageId = String(call.args.source_message_id ?? "");
    const parsed = (call.args.parsed ?? {}) as Record<string, unknown>;
    const confidence = Number(call.args.confidence);
    const by = actor(call.runId);

    if (!isUuid(vehicleId)) return notFound("vehicle");
    if (!isUuid(messageId)) return notFound("message");

    // "from provider contact point": the evidence has to be an inbound message from the dispatcher
    // of the provider that runs this vehicle, matched on the blind index identity holds for them.
    const evidence = await providerEvidence(deps.db, { siteId: call.siteId, vehicleId, messageId });
    if (!evidence) return notFound("message");
    if (!evidence.from_provider) {
      return failed("NOT_FROM_PROVIDER_CONTACT_POINT", { source_message_id: messageId });
    }

    // The day the report is about: the one this run asked about, else the message's own service
    // date (PRD §6.1: a calendar date in the site's zone).
    const serviceDate = factString(call.committed, "request_provider_capability", "service_date")
      ?? evidence.service_date;
    const capability = await capabilityRow(deps.db, { siteId: call.siteId, vehicleId, serviceDate });
    if (!capability) return notFound("vehicle_capability_day");

    const lowConfidence = !Number.isFinite(confidence) || confidence < CAPABILITY_REPORT_MIN_CONFIDENCE;
    if (capability.state === "REPORTED" && evidence.already_recorded) {
      // This exact report is already on the row: a re-driven call, not a second observation.
      return reported({ capability, parsed, confidence, lowConfidence, serviceDate, idempotent: true });
    }
    if (capability.state !== "REQUESTED") {
      return failed("CAPABILITY_NOT_REQUESTED", { capability_state: capability.state });
    }

    try {
      return await deps.db.tx(async (tx) => {
        await transition(tx, CAPABILITY, "ops.vehicle_capability_day", {
          id: capability.id,
          version: capability.version,
          from: "REQUESTED",
          to: "REPORTED",
          // machines.ts CAPABILITY: `REQUESTED → REPORTED` by P. The provider reported it; the
          // agent is writing down their answer, exactly as `record_acknowledgment` records a
          // therapist's. Verification stays staff's (`REPORTED → VERIFIED` by S).
          actor: "P",
          by,
        });
        // The observation's own columns, in the same transaction and after the version guard held.
        const observed = await tx.query<{ version: number }>(
          `UPDATE ops.vehicle_capability_day
             SET lift_ok = $2, observed_at = $3, observed_by = $4, evidence_message_id = $5,
                 version = version + 1, updated_at = now(), updated_by = $4
           WHERE id = $1 AND version = $6 RETURNING version`,
          [capability.id, parsed.lift_present === true, call.now.toISOString(), by, messageId,
            capability.version + 1],
        );
        if (observed.rows.length !== 1) throw new StaleOrConflict(`vehicle_capability_day ${capability.id}: stale`);
        if (lowConfidence) {
          // §11.2: "low confidence → staff review". The answer is kept; the trust is not.
          await raiseTask(tx, {
            id: effectId(call.idempotencyKey, "capability-review"),
            siteId: call.siteId,
            category: CAPABILITY_REVIEW_TASK_CATEGORY,
            severity: "AMBER",
            words: agentTasks.capabilityLowConfidence,
            by,
          });
        }
        return reported({
          capability, parsed, confidence, lowConfidence, serviceDate,
          version: observed.rows[0].version,
        });
      });
    } catch (e) {
      if (e instanceof StaleOrConflict) return failed("VERSION_CONFLICT", { http_status: 412 });
      if (e instanceof IllegalTransition) return failed("ILLEGAL_TRANSITION", { reason: e.message.slice(0, 200) });
      throw e;
    }
  };
}

/** What `record_capability_report` reports. The parsed numbers are codes and counts, never prose. */
function reported(a: {
  capability: CapabilityRow;
  parsed: Record<string, unknown>;
  confidence: number;
  lowConfidence: boolean;
  serviceDate: string;
  version?: number;
  idempotent?: boolean;
}): ToolExecution {
  const layoutCode = typeof a.parsed.layout_code === "string" ? a.parsed.layout_code : null;
  return {
    status: "executed",
    data: {
      capability_id: a.capability.id,
      capability_state: "REPORTED",
      service_date: a.serviceDate,
      // Kept here because the vehicle-day row has no column for them (see the file header).
      parsed: a.parsed,
      confidence: Number.isFinite(a.confidence) ? a.confidence : null,
      staff_review: a.lowConfidence,
      ...(a.version === undefined ? {} : { capability_version: a.version }),
      ...(a.idempotent ? { idempotent: true } : {}),
    },
    promptFacts: {
      capability_state: "REPORTED",
      capability_id: a.capability.id,
      service_date: a.serviceDate,
      lift_present: a.parsed.lift_present === true,
      ...(layoutCode ? { layout_code: layoutCode } : {}),
      staff_review: a.lowConfidence,
      ...(a.idempotent ? { idempotent: true } : {}),
    },
  };
}

/* ───────────────────────────── the pieces ───────────────────────────── */

/**
 * The route, with the provider's dispatcher contact point and the route's planned start. One query,
 * because all three ids have to be this site's for any of them to mean anything.
 */
async function routeRow(
  db: Exec,
  a: { siteId: string; vehicleId: string; providerId: string; routeId: string },
): Promise<RouteRow | null> {
  const r = await db.query<RouteRow>(
    `SELECT p.id AS provider_id, p.dispatcher_person_token,
            to_char(m.service_date, 'YYYY-MM-DD') AS service_date,
            m.vehicle_id AS manifest_vehicle_id, m.provider_id AS manifest_provider_id,
            (SELECT min(l.window_start) FROM ops.trip_leg l WHERE l.manifest_id = m.id) AS route_start
     FROM ops.manifest m, ops.vehicle v, ops.provider p
     WHERE m.id = $1 AND v.id = $2 AND p.id = $3
       AND m.site_id = $4 AND v.site_id = $4 AND p.site_id = $4`,
    [a.routeId, a.vehicleId, a.providerId, a.siteId],
  );
  return r.rows[0] ?? null;
}

/**
 * The evidence message, with the two things that decide whether it may be recorded: was it sent
 * from this vehicle's provider's dispatcher contact point, and is it already the row's evidence?
 *
 * The join is the same direction `resolve_sender` and the inbound handler use — a blind index
 * against the identity table, never a number — and it is anchored on the *vehicle's* provider, so a
 * report about a van from somebody else's dispatcher matches nothing.
 */
async function providerEvidence(
  db: Exec,
  a: { siteId: string; vehicleId: string; messageId: string },
): Promise<{ service_date: string; from_provider: boolean; already_recorded: boolean } | null> {
  const r = await db.query<{ service_date: string; from_provider: boolean; already_recorded: boolean }>(
    `SELECT to_char(m.received_at AT TIME ZONE st.timezone, 'YYYY-MM-DD') AS service_date,
            EXISTS (
              SELECT 1 FROM ops.vehicle v
              JOIN ops.provider p ON p.id = v.provider_id
              JOIN identity.external_person_identity x ON x.person_token = p.dispatcher_person_token
              WHERE v.id = $3 AND v.site_id = $2 AND p.site_id = $2 AND x.site_id = $2
                AND x.phone_hmac = m.from_hmac
            ) AS from_provider,
            EXISTS (
              SELECT 1 FROM ops.vehicle_capability_day c
              WHERE c.site_id = $2 AND c.vehicle_id = $3 AND c.evidence_message_id = m.id
            ) AS already_recorded
     FROM ops.message m
     JOIN ops.site st ON st.id = m.site_id
     WHERE m.id = $1 AND m.site_id = $2 AND m.direction = 'IN' AND m.is_own_echo = false`,
    [a.messageId, a.siteId, a.vehicleId],
  );
  return r.rows[0] ?? null;
}

export async function capabilityRow(
  db: Exec,
  a: { siteId: string; vehicleId: string; serviceDate: string },
): Promise<CapabilityRow | null> {
  const r = await db.query<CapabilityRow>(
    `SELECT id, state, version FROM ops.vehicle_capability_day
     WHERE site_id = $1 AND vehicle_id = $2 AND service_date = $3`,
    [a.siteId, a.vehicleId, a.serviceDate],
  );
  return r.rows[0] ?? null;
}

/** Whole minutes from `now` to the route's start, or null when no leg on it has a window. */
function minutesUntil(routeStart: Date | string | null, now: Date): number | null {
  if (routeStart === null) return null;
  return Math.round((new Date(routeStart).getTime() - now.getTime()) / 60_000);
}

/** Route start or four hours, whichever is sooner — and never in the past (ARCHITECTURE §3.3). */
function linkExpiry(routeStart: Date | string | null, now: Date): Date {
  const cap = new Date(now.getTime() + CAPABILITY_LINK_MAX_HOURS * 3_600_000);
  if (routeStart === null) return cap;
  const start = new Date(routeStart);
  return start.getTime() > now.getTime() && start.getTime() < cap.getTime() ? start : cap;
}

/**
 * What the tool reports, and the §11.2 "no reply → escalate" wait: a staff task plus a B-03 timer
 * whose predicate is the vehicle-day reaching REPORTED. The escalation past that deadline is
 * `run/escalate.ts`'s, and it needs no model turn.
 */
function requested(a: {
  capability: CapabilityRow;
  routeId: string;
  required: readonly string[];
  serviceDate: string;
  linkState: string;
  linkId?: string | null;
  outboundMessageId?: string;
  duplicate?: boolean;
  substitution?: boolean;
  idempotent?: boolean;
}): ToolExecution {
  return {
    status: "executed",
    data: {
      capability_id: a.capability.id,
      capability_state: "REQUESTED",
      service_date: a.serviceDate,
      route_token: a.routeId,
      // Codes, as the model sent them: what the dispatcher is being asked to confirm.
      required: a.required,
      link_state: a.linkState,
      ...(a.linkId ? { dispatcher_link_id: a.linkId } : {}),
      ...(a.outboundMessageId ? { outbound_message_id: a.outboundMessageId } : {}),
      ...(a.duplicate === undefined ? {} : { duplicate: a.duplicate }),
      ...(a.substitution ? { substitution: true } : {}),
      ...(a.idempotent ? { idempotent: true } : {}),
    },
    promptFacts: {
      capability_requested: true,
      capability_id: a.capability.id,
      capability_state: "REQUESTED",
      service_date: a.serviceDate,
      required_count: a.required.length,
      link_state: a.linkState,
      ...(a.substitution ? { substitution: true } : {}),
      ...(a.idempotent ? { idempotent: true } : {}),
    },
    awaitExternal: {
      reasonCode: "CAPABILITY_REPORT",
      afterSeconds: CAPABILITY_REPLY_SECONDS,
      summary: agentWaits.capabilityReport,
      completionPredicate: PREDICATE_CAPABILITY_REPORTED,
    },
  };
}
