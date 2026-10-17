/**
 * The plan board's day: which vans are out, which children ride, where each of them is, and the
 * three things a person can ask of it — "plan the rest of it for me", "can this child go here"
 * and "is this plan allowed".
 *
 * SOURCE: redesign spec §1 (the board), §1.4 (the fit rule), §1.6 (what is persisted), §9.1 (the
 * order of the day), and Firia's binding rules of 2026-10-17 5:48 PM ET.
 *
 * Three properties hold everything else up:
 *
 *  - **One placement function.** Every answer about who fits where is `placeRiders` /
 *    `rejectReason` in src/domain/plan/fit.ts — Auto-plan, the pre-check while a card is held,
 *    the server's re-check at save, the ramp's live verdicts and Re-plan. The capacity solver
 *    (src/domain/solver) makes no placement decision anywhere: it is not imported here at all,
 *    and ordering a van's stops is a sort on the pickup window.
 *  - **Ids, not codes.** Every van and every child in here is the id the database holds
 *    (`ops.vehicle.id`, `ops.child_profile.child_token`), because the board puts them in its
 *    addresses and in its markup, and §9.3's rule is ids in a URL and never a code on a screen.
 *  - **No fixtures.** The day arrives through the one day-data port (src/domain/day/source.ts);
 *    which roster it came from is the adapter's business (Firia's rule 5).
 *
 * Pure: no clock, no database, no network. The store (src/modules/plan) brings the rows; the
 * words are in src/ui/copy.ts.
 */
import type { NeedFlags, RejectReason } from "@/config/equipment";
import { BUCKETS, type Bucket, type DayRider, type DayVan, type OtherChild } from "@/domain/day/source";
import type { Direction } from "@/domain/day/leg";
import { planMap, type PlanMapData, type PlanMapVan } from "@/domain/plan/map";
import {
  placeRiders,
  rejectReason,
  usedBy,
  type FitRider,
  type PlaceableVan,
  type Unplaced,
  type Used,
  type VanSetup,
} from "./fit";
import type { SetupSource, SetupState } from "./setup";

export { BUCKETS };
export type { Bucket, OtherChild };

/** Where one child is, and whether a person put them there. */
export type Placement = {
  bucket: Bucket;
  /** The van, when the bucket is `VAN`. Null otherwise, which the database also checks. */
  vanId: string | null;
  /** True when a person placed them, so planning again leaves them where they are (§1.4). */
  pinned: boolean;
};

/** The whole board: every child of the day, by child token. */
export type BoardPlan = Readonly<Record<string, Placement>>;

/** One van on the board: what the day knows about it, plus the counts it is planned on today. */
export type BoardVan = DayVan & {
  setup: VanSetup;
  /** `CHECKED` once the front desk has confirmed it today; `DEFAULT` until then. */
  setupState: SetupState;
  setupSource: SetupSource;
  /** Who confirmed it, in words, when anybody did. */
  setupBy?: string | null;
};

/** A child this leg drives (the port's own rider). */
export type BoardRider = DayRider;

export type BoardDay = {
  /** "2026-10-17", the service date in centre time. */
  date: string;
  direction: Direction;
  vans: readonly BoardVan[];
  riders: readonly BoardRider[];
  others: readonly OtherChild[];
};

/* ───────────────────────────── reading a plan ───────────────────────────── */

/** Nobody placed: every rider in Unassigned, every other child in their own group (§1.3 Empty). */
export function emptyPlan(day: BoardDay): BoardPlan {
  const plan: Record<string, Placement> = {};
  for (const rider of day.riders) {
    plan[rider.token] = { bucket: "UNASSIGNED", vanId: null, pinned: false };
  }
  for (const other of day.others) {
    plan[other.token] = { bucket: other.bucket, vanId: null, pinned: false };
  }
  return plan;
}

/**
 * The riders in one van, in the order that van drives their stops.
 *
 * The order is the pickup window and nothing else: every rider of a leg is aboard together at the
 * centre end of the run (§1.4's "peak equals total"), so there is no routing decision to make
 * here, only a sort — which is all the ordering this app's planner does now.
 */
