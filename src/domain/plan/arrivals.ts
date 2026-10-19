/**
 * WHEN EACH CHILD IS PICKED UP OR GETS HOME ON A PLAN — the one estimate of a planned stop time.
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
 * **When a van leaves** is its departure for the leg (ledger #76): the schedule's default
 * (`config/schedule.ts`) or the time a planner set for today on the board. Every stop follows from
 * it and from the geometry, so a plan that puts more stops in one van, a slower kerb ahead of a
 * child's, or a later departure makes that child later — and the board shows it before anyone saves.
 *
 * Time is **minutes of the site-local day**, and so is the window a family holds, so comparing the
 * two never crosses a time zone or a fixture's own date. Both legs: a morning's time is the pickup,
 * an afternoon's the drop-off.
 *
 * Pure: no clock, no database, no network.
 */
import { trafficBandAtMinute } from "@/domain/eta/traffic";
import { DWELL_SECONDS } from "@/domain/location/route";
import { WHEELCHAIR_SERVICE_SECONDS } from "@/fixtures/survey";
import { serviceSchedule } from "@/config/schedule";
import { boardMap, ridersInVan, stopNumbers, type BoardDay, type BoardPlan } from "./board";
import { centreLeadSec } from "./map";

/** One child's estimated time on one plan: picked up (morning) or dropped off (afternoon). */
export type PlannedDropoff = {
  readonly vanId: string;
  /** The landmark the van stops at for them. */
  readonly stopLabel: string;
  /** Minutes after site-local midnight, unrounded. */
  readonly arrivesAtMinute: number;
};
export type StopTime = PlannedDropoff;

/** When each van leaves the centre on this leg, as minutes of the site-local day, by van id. */
export type Departures = Readonly<Record<string, number>>;

/**
 * The departure every van has on this leg: the planner's time for today where one was saved,
 * the schedule's default otherwise (`config/schedule.ts`). One resolution, read by the board,
 * the ramp, the late texts and the agent alike.
 */
export function departuresOf(day: BoardDay, saved: Readonly<Record<string, string>> = {}): Departures {
  const fallback = minuteOfDay(serviceSchedule.departs[day.direction]) ?? 0;
  return Object.fromEntries(day.vans.map((van) => [van.id, minuteOfDay(saved[van.id] ?? "") ?? fallback]));
}

/**
 * EVERY CHILD'S ESTIMATED TIME, FORWARD FROM THEIR VAN'S DEPARTURE (ledger #76).
 *
 * The van leaves the centre at its departure. An afternoon drives the stops in order and each
 * child's time is their drop-off; a morning drives out to its first stop and each child's time is
 * their pickup, and the run ends back at the centre. Between stops: the board's own route
 * (`boardMap` — the surveyed road where there is one, the probe speed where not) under the §8
 * traffic band, plus the §8 dwell and a wheelchair's service time at every stop before.
 *
 * A time agreed with a family (`Placement.notBefore`) is PRD §8's hold: a van that would reach that
 * stop earlier waits there until then, and every stop after it is later by the wait (ledger #79).
 *
 * A child in no van, and a stop the map cannot place, get no time — never a guessed one.
 */
export function plannedStopTimes(day: BoardDay, plan: BoardPlan, departs: Departures): ReadonlyMap<string, StopTime> {
  const out = new Map<string, StopTime>();
  const routes = boardMap(day, plan).routes;

  for (const van of day.vans) {
    const route = routes.find((candidate) => candidate.laneId === van.id);
    const departure = departs[van.id];
    if (!route || route.stops.length === 0 || departure === undefined) continue;
    const riders = ridersInVan(day, plan, van.id);
    const numbers = stopNumbers(riders);
    const traffic = trafficBandAtMinute(departure).multiplier;
    // The stretch leading into stop j: an afternoon's route starts at the centre, so segment j;
    // a morning's starts at its first stop, so the centre's lead and then segment j−1.
    const leadInto = (j: number): number =>
      day.direction === "PM"
        ? (route.segments[j]?.durationSec ?? 0)
        : j === 0
          ? (centreLeadSec(route.stops[0].label) ?? 0)
          : (route.segments[j - 1]?.durationSec ?? 0);

    const reaches: number[] = [];
    let driveSeconds = 0;
    let heldSeconds = 0;
    route.stops.forEach((stop, j) => {
      driveSeconds += leadInto(j) * traffic;
      const servedHere = riders.filter((rider) => {
        const n = numbers.get(rider.token);
        return n !== undefined && n <= stop.order && n > (route.stops[j - 1]?.order ?? 0);
      });
      const arrives = departure + (driveSeconds + heldSeconds) / 60;
      const hold = Math.max(...servedHere.map((rider) => minuteOfDay(plan[rider.token]?.notBefore ?? "") ?? -Infinity));
      if (hold > arrives) heldSeconds += (hold - arrives) * 60;
      reaches.push(Math.max(arrives, hold));
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

/** The afternoon's drop-offs on this plan: `plannedStopTimes` for a PM board, nothing for a morning. */
export function plannedDropoffs(day: BoardDay, plan: BoardPlan, departs: Departures = departuresOf(day)): ReadonlyMap<string, PlannedDropoff> {
  return day.direction === "PM" ? plannedStopTimes(day, plan, departs) : new Map();
}

/** Minutes a child's estimate is past their family's window; ≤ 0 when on time. Null when unknown. */
export function minutesLate(window: string, minute: number | undefined): number | null {
  const at = minuteOfDay(window);
  return at === null || minute === undefined ? null : minute - at;
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
export function madeLate(
  day: BoardDay,
  before: BoardPlan,
  after: BoardPlan,
  thresholdMinutes: number,
  departs: { readonly before: Departures; readonly after: Departures } = { before: departuresOf(day), after: departuresOf(day) },
): MadeLate[] {
  const was = plannedDropoffs(day, before, departs.before);
  const now = plannedDropoffs(day, after, departs.after);
  return day.riders.flatMap((rider) => {
    const arrival = now.get(rider.token);
    const window = minuteOfDay(rider.window);
    if (!arrival || window === null) return [];
    const late = arrival.arrivesAtMinute - window;
    const later = arrival.arrivesAtMinute - (was.get(rider.token)?.arrivesAtMinute ?? window);
    return late < thresholdMinutes || later < thresholdMinutes ? [] : [{ token: rider.token, arrival, late }];
  });
}
