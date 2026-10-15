/**
 * §11.2 `notify_affected_therapist(therapy_id, child, impact, eta)` — "overlapping session on date
 * → minimized SMS; status THERAPIST_NOTIFIED", and the half of **AT-14** that is ours: "therapist
 * notified ≤10 min, ack tracked".
 *
 * Four things happen, in one transaction, and none of them is the model's to decide:
 *
 *  - **the overlapping session is looked up here.** §11.2's precondition is a session *on the date
 *    of the impact*, so the date comes from what this run established by reading — the committed
 *    `cancel_attendance_or_leg` / `resolve_sender` / `get_leg_state` service date — and the session
 *    has to be on that date, in the **site's** timezone (PRD §6.1: a service date is a calendar
 *    date in the site's zone, not an instant), for the child the call names. A session on another
 *    day, for another child, or already CANCELED is not an overlapping session and nothing is sent.
 *  - **the SMS is minimized, and this module chooses it.** The tool declares `sendCopy: fixed`
 *    (tools.ts) — the model supplies no template id and no vars at all — so the impact *code* picks
 *    one of the outbox's therapist bodies and the only value that rides with it is the session's
 *    start time (and an ETA, when the impact is lateness). No name, no number, no prose: what
 *    reaches the provider is a template id and two clock times.
 *  - **the session's status moves to THERAPIST_NOTIFIED**, guarded on the version just read. The
 *    therapy-session status is a §3 text column with no row in `machines.ts` (that file holds the
 *    §6.3 machines, which are frozen and actor-typed), so its two legal edges are written out below
 *    and guarded the same way every other write here is: `WHERE id = … AND version = … AND
 *    status = <from>`, zero rows meaning somebody moved it first.
 *  - **the acknowledgment is tracked**: a PENDING `ops.acknowledgment` for that message, due in ten
 *    minutes, and the run parks on a B-03 timer rather than waiting (§11.1). The reply side is
 *    §11.2 `record_acknowledgment`, which closes that row and cancels the deadline.
 *
 * Idempotent on the call's key like every other executor: the acknowledgment row's id is derived
 * from it, so a re-driven call finds its own receipt and answers with the state it left.
 */
import type { Exec } from "@/db/exec";
import { enqueue } from "@/modules/outbox/outbox";
import { agentWaits } from "@/ui/copy";
import type { ToolExecution, ToolExecutor } from "../executors";
import {
  type ExecutorDeps,
  actor,
  effectId,
  factString,
  failed,
  isUuid,
  notFound,
} from "./effects";
import { PREDICATE_ACK_CLOSED } from "./predicate";

/** AT-14: "therapist notified ≤10 min, ack tracked" — the ack's own deadline. */
export const THERAPIST_ACK_SECONDS = 10 * 60;
/** `ops.outbound_message.purpose` / `.recipient_rule`, the same pair `send_followup` uses. */
export const THERAPIST_ALERT_PURPOSE = "THERAPIST_ALERT";
export const THERAPIST_ALERT_RECIPIENT_RULE = "therapist_of_session";
/** `ops.therapy_session.status` (§3), the four values the column's comment names. */
export const THERAPIST_NOTIFIED = "THERAPIST_NOTIFIED";
/** The statuses a notification may move from: a session nobody has told them about yet. */
const NOTIFIABLE_STATUSES: readonly string[] = ["SCHEDULED", "IMPACTED"];

/**
 * Which allow-listed body each §11.2 impact code sends. The model picks the *impact*, never the
 * words: an absence and a late arrival have their own bodies (B-05 `messaging/templates.ts`), and
 * an early pickup has none yet, so it goes out as the fixed-copy notice — "there is an update,
 * please call us" — rather than as a body that says something we have not written.
 */
const IMPACT_TEMPLATES: Readonly<Record<string, string>> = {
  ABSENT: "therapist.absence_alert",
  LATE: "therapist.late_alert",
  EARLY_PICKUP: "generic.notice",
};

type SessionRow = {
  readonly id: string;
  readonly child_token: string;
  readonly person_token: string;
  readonly status: string;
  readonly version: number;
  /** Site-local, so a session at 09:00 in Florida reads 09:00 whatever zone the process booted in. */
  readonly session_date: string;
  readonly session_start: string;
};