export function ridersInVan(day: BoardDay, plan: BoardPlan, vanId: string): BoardRider[] {
  return day.riders
    .filter((rider) => plan[rider.token]?.vanId === vanId)
    .sort((a, b) => a.window.localeCompare(b.window) || a.token.localeCompare(b.token));
}

/** Everybody waiting to be placed (§1.3's Unassigned count). */
export function unassignedRiders(day: BoardDay, plan: BoardPlan): BoardRider[] {
  return day.riders.filter((rider) => plan[rider.token]?.bucket === "UNASSIGNED");
}

/** How many of the leg's riders are in a van. */
export function placedCount(day: BoardDay, plan: BoardPlan): number {
  return day.riders.filter((rider) => plan[rider.token]?.bucket === "VAN").length;
}

/**
 * The stop number each rider in a van carries, 1-based in drive order, with two children at one
 * kerb sharing a number — they are one stop, and the map draws one disc for it (map.ts).
 */
export function stopNumbers(ridersInDriveOrder: readonly BoardRider[]): Map<string, number> {
  const numbers = new Map<string, number>();
  let n = 0;
  let previous: string | null = null;
  for (const rider of ridersInDriveOrder) {
    if (rider.stopLabel !== previous) {
      n += 1;
      previous = rider.stopLabel;
    }
    numbers.set(rider.token, n);
  }
  return numbers;
}

/** How many kerbs a van stops at: its stop numbers, not its riders. */
export function stopCount(ridersInDriveOrder: readonly BoardRider[]): number {
  return new Set(stopNumbers(ridersInDriveOrder).values()).size;
}

/** How much of each counter a van's riders take, for its meters. */
export function usedInVan(day: BoardDay, plan: BoardPlan, vanId: string): Used {
  return usedBy(ridersInVan(day, plan, vanId));
}

/** The needs of one rider by token, for the screen's chips. */
export function needsByToken(day: BoardDay, token: string): NeedFlags | null {
  return day.riders.find((rider) => rider.token === token)?.needs ?? null;
}

/* ───────────────────────────── the map ───────────────────────────── */

/** Each van's distinct kerbs, in drive order, numbered the way its column numbers them. */
function mapVansOf(day: BoardDay, plan: BoardPlan): PlanMapVan[] {
  return day.vans.map((van) => {
    const riders = ridersInVan(day, plan, van.id);
    const numbers = stopNumbers(riders);
    const stops: { order: number; label: string }[] = [];
    for (const rider of riders) {
      const order = numbers.get(rider.token) ?? 0;
      if (stops[stops.length - 1]?.order === order) continue;
      stops.push({ order, label: rider.stopLabel });
    }
    return { laneId: van.id, vanName: van.name, stops };
  });
}

/** The plan as the map draws it: the same columns, read a second way. */
export function boardMap(day: BoardDay, plan: BoardPlan): PlanMapData {
  return planMap(day.direction, mapVansOf(day, plan));
}

/* ───────────────────────────── changing a plan ───────────────────────────── */

/**
 * The plan with one child moved into one van, or out of every van when `vanId` is null.
 *
 * It asks nothing: this is the edit, not the decision. The board asks `rejectReason` before
 * calling it, and `checkPlan` asks again on the server — the same split #58 settled on for
 * `withMove` and `tryMove`.
 *
 * A move is **pinned**, because a person made it: Auto-plan afterwards plans round them rather
 * than undoing what they decided.
 */
export function moveTo(plan: BoardPlan, childToken: string, vanId: string | null): BoardPlan {
  const current = plan[childToken];
  if (!current) return plan;
  return {
    ...plan,
    [childToken]: vanId === null
      ? { bucket: "UNASSIGNED", vanId: null, pinned: true }
      : { bucket: "VAN", vanId, pinned: true },
  };
}

/* ───────────────────────────── Auto-plan ───────────────────────────── */

