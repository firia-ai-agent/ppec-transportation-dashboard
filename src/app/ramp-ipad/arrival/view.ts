/**
 * The van arrival, as the screen needs it: which vans are at the centre this afternoon, what the
 * plan has on each of them, and who is riding.
 *
 * Server-side composition only — the board's own day (src/modules/plan/store.ts) plus the one
 * thing it does not carry, when each van leaves the centre. That comes from the committed survey
 * through `plannedStops` (src/domain/board/scenario.ts), which is where every other screen reads
 * a planned time from, so the ramp's clock and the board's cannot disagree.
 *
 * Pure apart from reading the day: no database of its own, no network, no React.
 */
import { demoDay } from "@/domain/board/day";
import { plannedStops } from "@/domain/board/scenario";
import type { BoardDay, BoardPlan, BoardRider, BoardVan } from "@/domain/plan/board";
import { ridersInVan } from "@/domain/plan/board";
import { RUNS, vehicleIdOf } from "@/modules/demo/fixtures/standard";
import { RAMP_DIRECTION } from "./when";

/** One van at the ramp: everything the card above its steppers shows. */
export type ArrivalVan = {
  van: BoardVan;
  /** The riders the saved plan puts on it, in the order it drives them. */
  riders: readonly BoardRider[];
  /** When it pulls away from the centre, epoch ms, from the run's committed geometry. */
  leavesMs: number;
};

/**
 * The vans at the ramp, in the order they leave.
 *
 * §2 puts them in arrival order and switches tabs when a van crosses the centre geofence; there
 * is no live position on this screen (that is the live map's, #53), so they are ordered by when
 * the plan says each one leaves, and none of them claims to be "here" when nothing knows that.
 */
export function arrivalVans(day: BoardDay, plan: BoardPlan): ArrivalVan[] {
  const serviceDay = demoDay();
  return day.vans
    .map((van) => ({
      van,
      riders: ridersInVan(day, plan, van.id),
      leavesMs: leavesAt(van.id, serviceDay),
    }))
    .sort((a, b) => a.leavesMs - b.leavesMs);
}

/** The instant this van's afternoon run leaves the centre. */
function leavesAt(vanId: string, serviceDay: ReturnType<typeof demoDay>): number {
  const run = RUNS.find((candidate) => vehicleIdOf(candidate.vehicleKey) === vanId);
  if (!run) return serviceDay.instantMs;
  const stops = plannedStops(run, RAMP_DIRECTION, serviceDay);
  // The afternoon run starts at the centre, so its first stop *is* the departure (PRD §8).
  return stops[0]?.etaMs ?? serviceDay.instantMs;
}

/** The van the address names, or the first one to leave. */
export function selectedVan(vans: readonly ArrivalVan[], asked: string | undefined): ArrivalVan | null {
  return vans.find((arrival) => arrival.van.id === asked) ?? vans[0] ?? null;
}
