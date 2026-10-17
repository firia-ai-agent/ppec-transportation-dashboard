/**
 * The board, with the live snapshot folded into it (B-12 slice 3).
 *
 * The merge rule, out of the component so it can be tested: a tick replaces the parts of a row
 * that telemetry and the ETA engine own, leaves everything else exactly as the server computed
 * it, and then the rows are grouped again — because a van going quiet moves its rides into
 * "Needs action", and a board that kept them under "On the way" while the row itself said
 * "Nothing has been heard from V2 for ten minutes" would be contradicting itself.
 *
 * Nothing here decides anything about a ride. Every field it copies was decided by
 * src/domain/board (the leg machine, the solver, the ETA engine) at the instant the tick names.
 */

import {
  BOARD_GROUPS,
  type BoardGroupView,
  type DayPhase,
  type LegRow,
  type ServiceDay,
} from "@/domain/board/board";
import type { LiveRide, LiveSnapshot } from "@/domain/board/live";

/**
 * The van a row belongs to, as the map names it.
 *
 * The board shows "V1" and the snapshot keys its vans by "V1" — the same fixture key — which is
 * what lets a row and a marker find each other without a lookup table. live-view.test.ts holds
 * the two together, so a fixture that renamed one and not the other fails there rather than
 * silently breaking the hover.
 */
export function vanIdOf(leg: LegRow): string | null {
  return leg.ride.vehicleLabel;
}

/** One row with a tick's values in it. Returns the row unchanged when the tick has none. */
export function mergeLiveRide(leg: LegRow, live: LiveRide | undefined): LegRow {
  if (!live) return leg;
  return {
    ...leg,
    group: live.group,
    needsActionReasons: live.needsActionReasons,
    nextStep: live.nextStep,
    ride: {
      ...leg.ride,
      state: live.state,
      windowText: live.windowText,
      deltaSeconds: live.deltaSeconds,
      etaPaused: live.etaPaused,
      gpsAgeSeconds: live.gpsAgeSeconds,
      gpsFreshness: live.gpsFreshness,
      stoppedSeconds: live.stoppedSeconds,
    },
  };
}

/** Every row, in the board's own order, with the snapshot applied where it has something. */
export function liveLegs(
  legs: readonly LegRow[],
  snapshot: LiveSnapshot | null,
): readonly LegRow[] {
  if (!snapshot) return legs;
  const live = new Map(snapshot.rides.map((ride) => [ride.key, ride]));
  return legs.map((leg) => mergeLiveRide(leg, live.get(leg.key)));
}

/**
 * The rows grouped the way the board stacks them (DESIGN-DIRECTION §4.1: needs action first).
 * The same order `buildBoard` uses, from the same list, so the client's grouping of an
 * un-merged board is identical to the server's (live-view.test.ts asserts exactly that).
 */
export function groupsOf(legs: readonly LegRow[]): BoardGroupView[] {
  return BOARD_GROUPS.map((group) => ({
    group,
    legs: legs.filter((leg) => leg.group === group),
  })).filter((view) => view.legs.length > 0);
}

export function needsActionCountOf(legs: readonly LegRow[]): number {
  return legs.filter((leg) => leg.group === "NEEDS_ACTION").length;
}

/**
 * Which days get a live stream: the one the scenario actually replays.
 *
 * A finished day has no van on the road and a day that has not started has none yet, so a
 * stream on either would be a connection that could only ever contradict the page — and a
 * weekend has no rides at all (PRD §18.1).
 */
export function streamsLiveUpdates(day: Pick<ServiceDay, "phase" | "scheduled">): boolean {
  const phase: DayPhase = day.phase;
  return phase === "LIVE" && day.scheduled;
}
