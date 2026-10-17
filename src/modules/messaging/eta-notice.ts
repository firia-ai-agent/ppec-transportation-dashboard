/**
 * The deterministic ETA notice: a notify-gate decision, queued as one text (PRD §18.2 step 7
 * "one damped 10-min window SMS to downstream families only; jitter suppressed", AT-03).
 *
 * PRD §11.1 is explicit that this path takes **no model turn**: "ETA threshold (deterministic →
 * template)", which is also why it starts no agent run (`run/triggers.ts`). So the whole of it is
 * three existing pieces joined up, and this module is the joint:
 *
 *   src/domain/eta (replay → ETA → notify gate: *decisions*)
 *     → here (one decision + the ride it is about → one `EnqueueInput`)
 *       → src/modules/outbox (ADR-003: queue, send-time re-checks, the SIM adapter)
 *
 * Nothing here decides *whether* a family is told — ASM-14's hysteresis already did, in the gate
 * (`evaluateStop`), which is the module that owns "is this worth a text". What this module owns is
 * the three things the gate deliberately does not:
 *
 *  1. **the threshold is a deployment setting.** The gate's defaults are ASM-14's numbers; the
 *     operator's are read here, from the environment, once (`loadEtaNoticeConfig`) and handed to
 *     the gate as `NotifyThresholds`. No caller carries a number of its own.
 *  2. **once per ride per threshold crossing.** The idempotency key is the leg plus the window the
 *     crossing published (`etaNoticeKey`), and the outbox is idempotent on it (`ON CONFLICT
 *     (idempotency_key) DO NOTHING`). A second sweep over the same replay, a redelivered queue
 *     message and a re-run of the whole drive all collapse onto the one row — and the gate's own
 *     `same-window` rule means a crossing that would publish the window the family already holds
 *     never gets here at all.
 *  3. **who gets it, and on what authority.** The recipients are the contacts §6.4 authorizes for
 *     *that child* (`authorizedContactsForChild`, the same query the agent's follow-up uses and the
 *     same authorization the drainer re-checks per contact before anything leaves), never a number
 *     from a fixture and never a contact this module chose.
 *
 * What the family reads is the outbox's own copy (`dropoff.late` / `pickup.eta` in
 * src/ui/copy.ts): how late the van is, and the §8 10-minute window — no child's name, no ride id,
 * no threshold and no internal code (COPY-GUIDE §2, Veri #12).
 */
import { z } from "zod";
import type { Db, Exec } from "@/db/exec";
import { formatClock24 } from "@/domain/eta/eta";
import {
  ASM14_THRESHOLDS,
  NOTIFY_SHIFT_SECONDS,
  type NotificationDecision,
  type NotifyThresholds,
} from "@/domain/eta/notify-gate";
import { enqueue, type OutboxTransport } from "@/modules/outbox/outbox";
import { FAMILY_SMS, authorizedContactsForChild } from "@/modules/outbox/policy";

/* ───────────────────────────── config ───────────────────────────── */

/**
 * The one knob: how far an arrival has to move before a family is texted about it, in seconds.
 *
 * Unset is ASM-14's own 10 minutes, so a deployment that configures nothing behaves exactly as the
 * PRD says. The bounds are the part worth arguing about: under a minute is a deployment that would
 * text a family about traffic noise, and over an hour is one that would never text at all, and
 * neither is a setting an operator can have meant. Out of range, unreadable or empty falls back to
 * the default rather than refusing — this is a notification threshold, not a boot guard, and an
 * app that will not start is a worse answer than one that uses the documented number.
 */
export const LATE_SHIFT_ENV_VAR = "ETA_LATE_SHIFT_SECONDS";

export const etaNoticeConfigSchema = z.object({
  lateShiftSeconds: z.coerce.number().int().min(60).max(3600).default(NOTIFY_SHIFT_SECONDS),
});

export type EtaNoticeConfig = z.infer<typeof etaNoticeConfigSchema>;

