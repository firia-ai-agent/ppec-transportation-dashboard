/**
 * A SAVED RE-PLAN TELLS THE FAMILIES IT MADE LATE (user ruling 2026-10-18, ledger #73).
 *
 * The board's Save can move a child to another van or further down a van's stops — which is what a
 * re-plan around a van that arrived short does. The family was given a drop-off window
 * (`trip_leg.window_start`, a rider's `window`), and if the plan that was just saved gets their
 * child home materially later than that, they are told: how late, and the new time.
 *
 * ## Who is told
 *
 * One rule, for every child, from the two plans the save had in hand (`place.writePlan`'s before
 * and after) and the one estimate of a planned drop-off (`domain/plan/arrivals.ts`):
 *
 *  - **late**: the new plan gets them home at least the §8 shift threshold after their window
 *    (`notifyGateConfig.shiftSeconds`, the same number that gates every ETA text), and
 *  - **made late by this save**: it is also at least that much later than the plan before it, so
 *    a Save that does not move a child's drop-off — a re-save, a change to somebody else's van —
 *    tells their family nothing.
 *
 * Nothing names a child, a van or a minute. The text says what the saved plan implies.
 *
 * ## When it does nothing
 *
 * A morning (the run ends at the centre, where nobody waits), a plan for a day that is not today
 * (a family is told about the ride they are waiting for, not next week's), the first save of a
 * leg (there was no plan to be later than), a leg whose ride is over or not happening (the sweep's
 * own `NOT_RIDABLE`), a stop with no token, and a child nobody on file may be texted about.
 *
 * ## How it is sent
 *
 * Through the outbox and nothing else (`enqueue`), so every §11.2 re-check still runs at send time,
 * one row per authorized contact in one transaction. The idempotency key is the leg, the date and
 * the new minute, so a retried save queues nothing twice and a later re-plan that moves the minute
 * again is a new text.
 */
import type { Db, Exec } from "@/db/exec";
import { notifyGateConfig } from "@/config/live";
import { hhmmOf, madeLate } from "@/domain/plan/arrivals";
import { stopTokenOf } from "@/domain/plan/map";
import { ETA_NOTICE_NOT_AFTER_MS, LATE_MINUTES_STEP, NOT_RIDABLE, lateMinutesFor } from "@/modules/messaging/eta-notice";
import { REPLAN_LATE_TEMPLATE } from "@/modules/messaging/replan-late-template";
import { enqueue, type OutboxTransport } from "@/modules/outbox/outbox";
import { FAMILY_SMS, authorizedContactsForChild } from "@/modules/outbox/policy";
import { serviceDateIso } from "@/ui/service-date";
import type { BoardView } from "./store";

export type ReplanSkip =
  | "not-afternoon"
  | "not-today"
  | "first-save"
  | "no-leg"
  | "leg-not-ridable"
  | "no-stop-token"
  | "no-authorized-contact";

export type ReplanNoticeReport = {
  /** Rows written: one per authorized contact of each family told. */
  readonly queued: number;
  readonly skipped: Readonly<Partial<Record<ReplanSkip, number>>>;
};

/** What a save hands over: the plan the families were planned against, and the one just saved. */
export type ReplanNoticeInput = {
  readonly siteId: string;
  readonly before: BoardView;
  readonly after: BoardView;
  /** Wall time: stamps the rows and decides which service day is "today". */
  readonly now: Date;
  readonly by: string;
};

/** The minutes a drop-off has to move by to be worth a text: the §8 shift threshold. */
const THRESHOLD_MINUTES = notifyGateConfig.shiftSeconds / 60;

export async function sendReplanLateNotices(
  db: Db,
  transport: OutboxTransport,
  a: ReplanNoticeInput,
): Promise<ReplanNoticeReport> {
  const skipped: Partial<Record<ReplanSkip, number>> = {};
  const skip = (reason: ReplanSkip) => {
    skipped[reason] = (skipped[reason] ?? 0) + 1;
  };
  const { before, after } = a;
  if (after.day.direction !== "PM") return { queued: 0, skipped: { "not-afternoon": 1 } };
  if (after.day.date !== serviceDateIso(a.now)) return { queued: 0, skipped: { "not-today": 1 } };
  if (before.version === 0) return { queued: 0, skipped: { "first-save": 1 } };

  let queued = 0;

  // The two plans share the day's riders and vans; only the placements differ.
  for (const { token, arrival, late } of madeLate(after.day, before.plan, after.plan, THRESHOLD_MINUTES, { before: before.departs, after: after.departs })) {
    const rider = { token };

    const leg = (
      await db.query<{ id: string; plan_version: number; state: string }>(
        `SELECT id, plan_version, state FROM ops.trip_leg
          WHERE site_id = $1 AND child_token = $2 AND service_date = $3 AND direction = 'PM'`,
        [a.siteId, rider.token, after.day.date],
      )
    ).rows[0];
    if (!leg) {
      skip("no-leg");
      continue;
    }
    if (NOT_RIDABLE.has(leg.state)) {
      skip("leg-not-ridable");
      continue;
    }
    const stopToken = stopTokenOf(arrival.stopLabel);
    if (stopToken === null) {
      skip("no-stop-token");
      continue;
    }
    const contacts = await authorizedContactsForChild(db, { siteId: a.siteId, childToken: rider.token, at: a.now });
    if (contacts.length === 0) {
      skip("no-authorized-contact");
      continue;
    }

    // "about 4:45 PM": the minute, in the same 5-minute steps the lateness is said in.
    const eta = hhmmOf(Math.round(arrival.arrivesAtMinute / LATE_MINUTES_STEP) * LATE_MINUTES_STEP);
    const vars = { delayMinutes: lateMinutesFor(late * 60), eta, stopLabel: stopToken };
    queued += await db.tx(async (tx: Exec, afterCommit) => {
      let rows = 0;
      for (const recipientToken of contacts) {
        const sent = await enqueue(tx, afterCommit, transport, {
          siteId: a.siteId,
          purpose: FAMILY_SMS.purpose,
          recipientRule: FAMILY_SMS.recipientRule,
          recipientToken,
          channel: FAMILY_SMS.channel,
          templateId: REPLAN_LATE_TEMPLATE,
          vars,
          childToken: rider.token,
          tripLegId: leg.id,
          planVersionBasis: leg.plan_version,
          notAfter: new Date(a.now.getTime() + ETA_NOTICE_NOT_AFTER_MS),
          idempotencyKey: `replan-late:${leg.id}:${after.day.date}:${eta}:${recipientToken}`,
          by: a.by,
        });
        if (!sent.duplicate) rows += 1;
      }
      return rows;
    });
  }
  return { queued, skipped };
}
