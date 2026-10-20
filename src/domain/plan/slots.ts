/**
 * TIMES A FAMILY AGREED, READ AGAINST A ROUTE (ledger #84; PRD TRP-02).
 *
 * A child with approved slots (`DayRider.slots`, ledger #83) has a range their family can receive
 * them in. These functions say how far a planned stop time falls outside it — 0 inside — and which
 * child a change would put further outside than they already were. They know nothing of vans,
 * seats or saves: the writer asks them (`modules/plan/place.ts`), and so do the preview and the
 * route ranking, so the rule is written once.
 */
import type { TimeSlot } from "@/domain/day/source";
import { minuteOfDay, plannedStopTimes, type Departures } from "./arrivals";
import type { BoardDay, BoardPlan } from "./board";

/** Minutes a time falls outside the nearest slot: 0 inside any of them, null with no slot at all. */
export function minutesOutside(minute: number, slots: readonly TimeSlot[] | undefined): number | null {
  if (!slots || slots.length === 0) return null;
  let best = Number.POSITIVE_INFINITY;
  for (const slot of slots) {
    const start = minuteOfDay(slot.start);
    const end = minuteOfDay(slot.end);
    if (start === null || end === null) continue;
    const off = minute < start ? start - minute : minute > end ? minute - end : 0;
    best = Math.min(best, off);
  }
  return Number.isFinite(best) ? Math.round(best) : null;
}

/** Every child with a slot and a planned time on this plan: how far outside it they are. */
export function outsideSlots(day: BoardDay, plan: BoardPlan, departs: Departures): ReadonlyMap<string, number> {
  const times = plannedStopTimes(day, plan, departs);
  const out = new Map<string, number>();
  for (const rider of day.riders) {
    const at = times.get(rider.token)?.arrivesAtMinute;
    if (at === undefined) continue;
    const off = minutesOutside(at, rider.slots);
    if (off !== null) out.set(rider.token, off);
  }
  return out;
}

/** The sum of every child's minutes outside their slot: what the route ranking keeps smallest. */
export function totalOutside(outside: ReadonlyMap<string, number>): number {
  let sum = 0;
  for (const off of outside.values()) sum += off;
  return sum;
}

/**
 * THE CHILD A CHANGE BREAKS AN AGREED TIME FOR, if any: someone with a slot whose planned time the
 * change puts further outside it than it was. A child already outside before the change and no
 * worse after does not stop it — the save that fixes something else must not be held hostage.
 */
export function brokenSlot(
  day: BoardDay,
  before: { readonly plan: BoardPlan; readonly departs: Departures },
  after: { readonly plan: BoardPlan; readonly departs: Departures },
): { readonly childToken: string; readonly vanId: string; readonly minutes: number } | null {
  const was = outsideSlots(day, before.plan, before.departs);
  const now = outsideSlots(day, after.plan, after.departs);
  for (const [token, off] of now) {
    if (off > (was.get(token) ?? 0)) {
      const vanId = after.plan[token]?.vanId;
      if (vanId) return { childToken: token, vanId, minutes: off };
    }
  }
  return null;
}