export function loadEtaNoticeConfig(
  env: Record<string, string | undefined> = process.env,
): EtaNoticeConfig {
  const parsed = etaNoticeConfigSchema.safeParse({ lateShiftSeconds: env[LATE_SHIFT_ENV_VAR] });
  return parsed.success ? parsed.data : { lateShiftSeconds: NOTIFY_SHIFT_SECONDS };
}

/**
 * The gate's thresholds for this deployment: ASM-14's, with the configured shift in place of its
 * 10 minutes. The improvement threshold moves with it when the operator raises it past ASM-14's
 * 15 minutes, because "an improvement worth a text" can never be *smaller* than "a delay worth a
 * text" — a deployment that texted about a 12-minute gain and stayed silent about a 12-minute loss
 * would be telling families the good news only.
 */
export function notifyThresholds(config: EtaNoticeConfig): NotifyThresholds {
  return {
    ...ASM14_THRESHOLDS,
    shiftSeconds: config.lateShiftSeconds,
    improvementSeconds: Math.max(ASM14_THRESHOLDS.improvementSeconds, config.lateShiftSeconds),
  };
}

/* ───────────────────────────── one notice ───────────────────────────── */

/** A follow-up that has not left in this long is not worth sending (cf. FOLLOWUP_NOT_AFTER_MS). */
export const ETA_NOTICE_NOT_AFTER_MS = 30 * 60_000;

/** Lateness is said in 5-minute steps, because "about 15 minutes late" is what it is. */
export const LATE_MINUTES_STEP = 5;

/**
 * How late the van is, as a family would say it: whole 5-minute steps, never less than one.
 *
 * The §8 damping already rounds the *arrival* to a 10-minute window, so a minute-precise "13
 * minutes late" beside a 10-minute window would be precision the estimate does not have. One step
 * is the floor because the gate only opens at the configured threshold, and a text that said
 * "about 0 minutes late" would be a bug a family reads.
 */
export function lateMinutesFor(shiftSeconds: number): number {
  const minutes = Math.round(shiftSeconds / 60 / LATE_MINUTES_STEP) * LATE_MINUTES_STEP;
  return Math.max(LATE_MINUTES_STEP, minutes);
}

/**
 * Which allow-listed body a late ride gets. The afternoon is a drop-off and the morning a pickup,
 * and `dropoff.late` is the one that says the van has lost time (the §18.2 step 7 text); a morning
 * run reuses the existing `pickup.eta`, whose body is already about a van on its way.
 */
export function etaNoticeTemplate(direction: "AM" | "PM"): string {
  return direction === "PM" ? "dropoff.late" : "pickup.eta";
}

/**
 * The ride a decision is about, from the operational tables. Supplied by the caller because
 * *which* leg a stop belongs to is a question about the day's plan, not about the ETA engine.
 */
export type NoticeRide = {
  readonly siteId: string;
  readonly legId: string;
  readonly childToken: string;
  readonly direction: "AM" | "PM";
  /** The leg's plan version *now*: the basis the send-time check compares against (AT-08). */
  readonly planVersion: number;
  /** The short stop token the outbox permits; the place name is resolved at render time. */
  readonly stopToken: string;
};

/**
 * One text per ride per threshold crossing.
 *
 * The crossing is named by the window it published, not by the instant it happened: two sweeps of
 * the same replay compute the same window and so the same key, while a later crossing publishes a
 * different window and gets its own text (the gate refuses to re-publish an unchanged window at
 * all — `same-window`). So this is idempotent across redeliveries without anybody having to
 * remember what was already sent.
 */
export function etaNoticeKey(legId: string, windowStartMs: number): string {
  return `eta-notice:${legId}:${formatClock24(windowStartMs)}`;
}