export function notifyAffectedTherapistExecutor(deps: ExecutorDeps): ToolExecutor {
  return async (call) => {
    const sessionId = String(call.args.therapy_session_token ?? "");
    const childToken = String(call.args.child_token ?? "");
    const impact = String(call.args.impact ?? "");
    const eta = typeof call.args.eta === "string" ? call.args.eta : null;
    const by = actor(call.runId);

    const templateId = IMPACT_TEMPLATES[impact];
    if (!templateId) return failed("UNSUPPORTED_IMPACT", { impact });
    if (!isUuid(sessionId) || !isUuid(childToken)) return notFound("therapy_session");

    const session = await sessionRow(deps.db, { siteId: call.siteId, sessionId });
    if (!session) return notFound("therapy_session");
    // The child the model named has to be the session's own child. Not an authorization check (the
    // policy engine already refused a token outside this run's scope) but a §11.2 precondition: a
    // session about another child is not this child's overlapping session.
    if (session.child_token !== childToken) return notFound("therapy_session");

    // "overlapping session on date". The date is this run's, read out of the committed results —
    // never an argument, because the whole point of the precondition is that the session overlaps
    // the day the agent actually changed something about.
    const serviceDate = runServiceDate(call.committed);
    if (serviceDate && session.session_date !== serviceDate) {
      return failed("NO_OVERLAPPING_SESSION", { service_date: serviceDate, session_date: session.session_date });
    }

    const ackId = effectId(call.idempotencyKey, "therapist-ack");
    const already = await ackRow(deps.db, { siteId: call.siteId, ackId });
    if (already) {
      // This exact call already ran: the loop is re-driving a step interrupted between its effect
      // and its commit. Answer with the state it left rather than notifying a second time.
      return notified({
        session, ackId, impact, templateId,
        outboundMessageId: already.outbound_message_id,
        ackState: already.state,
        idempotent: true,
      });
    }
    if (!NOTIFIABLE_STATUSES.includes(session.status)) {
      return failed("SESSION_NOT_NOTIFIABLE", { session_status: session.status });
    }

    const vars: Record<string, unknown> = templateId === "generic.notice"
      ? {}
      : { sessionStart: session.session_start, ...(impact === "LATE" && eta ? { eta } : {}) };

    try {
      const queued = await deps.db.tx(async (tx, afterCommit) => {
        const message = await enqueue(tx, afterCommit, deps.transport, {
          siteId: call.siteId,
          purpose: THERAPIST_ALERT_PURPOSE,
          recipientRule: THERAPIST_ALERT_RECIPIENT_RULE,
          // Computed here from the session, never named by the model (§10.3, tools.ts rule 1).
          recipientToken: session.person_token,
          channel: "SMS_1TO1",
          templateId,
          vars,
          childToken: session.child_token,
          therapySessionId: session.id,
          // No leg behind this message: it is about a session, so there is no plan to be stale
          // against. The therapist's authorization for the child is re-checked at send time.
          planVersionBasis: 0,
          notAfter: new Date(call.now.getTime() + THERAPIST_ACK_SECONDS * 1000),
          idempotencyKey: call.idempotencyKey,
          by,
        });
        const moved = await markNotified(tx, { session, by });
        if (!moved) throw new SessionMoved(session.id);
        await tx.query(
          `INSERT INTO ops.acknowledgment (id, site_id, outbound_message_id, contact_token, state, due_at,
             created_by, updated_by, source_mode)
           VALUES ($1, $2, $3, $4, 'PENDING', $5, $6, $6, 'SIMULATED')
           ON CONFLICT (id) DO NOTHING`,
          [ackId, call.siteId, message.id, session.person_token,
            new Date(call.now.getTime() + THERAPIST_ACK_SECONDS * 1000).toISOString(), by],
        );
        return message;
      });
      return notified({
        session, ackId, impact, templateId,
        outboundMessageId: queued.id,
        ackState: "PENDING",
        duplicate: queued.duplicate,
      });
    } catch (e) {
      if (e instanceof SessionMoved) return failed("VERSION_CONFLICT", { http_status: 412 });
      // The outbox refused to hold it (an unknown template, a var it does not permit). A policy
      // failure the engine should have caught, so the honest outcome is a failed step.
      return failed("ENQUEUE_REFUSED", { reason: (e instanceof Error ? e.message : String(e)).slice(0, 200) });
    }
  };
}

/** The session's status moved under us between the read and the write. */
class SessionMoved extends Error {}

/* ───────────────────────────── the pieces ───────────────────────────── */