/** The vans as the placement function reads them: an id, a slot and the counts. */
export function placeableVans(day: BoardDay): PlaceableVan[] {
  return day.vans.map((van) => ({ id: van.id, slot: van.slot, setup: van.setup }));
}

/** Who a person has already placed, which Auto-plan keeps where they are (§1.4). */
function pinsOf(day: BoardDay, plan: BoardPlan): Record<string, string | null> {
  const pins: Record<string, string | null> = {};
  for (const rider of day.riders) {
    const placement = plan[rider.token];
    if (!placement?.pinned) continue;
    pins[rider.token] = placement.bucket === "VAN" ? placement.vanId : null;
  }
  return pins;
}

/**
 * The rest of the day, planned — the one placement function over the vans' counts, keeping every
 * child a person has already placed where they put them.
 *
 * It replaces #66's three-step Auto-plan (the seat solver through `setupToLayout`, then a
 * separate oxygen pass, and children left unplaced with no reason). One function now answers the
 * whole question and says what each child it could not place is short of, which is what the
 * board's Unassigned column and the ramp's banner both read.
 */
export function autoPlan(day: BoardDay, plan: BoardPlan): BoardPlan {
  const result = placeRiders(placeableVans(day), day.riders, pinsOf(day, plan));
  const next: Record<string, Placement> = { ...plan };
  for (const rider of day.riders) {
    const vanId = result.vanOf[rider.token] ?? null;
    next[rider.token] = vanId
      ? { bucket: "VAN", vanId, pinned: plan[rider.token]?.pinned === true }
      : { bucket: "UNASSIGNED", vanId: null, pinned: plan[rider.token]?.pinned === true };
  }
  return next;
}

/** Everybody this day cannot seat as it stands, each with the exact thing it is short of. */
export function shortfallsOfDay(day: BoardDay, plan: BoardPlan): readonly Unplaced[] {
  return placeRiders(placeableVans(day), day.riders, pinsOf(day, plan)).unplaced;
}

/* ───────────────────────────── saving a plan ───────────────────────────── */

/** Why a save was refused: the child, the van, and the one thing that is missing. */
export type PlanRefusal = { childToken: string; vanId: string; reason: RejectReason };

export type PlanCheck = { ok: true } | ({ ok: false } & PlanRefusal);

/**
 * The plan, re-asked of the fit rule van by van — the check a save runs before anything is kept.
 *
 * A request did not come from the screen, so what the screen checked is not evidence: the vans
 * are refilled from the plan as posted and the first van that does not fit refuses the whole
 * save, naming the child the arithmetic ran out on. Replayed in the van's own drive order, so
 * the child named is the one a coordinator would have been refused on while dragging.
 *
 * Over-capacity is not the same refusal (§1.3): a van whose *setup was lowered* under the riders
 * already in it still saves, with a confirm — so the board's own `isOver` is what the screen
 * reads for that, and this function is only asked about a plan the screen is sending.
 */
export function checkPlan(day: BoardDay, plan: BoardPlan): PlanCheck {
  for (const van of day.vans) {
    const riders = ridersInVan(day, plan, van.id);
    let aboard: FitRider[] = [];
    for (const rider of riders) {
      const reason = rejectReason(van.setup, aboard, rider);
      if (reason) return { ok: false, childToken: rider.token, vanId: van.id, reason };
      aboard = [...aboard, rider];
    }
  }
  return { ok: true };
}

/** Does the posted plan name only this day's children and vans? */
export function namesOnlyThisDay(day: BoardDay, plan: BoardPlan): boolean {
  const vans = new Set(day.vans.map((van) => van.id));
  const tokens = new Set([...day.riders.map((r) => r.token), ...day.others.map((o) => o.token)]);
  for (const [token, placement] of Object.entries(plan)) {
    if (!tokens.has(token)) return false;
    if (placement.bucket === "VAN" && (!placement.vanId || !vans.has(placement.vanId))) return false;
    if (placement.bucket !== "VAN" && placement.vanId !== null) return false;
  }
  return true;
}