/** The vars the body is rendered from: a 10-minute window, a stop token, and whole minutes late. */
export function etaNoticeVars(
  decision: NotificationDecision,
  ride: NoticeRide,
): Record<string, string | number> {
  const eta = formatClock24(decision.windowStartMs ?? decision.atMs);
  const vars: Record<string, string | number> = { eta, stopLabel: ride.stopToken };
  if (decision.windowEndMs !== undefined) vars.etaEnd = formatClock24(decision.windowEndMs);
  if (etaNoticeTemplate(ride.direction) === "dropoff.late") {
    vars.delayMinutes = lateMinutesFor(decision.shiftSeconds);
  }
  return vars;
}

export type EnqueuedNotice = {
  /** One row per authorized contact (§10.1 "Fan-out 1:1 broadcast"). */
  readonly messageIds: readonly string[];
  /** True when every row already existed: this crossing has already been told to this family. */
  readonly duplicate: boolean;
};

/** Why nothing was queued. Each one is a decision about the data, never a thrown error. */
export type NoticeSkip = "not-notified" | "no-window" | "no-authorized-contact";

export type EnqueueNoticeResult = EnqueuedNotice | { readonly skipped: NoticeSkip };

/**
 * Queue one gate decision as one text per authorized contact, in a single transaction.
 *
 * The three refusals, in the order they are reachable:
 *  - a decision the gate **suppressed** queues nothing. This is the AT-03 rule itself: a stop the
 *    van has passed, a jitter-sized shift, a stale GPS fix, a stop under ten minutes away and a
 *    window that has not changed are all SUPPRESS, and a module that queued on them would undo the
 *    hysteresis it is downstream of;
 *  - a NOTIFY with no published window has no §8 10-minute window to send, and this path never
 *    sends a minute-precise time;
 *  - a child with no §6.4-authorized contact has nobody to tell. Silence, not an error: the
 *    operational answer is a staff task, and raising one belongs to the surfaces that own tasks.
 *
 * One transaction for the whole fan-out, like the agent's follow-up: a crash cannot tell one parent
 * and not the other.
 */
export async function enqueueEtaNotice(
  db: Db,
  transport: OutboxTransport,
  a: {
    readonly decision: NotificationDecision;
    readonly ride: NoticeRide;
    readonly now: Date;
    readonly by: string;
  },
): Promise<EnqueueNoticeResult> {
  const { decision, ride } = a;
  if (decision.outcome !== "NOTIFY") return { skipped: "not-notified" };
  if (decision.windowStartMs === undefined) return { skipped: "no-window" };

  const contacts = await authorizedContactsForChild(db, {
    siteId: ride.siteId,
    childToken: ride.childToken,
    at: a.now,
  });
  if (contacts.length === 0) return { skipped: "no-authorized-contact" };

  const templateId = etaNoticeTemplate(ride.direction);
  const vars = etaNoticeVars(decision, ride);
  const key = etaNoticeKey(ride.legId, decision.windowStartMs);

  return db.tx(async (tx: Exec, afterCommit) => {
    const rows = [];
    for (const recipientToken of contacts) {
      rows.push(
        await enqueue(tx, afterCommit, transport, {
          siteId: ride.siteId,
          purpose: FAMILY_SMS.purpose,
          recipientRule: FAMILY_SMS.recipientRule,
          recipientToken,
          channel: FAMILY_SMS.channel,
          templateId,
          vars,
          childToken: ride.childToken,
          tripLegId: ride.legId,
          planVersionBasis: ride.planVersion,
          notAfter: new Date(a.now.getTime() + ETA_NOTICE_NOT_AFTER_MS),
          // One key per contact: the fan-out is idempotent per recipient, so a retry that
          // reaches a family already told does not queue a second copy for the other parent.
          idempotencyKey: contacts.length > 1 ? `${key}:${recipientToken}` : key,
          by: a.by,
        }),
      );
    }
    return {
      messageIds: rows.map((r) => r.id),
      duplicate: rows.every((r) => r.duplicate),
    };
  });
}
