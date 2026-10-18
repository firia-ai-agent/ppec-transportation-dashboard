/**
 * The van arrival, as the screen needs it: which vans are at the centre this afternoon, what the
 * plan has on each of them, and who is riding.
 *
 * Server-side composition only — the board's own day (src/modules/plan/store.ts) plus the one
 * thing it does not carry, when each van leaves the centre, which comes through the same day
 * port everything else does (Firia's rule 5: no screen reads a fixture).
 *
 * The riders beside the steppers are **the saved plan when there is one, and the placement
 * function's own answer when there is not** (Vera's differences list, item 3). A ramp screen
 * with an empty Riders card cannot be checked at all, and "no plan yet" is the state a fresh
 * demo day starts in — so the front desk sees who the day would put on this van, and the
 * won't-fit line and Re-plan are reachable.
 *
 * Pure apart from reading the day: no database of its own, no network, no React.
 */
import type { DayDataSource } from "@/domain/day/source";
import type { BoardDay, BoardPlan, BoardRider, BoardVan } from "@/domain/plan/board";
import { autoPlan, ridersInVan } from "@/domain/plan/board";

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
export function arrivalVans(
  day: BoardDay,
  plan: BoardPlan,
  source: DayDataSource,
  planSaved: boolean,
): ArrivalVan[] {
  // No plan saved yet: show the day as the one placement function would place it, so the card is
  // populated and the "won't fit" line is reachable. Nothing is written by looking.
  const shown = planSaved ? plan : autoPlan(day, plan);
  return day.vans
    .map((van) => ({
      van,
      riders: ridersInVan(day, shown, van.id),
      leavesMs: source.leavesAtMs(day.date, day.direction, van.id),
    }))
    .sort((a, b) => a.leavesMs - b.leavesMs);
}

/** The van the address names, or the first one to leave. */
export function selectedVan(vans: readonly ArrivalVan[], asked: string | undefined): ArrivalVan | null {
  return vans.find((arrival) => arrival.van.id === asked) ?? vans[0] ?? null;
}