/**
 * The session, its therapist's person token, and the session's **site-local** date and start time.
 *
 * Both of the time values are computed in the site's zone by the database (`AT TIME ZONE
 * site.timezone`) rather than in the process, because the process's zone is whatever the serverless
 * instance booted in: a `09:00` rendered from local time would be right under TZ=America/New_York
 * and an hour or five out anywhere else (run/timers.test.ts holds the same line for deadlines).
 */
async function sessionRow(db: Exec, a: { siteId: string; sessionId: string }): Promise<SessionRow | null> {
  const r = await db.query<SessionRow>(
    `SELECT s.id, s.child_token, t.person_token, s.status, s.version,
            to_char(s.starts_at AT TIME ZONE st.timezone, 'YYYY-MM-DD') AS session_date,
            to_char(s.starts_at AT TIME ZONE st.timezone, 'HH24:MI') AS session_start
     FROM ops.therapy_session s
     JOIN ops.therapist t ON t.id = s.therapist_id
     JOIN ops.site st ON st.id = s.site_id
     WHERE s.id = $1 AND s.site_id = $2 AND s.status <> 'CANCELED'`,
    [a.sessionId, a.siteId],
  );
  return r.rows[0] ?? null;
}

async function ackRow(
  db: Exec,
  a: { siteId: string; ackId: string },
): Promise<{ state: string; outbound_message_id: string } | null> {
  const r = await db.query<{ state: string; outbound_message_id: string }>(
    "SELECT state, outbound_message_id FROM ops.acknowledgment WHERE id = $1 AND site_id = $2",
    [a.ackId, a.siteId],
  );
  return r.rows[0] ?? null;
}

/** The service date this run established by reading, or null when it read none. */
function runServiceDate(committed: Parameters<ToolExecutor>[0]["committed"]): string | null {
  return factString(committed, "cancel_attendance_or_leg", "service_date")
    ?? factString(committed, "resolve_sender", "service_date")
    ?? factString(committed, "get_leg_state", "leg_date");
}

/**
 * `SCHEDULED | IMPACTED → THERAPIST_NOTIFIED`, guarded on the version read with the row. `false`
 * means the row moved first — staff told them, or another run did — and nothing was written.
 */
async function markNotified(tx: Exec, a: { session: SessionRow; by: string }): Promise<boolean> {
  const r = await tx.query<{ version: number }>(
    `UPDATE ops.therapy_session SET status = $1, version = version + 1, updated_at = now(), updated_by = $2
     WHERE id = $3 AND version = $4 AND status = $5 RETURNING version`,
    [THERAPIST_NOTIFIED, a.by, a.session.id, a.session.version, a.session.status],
  );
  return r.rows.length === 1;
}

/**
 * What the tool reports, and what the run waits for. The §11.1 await is a staff task plus a B-03
 * timer with a coded predicate, so the ten minutes are a row and a job rather than a held session —
 * and `record_acknowledgment` closing that ack is what satisfies it.
 *
 * A re-driven call whose acknowledgment has **already** been answered waits for nothing: the thing
 * the await was for has happened, so the run takes its next turn instead of parking on a deadline
 * that is nobody's any more.
 */
function notified(a: {
  session: SessionRow;
  ackId: string;
  impact: string;
  templateId: string;
  outboundMessageId: string;
  ackState: string;
  duplicate?: boolean;
  idempotent?: boolean;
}): ToolExecution {
  return {
    status: "executed",
    data: {
      therapy_session_id: a.session.id,
      session_status: THERAPIST_NOTIFIED,
      impact: a.impact,
      template_id: a.templateId,
      outbound_message_id: a.outboundMessageId,
      ack_id: a.ackId,
      ack_state: a.ackState,
      ...(a.duplicate === undefined ? {} : { duplicate: a.duplicate }),
      ...(a.idempotent ? { idempotent: true } : {}),
    },
    promptFacts: {
      therapist_notified: true,
      session_status: THERAPIST_NOTIFIED,
      impact: a.impact,
      ack_id: a.ackId,
      ack_state: a.ackState,
      ...(a.idempotent ? { idempotent: true } : {}),
    },
    ...(a.ackState === "PENDING"
      ? {
          awaitExternal: {
            reasonCode: "THERAPIST_ACK",
            afterSeconds: THERAPIST_ACK_SECONDS,
            summary: agentWaits.therapistAck,
            completionPredicate: PREDICATE_ACK_CLOSED,
          },
        }
      : {}),
  };
}
