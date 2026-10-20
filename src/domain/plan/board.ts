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
  /**
   * A time agreed with the family, "HH:MM": the van drops them no earlier (ledger #79). It waits
   * at their stop if it would arrive before, and their stop is driven in that order. Absent when
   * nothing was agreed — the plain family window is a lateness reference, never a wait.
   */
  notBefore?: string | null;
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

/**
 * One child as the board draws and places them (the port's own rider).
 *
 * A child the centre does not drive this leg is one of these too — `OtherChild` is a
 * `DayRider` with the bucket it starts in — so there is one card and one fit question for
 * every child on the board (`boardRiders`).
 */
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
 * **Every child of the day as a card**: the riders this leg drives, then the children it does
 * not (Firia's bug report of 2026-10-18).
 *
 * The two halves of the roster arrive separately because only one of them has a kerb of ours
 * (src/domain/day/source.ts), and the board used to treat that as "only one of them is a
 * child": `day.others` had no needs, so the Family drives lane could draw nothing but a name,
 * no card could be lifted out of it, and a drop on a van would not have been counted against
 * that van's seats. Every question the board asks about a child — may this one go here, who is
 * in this van, how many are placed — is asked of this list, so there is one roster on the
 * board and not two.
 *
 * Where they differ is the kerb, and that is `hasStop`: a family-drives child a coordinator has
 * put in a van is in the van and is not a stop.
 */
export function boardRiders(day: BoardDay): readonly BoardRider[] {
  return [...day.riders, ...day.others];
}

/** Does the centre pick this child up at a kerb of its own on this leg? */
export function hasStop(rider: BoardRider): boolean {
  return rider.stopLabel !== "";
}

/**
 * The riders in one van, in the order that van drives their stops.
 *
 * The order is the pickup window and nothing else: every rider of a leg is aboard together at the
 * centre end of the run (§1.4's "peak equals total"), so there is no routing decision to make
 * here, only a sort — which is all the ordering this app's planner does now.
 */
export function ridersInVan(day: BoardDay, plan: BoardPlan, vanId: string): BoardRider[] {
  return boardRiders(day)
    .filter((rider) => plan[rider.token]?.vanId === vanId)
    .sort((a, b) => orderKey(a, plan).localeCompare(orderKey(b, plan)) || a.token.localeCompare(b.token));
}

/** The time a rider's stop is driven by: their window, or a later time agreed with the family. */
const orderKey = (rider: BoardRider, plan: BoardPlan): string => {
  const agreed = plan[rider.token]?.notBefore;
  return agreed && agreed > rider.window ? agreed : rider.window;
};

/** Everybody waiting to be placed (§1.3's Unassigned count). */
export function unassignedRiders(day: BoardDay, plan: BoardPlan): BoardRider[] {
  return boardRiders(day).filter((rider) => plan[rider.token]?.bucket === "UNASSIGNED");
}

/**
 * Everybody in one of the two groups at the foot of the Unassigned column, whichever half of
 * the day's roster they came from.
 *
 * A child dropped on Absent is a rider of this leg with an `ABSENT` placement, and a child whose
 * family drives them every day is an "other" with no stop at all — both belong in the same group
 * on screen, both are a full card there, and both can be dragged back out of it (founder
 * 2026-10-17 7:17 PM ET; Firia 2026-10-18). So this reads the *plan*, which is the only place
 * either answer lives, and it returns the card rather than a name.
 */
export function childrenInBucket(day: BoardDay, plan: BoardPlan, bucket: Bucket): BoardRider[] {
  return boardRiders(day)
    .filter((rider) => plan[rider.token]?.bucket === bucket)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The children this leg is actually planning: not the ones a person has taken off it.
 *
 * A family-drives child sits in `FAMILY_DRIVES` and is left alone, exactly as before; one a
 * coordinator has moved into a van or out into Unassigned is a child of the plan like any other
 * and Auto-plan answers for them too.
 */
export function ridersToPlace(day: BoardDay, plan: BoardPlan): BoardRider[] {
  return boardRiders(day).filter((rider) => {
    const bucket = plan[rider.token]?.bucket;
    return bucket !== "ABSENT" && bucket !== "FAMILY_DRIVES";
  });
}

/** How many of the leg's riders are in a van. */
export function placedCount(day: BoardDay, plan: BoardPlan): number {
  return boardRiders(day).filter((rider) => plan[rider.token]?.bucket === "VAN").length;
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
    // A child in the van with no kerb of ours — a family-drives child a coordinator moved onto
    // it — is carried and is not a stop: numbering them would claim a pickup this day does not
    // have, and draw a disc for it on the map. Their card shows a grip instead of a number.
    if (!hasStop(rider)) continue;
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
  return boardRiders(day).find((rider) => rider.token === token)?.needs ?? null;
}

/* ───────────────────────────── the map ───────────────────────────── */

/** Each van's distinct kerbs, in drive order, numbered the way its column numbers them. */
function mapVansOf(day: BoardDay, plan: BoardPlan): PlanMapVan[] {
  return day.vans.map((van) => {
    const riders = ridersInVan(day, plan, van.id);
    const numbers = stopNumbers(riders);
    const stops: { order: number; label: string }[] = [];
    for (const rider of riders) {
      const order = numbers.get(rider.token);
      // No kerb of ours, so no disc: the map draws the stops a van drives, not its load.
      if (order === undefined) continue;
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
 * than undoing what they decided. A time agreed with the family travels with the child, whichever
 * van they end up in (the rule `applyPending` keeps).
 */
export function moveTo(plan: BoardPlan, childToken: string, vanId: string | null): BoardPlan {
  const current = plan[childToken];
  if (!current) return plan;
  return {
    ...plan,
    [childToken]: vanId === null
      ? { ...current, bucket: "UNASSIGNED", vanId: null, pinned: true }
      : { ...current, bucket: "VAN", vanId, pinned: true },
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
  for (const rider of ridersToPlace(day, plan)) {
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
  // A child somebody marked away, or whose family is driving them today, is not the planner's
  // to place: those are placements on this leg's plan and the search leaves them alone.
  const toPlace = ridersToPlace(day, plan);
  const result = placeRiders(placeableVans(day), toPlace, pinsOf(day, plan));
  const next: Record<string, Placement> = { ...plan };
  for (const rider of toPlace) {
    const vanId = result.vanOf[rider.token] ?? null;
    // Planning again moves a child, never what was agreed with their family (ledger #81): the
    // hold rides along, so a save after Auto-plan cannot quietly drop it.
    const kept = { ...plan[rider.token], pinned: plan[rider.token]?.pinned === true };
    next[rider.token] = vanId
      ? { ...kept, bucket: "VAN", vanId }
      : { ...kept, bucket: "UNASSIGNED", vanId: null };
  }
  return next;
}

/** Everybody this day cannot seat as it stands, each with the exact thing it is short of. */
export function shortfallsOfDay(day: BoardDay, plan: BoardPlan): readonly Unplaced[] {
  return placeRiders(placeableVans(day), ridersToPlace(day, plan), pinsOf(day, plan)).unplaced;
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
