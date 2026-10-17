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
 *  1. **the threshold is config, never a literal.** It is one row of the §8 parameter table
 *     (`notifyGateConfig`, src/config/live.ts), read through `etaNoticeThresholds()` and handed
 *     to the gate as `NotifyThresholds`. No caller — not this module, not the demo projection,
 *     not a test — carries a number of its own, and tuning it is one edit to that table with the
 *     tests that hold it. Deliberately not an environment variable: these are the numbers the
 *     safety story is told against, and a deployment that could quietly raise them would make
 *     every test of ASM-14 and LOC-03 meaningless (src/config/live.ts says so at length).
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
import type { Db, Exec } from "@/db/exec";
import { formatClock24 } from "@/domain/eta/eta";
import {
  ASM14_THRESHOLDS,
  type NotificationDecision,
  type NotifyThresholds,
} from "@/domain/eta/notify-gate";
import { isDemoMode, isSyntheticDemo } from "@/lib/env";
import { demoLegId } from "@/modules/demo/fixtures/standard";
import { enqueue, type OutboxTransport } from "@/modules/outbox/outbox";
import { FAMILY_SMS, authorizedContactsForChild } from "@/modules/outbox/policy";
import { serviceDateIso } from "@/ui/service-date";

/* ───────────────────────────── config ───────────────────────────── */

/**
 * The thresholds this path judges a ride by: the §8 parameter table and nothing else
 * (`notifyGateConfig` → `ASM14_THRESHOLDS`). A function rather than a re-export because it is the
 * named seam every caller on this path goes through — the sweep, the demo projection and the
 * tests — so there is one line to change the day the ETA notice wants its own calibration, and
 * one place to look for where the number came from.
 */
export function etaNoticeThresholds(): NotifyThresholds {
  return ASM14_THRESHOLDS;
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
 * One text per ride per threshold crossing, **on one scenario day**.
 *
 * The crossing is named by the window it published, not by the instant it happened: two sweeps of
 * the same replay compute the same window and so the same key, while a later crossing publishes a
 * different window and gets its own text (the gate refuses to re-publish an unchanged window at
 * all — `same-window`). So this is idempotent across redeliveries without anybody having to
 * remember what was already sent.
 *
 * The **scenario date** is in the key because a window is only a time of day. A leg id is seeded
 * deterministically (`demoLegId`), so C2's afternoon leg has the same id on every reset — and
 * "4:30 PM" is the same four characters tomorrow as today. Without the date, the second day of a
 * demo would compute a key the first day already wrote, `ON CONFLICT DO NOTHING` would swallow it,
 * and the family would be told nothing at all about a ride that really is late. The date comes off
 * the window itself rather than off a wall clock, so it is the scenario's date (§8: acceleration
 * applies to the scenario clock, never to anything derived from a carrier timestamp) and two
 * sweeps of the same crossing still agree.
 */
