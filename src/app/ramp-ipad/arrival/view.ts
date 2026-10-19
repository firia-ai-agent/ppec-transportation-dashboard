/**
 * The van arrival, as the screen needs it: which vans are out on the leg being looked at, what
 * the SAVED plan has on each of them, and who is riding.
 *
 * Server-side composition only — the board's own day (src/modules/plan/store.ts) plus the one
 * thing it does not carry, when each van leaves the centre, which comes through the same day
 * port everything else does (Firia's rule 5: no screen reads a fixture).
 *
 * The riders beside the steppers are **the saved plan, and nothing else**. There is no Auto-plan
 * fallback any more (Firia's S1 ruling): a ramp that invented a plan by looking showed the front
 * desk a van-load no coordinator had agreed to, and the one honest screen for a leg nobody has
 * planned is {@link noPlanView} — one line and the way to the board.
 *
 * Pure apart from reading the day: no database of its own, no network, no React.
 */
import type { CounterKey } from "@/config/equipment";
import type { DayDataSource } from "@/domain/day/source";
import type { Direction } from "@/domain/day/leg";
import type { BoardDay, BoardPlan, BoardRider, BoardVan } from "@/domain/plan/board";
import { ridersInVan } from "@/domain/plan/board";
import { usedBy, type Used, type VanSetup } from "@/domain/plan/fit";
import { boardHref, PLAN_ROUTES_PATH } from "@/modules/plan/when";
import { flow, vanArrival } from "@/ui/copy";

/** The coordinator's board. Its address is the access table's, not invented here. */
export const PLAN_PATH = PLAN_ROUTES_PATH;

/** One van at the ramp: everything the card above its steppers shows. */
export type ArrivalVan = {
  van: BoardVan;
  /** The riders the saved plan puts on it, in the order it drives them. */
  riders: readonly BoardRider[];
  /** When it pulls away from the centre, epoch ms, from the run's committed geometry. */
  leavesMs: number;
};

/**
 * The vans at the ramp, **in van order**: Van 1, Van 2, Van 3.
 *
 * They used to be sorted by the time each one leaves, which put them on screen as 1, 3, 2 and
 * moved a tab under the front desk's thumb whenever a run's geometry changed. The mockup draws
 * three tabs in the order the numbers are painted on the doors (png/ramp-arrival.png), so the
 * order is the van's own slot and the leave time is the small line under its name.
 */
export function arrivalVans(day: BoardDay, plan: BoardPlan, source: DayDataSource): ArrivalVan[] {
  return day.vans
    .map((van) => ({
      van,
      riders: ridersInVan(day, plan, van.id),
      leavesMs: source.leavesAtMs(day.date, day.direction, van.id),
    }))
    .sort((a, b) => a.van.slot - b.van.slot || a.van.id.localeCompare(b.van.id));
}

/** The van the address names, or the first one. */
export function selectedVan(vans: readonly ArrivalVan[], asked: string | undefined): ArrivalVan | null {
  return vans.find((arrival) => arrival.van.id === asked) ?? vans[0] ?? null;
}

/**
 * The whole screen when this leg has no saved plan: one line, and one button to the board.
 *
 * No steppers, no van tabs, no riders — there is nothing to count against, and a ramp that drew
 * a plan it had made up would be the front desk and the coordinator reading two different days.
 */
export function noPlanView(
  date: string,
  leg: Direction,
): { line: string; action: string; href: string } {
  return {
    line: vanArrival.noPlanSaved,
    action: flow.action.planRoutes,
    href: boardHref(PLAN_PATH, { date, leg }),
  };
}

/**
 * What the saved plan needs of this van, counter by counter — the "Planned 3" under a stepper.
 *
 * It is `usedBy` and nothing else (src/domain/plan/fit.ts): the hint under a counter, the amber
 * cell beside it and the won't-fit banner are three readings of one sum, so a front desk is never
 * told the van needs three car seats by one of them and two by another.
 */
export function plannedUse(riders: readonly BoardRider[]): Used {
  return usedBy(riders);
}

/**
 * Is what the front desk counted **under** what the plan needs? The amber cell (§2, Vera item 3).
 *
 * Amber and not crit: a van counted short is a fact to show, not a refusal — the refusal is the
 * banner, which names the child it costs.
 */
export function underPlanned(counted: VanSetup, planned: Used, key: CounterKey): boolean {
  return counted[key] < planned[key];
}
