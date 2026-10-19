/**
 * WHEN EACH CHILD GETS HOME ON A SAVED PLAN — the one estimate of a planned drop-off.
 *
 * SOURCE: PRD §8's planned-ETA formula, the same one `domain/eta/eta.ts plannedEta` applies to a
 * committed fixture run:
 *
 *   arrival(s_k) = departure + Σ_{i≤k} route_time(s_{i−1}→s_i) × traffic + Σ_{i<k} (dwell + service_i)
 *
 * `plannedEta` needs a measured route of a run somebody committed; a van a coordinator has just
 * re-planned has none. This is that formula over the **board's own plan** instead: the van's stops
 * in the order the board drives them (`ridersInVan`, a sort on the agreed window), the drive
 * minutes the board's map already computes for each stretch (`boardMap` — the surveyed road where
 * there is one, the probe speed where there is not), the §8 dwell (`DWELL_SECONDS`, ASM-12) and a
 * wheelchair's service time at every stop before the child's, and the §8 traffic band. Nothing is a
 * literal of this module, and nothing is tuned to a scenario: the numbers a family is told are what
 * the plan on screen implies.
 *
 * **When a van leaves** is the fixture runs' own rule (`board/scenario.ts plannedDeparture`): the
 * van's first family stop is served at the window that family holds, so it leaves the centre early
 * enough to make that drop on time, and every later stop follows from the geometry. A plan that
 * puts more stops in one van, or a slower kerb ahead of a child's, makes that child later — which
 * is the whole of what a re-plan can do to a family's afternoon.
 *
 * Time is **minutes of the site-local day**. A departure is a time of day on whatever date the
 * plan is for, and so is the window a family holds (`trip_leg.window_start`, which is what a
 * rider's `window` is), so comparing the two never crosses a time zone or a fixture's own date.
 *
 * Afternoon only: a drop-off is the stop a family waits at. A morning run ends at the centre,
 * where nobody is told anything, so this answers nothing for `AM`.
 *
 * Pure: no clock, no database, no network.
 */
import { trafficBandAtMinute } from "@/domain/eta/traffic";
import { DWELL_SECONDS } from "@/domain/location/route";
import { WHEELCHAIR_SERVICE_SECONDS } from "@/fixtures/survey";
import { boardMap, ridersInVan, stopNumbers, type BoardDay, type BoardPlan } from "./board";

/** One child's planned drop-off on one plan. */
export type PlannedDropoff = {
  readonly vanId: string;
  /** The landmark the van stops at for them. */
  readonly stopLabel: string;
  /** Minutes after site-local midnight, unrounded. */
  readonly arrivesAtMinute: number;
};

/**
 * Every afternoon rider in a van on this plan, by child token, with the minute they get home.
 *
 * A child in no van, a child with no kerb of ours, and a stop the map cannot place have no
 * drop-off to estimate and are absent — never given a guessed time.
 */
export function plannedDropoffs(day: BoardDay, plan: BoardPlan): ReadonlyMap<string, PlannedDropoff> {
  const out = new Map<string, PlannedDropoff>();
  if (day.direction !== "PM") return out;
  const routes = boardMap(day, plan).routes;

  for (const van of day.vans) {
    const route = routes.find((candidate) => candidate.laneId === van.id);
    if (!route || route.stops.length === 0) continue;
    const riders = ridersInVan(day, plan, van.id);
    const numbers = stopNumbers(riders);
    // The first family stop is served at its window; the van leaves early enough to make it.
    const first = riders.find((rider) => numbers.get(rider.token) === route.stops[0].order);
    const anchor = first ? minuteOfDay(first.window) : null;
    if (anchor === null) continue;
    const traffic = trafficBandAtMinute(anchor).multiplier;
    const departs = anchor - ((route.segments[0]?.durationSec ?? 0) * traffic) / 60;

    // The minute the van reaches each of its stops, in drive order. Segment j leads into stop j:
    // the afternoon's route starts at the centre (map.ts `placesOf`).
    const reaches: number[] = [];
    let driveSeconds = 0;
    let heldSeconds = 0;
    route.stops.forEach((stop, j) => {
      driveSeconds += (route.segments[j]?.durationSec ?? 0) * traffic;
      reaches.push(departs + (driveSeconds + heldSeconds) / 60);
      const servedHere = riders.filter((rider) => {
        const n = numbers.get(rider.token);
        return n !== undefined && n <= stop.order && n > (route.stops[j - 1]?.order ?? 0);
      });
      heldSeconds += DWELL_SECONDS + (servedHere.some((rider) => rider.needs.wheelchair) ? WHEELCHAIR_SERVICE_SECONDS : 0);
    });

    for (const rider of riders) {
      const n = numbers.get(rider.token);
      if (n === undefined) continue;
      // Two labels at one kerb are one stop on the map, numbered by the later of the two.
      const j = route.stops.findIndex((stop) => stop.order >= n);
      if (j < 0) continue;
      out.set(rider.token, { vanId: van.id, stopLabel: rider.stopLabel, arrivesAtMinute: reaches[j] });
    }
  }
  return out;
}

/** "16:20" → 980. Null for anything that is not a wall-clock time. */
export function minuteOfDay(hhmm: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!match) return null;
  const minutes = Number(match[1]) * 60 + Number(match[2]);
  return Number(match[1]) < 24 && Number(match[2]) < 60 ? minutes : null;
}

/** 1007.4 → "16:47"; the 24-hour wall clock the outbox's time vars take. */
export function hhmmOf(minute: number): string {
  const whole = ((Math.round(minute) % 1440) + 1440) % 1440;
  return `${String(Math.floor(whole / 60)).padStart(2, "0")}:${String(whole % 60).padStart(2, "0")}`;
}

/** One child a change of plan makes late: by how much past their window, and when they now get home. */
export type MadeLate = {
  readonly token: string;
  readonly arrival: PlannedDropoff;
  /** Minutes past the family's window on the new plan. */
  readonly late: number;
};

/**
 * WHO A CHANGE OF PLAN MAKES LATE (ledger #73, #75). On the new plan the child gets home at least
 * `thresholdMinutes` after their window, and at least that much later than on the plan before it —
 * so a child who was already late is not "made" late again. The one rule the late texts are sent
 * by (`plan/replan-notices.ts`) and the agent previews a change with (`get_plan`), so what the
 * agent says a move will do is what the families are then told.
 */
export function madeLate(day: BoardDay, before: BoardPlan, after: BoardPlan, thresholdMinutes: number): MadeLate[] {
  const was = plannedDropoffs(day, before);
  const now = plannedDropoffs(day, after);
  return day.riders.flatMap((rider) => {
    const arrival = now.get(rider.token);
    const window = minuteOfDay(rider.window);
    if (!arrival || window === null) return [];
    const late = arrival.arrivesAtMinute - window;
    const later = arrival.arrivesAtMinute - (was.get(rider.token)?.arrivesAtMinute ?? window);
    return late < thresholdMinutes || later < thresholdMinutes ? [] : [{ token: rider.token, arrival, late }];
  });
}