export function etaNoticeKey(legId: string, windowStartMs: number): string {
  return `eta-notice:${legId}:${serviceDateIso(new Date(windowStartMs))}:${formatClock24(windowStartMs)}`;
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

/* ───────────────────────── the sweep: the demo day's own crossings ───────────────────────── */

/**
 * One ride the demo day's replay says a family should have been told about.
 *
 * It names the ride the way the *scenario* does — a fixture child key and a day part — because
 * that is what a replay knows: the gate's decisions are about route stops, and which child rides
 * from a stop is a fact about the plan (src/fixtures/run-routes.ts). Everything else about the
 * ride is read from the operational row here, so nothing about the leg is assumed from a fixture.
 */
export type DueEtaNotice = {
  readonly decision: NotificationDecision;
  /** Fixture child key, e.g. "C2". Resolved to this child's seeded leg row. */
  readonly childKey: string;
  readonly direction: "AM" | "PM";
  /** The child's short stop token (the fixture's `smsToken`). */
  readonly stopToken: string;
};

/**
 * Leg states a text about an arrival would be wrong for: the ride is not happening, is over, or
 * has already gone wrong in a way a coordinator is holding. A family whose child's ride was
 * canceled must not then be told when the van will reach them (AT-08 is the same rule at send
 * time; this is the earlier refusal).
 */
const NOT_RIDABLE: ReadonlySet<string> = new Set([
  "CANCELED_TRANSPORT", "CANCELED_ATTENDANCE", "NO_SHOW", "COMPLETED_HANDOFF",
  "HELD_NO_RECEIVER", "LEFT_BEHIND_CAPACITY", "EXCEPTION",
]);

export type SweepSkip = NoticeSkip | "no-leg" | "leg-not-ridable" | "not-yet";

export type EtaNoticeSweepReport = {
  /** Rows written by this sweep. */
  readonly queued: number;
  /** Crossings already told to this family — the idempotency key did its job. */
  readonly duplicates: number;
  readonly skipped: Readonly<Partial<Record<SweepSkip, number>>>;
};

/** Why the sweep did nothing at all. A deployment, not an error. */
export type SweepRefusal = { readonly skipped: "not a demo deployment" };

/**
 * Queue every crossing **whose time has come**, idempotently. Called from the one-minute sweep
 * (`/api/cron/sweep`), which is where ARCHITECTURE §6 puts work that nobody's request is waiting
 * for — and the reason the text exists in the database *during the demo day* rather than only
 * when somebody opens a screen.
 *
 * ## Two clocks, and why this takes both
 *
 * `now` is **wall time**: it stamps the row and cuts the outbox's `not_after`, and PRD §8 is
 * explicit that acceleration never touches a carrier timestamp, so it must stay the real clock.
 *
 * `scenarioNow` is **the scenario clock's now** — the instant the demo day has been walked to
 * (`domain/eta/scenario-clock.ts` through `board/day.demoDayAtTick`). It is what decides whether a
 * crossing has happened *yet*, because a crossing's `atMs` is a scenario instant and comparing it
 * to a wall clock is comparing two different days.
 *
 * Before this argument existed the sweep queued **every** crossing the replay holds the first time
 * it ran after a reset — the whole afternoon's worth of texts, at six in the morning, in one
 * minute. A family's phone then held a text about a van that had not left, which is the one thing
 * a demo of this feature must not show. Now a crossing still in the scenario's future is skipped
 * by name (`not-yet`) and queued by a later sweep, once, when its time has actually passed; the
 * idempotency key does the rest.
 *
 * There is no clock control on any deployment (`requestedScenarioTick` refuses wherever
 * `VERCEL_ENV` is set), so in production this is the board's own instant and the afternoon's texts
 * stay ahead of it — which is correct, and is why the phone panel projects what the day *will*
 * send rather than claiming it was sent.
 *
 * Gated on the ADR-015 data class **and** the ADR-014 demo switch, both, because this queues
 * messages derived from a committed replay: on a deployment holding real data there is no
 * scenario to replay and a text about a fixture's van would be a message to a real family. The
 * refusal is a value, not a throw — the sweep logs it beside its other skips.
 *
 * Safe to call every minute forever: each crossing's key is the leg, the scenario date and the
 * window it published, so the second and every later sweep writes nothing (`duplicates`).
 */
export async function sweepEtaNotices(
  db: Db,
  transport: OutboxTransport,
  a: {
    readonly due: readonly DueEtaNotice[];
    /** Wall time: what stamps the row. Never accelerated (§8). */
    readonly now: Date;
    /**
     * The scenario clock's now. Required, and deliberately without a default: a default would be
     * this module deciding how far into the demo day it is, which is exactly the guess that
     * queued the whole afternoon at once.
     */
    readonly scenarioNow: Date;
    readonly env?: Record<string, string | undefined>;
    readonly by?: string;
  },
): Promise<EtaNoticeSweepReport | SweepRefusal> {
  const env = a.env ?? process.env;
  if (!isSyntheticDemo(env) || !isDemoMode(env)) return { skipped: "not a demo deployment" };

  const report = { queued: 0, duplicates: 0, skipped: {} as Partial<Record<SweepSkip, number>> };
  const skip = (reason: SweepSkip) => {
    report.skipped[reason] = (report.skipped[reason] ?? 0) + 1;
  };

  const scenarioNowMs = a.scenarioNow.getTime();
  for (const notice of a.due) {
    // Has this crossing happened yet, on the clock it happened on? Checked before the leg is even
    // read: a text about a van that has not left is not a cheaper mistake for having been looked up.
    if (notice.decision.atMs > scenarioNowMs) {
      skip("not-yet");
      continue;
    }
    const legId = demoLegId(notice.childKey, notice.direction);
    const leg = await db.query<{
      id: string; site_id: string; child_token: string; plan_version: number; state: string;
    }>(
      "SELECT id, site_id, child_token, plan_version, state FROM ops.trip_leg WHERE id = $1",
      [legId],
    );
    const row = leg.rows[0];
    if (!row) {
      skip("no-leg");
      continue;
    }
    if (NOT_RIDABLE.has(row.state)) {
      skip("leg-not-ridable");
      continue;
    }
    const result = await enqueueEtaNotice(db, transport, {
      decision: notice.decision,
      ride: {
        // The site comes from the row, never from a caller (DATA-MODEL §5).
        siteId: row.site_id,
        legId: row.id,
        childToken: row.child_token,
        direction: notice.direction,
        planVersion: row.plan_version,
        stopToken: notice.stopToken,
      },
      now: a.now,
      by: a.by ?? "system:eta-notice",
    });
    if ("skipped" in result) skip(result.skipped);
    else if (result.duplicate) report.duplicates += 1;
    else report.queued += result.messageIds.length;
  }
  return report;
}
