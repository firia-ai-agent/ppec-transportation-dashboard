/**
 * The plan board's day: which vans are out, which children ride, where each of them is, and the
 * two things a person can ask of it — "plan the rest of it for me" and "is this plan allowed".
 *
 * SOURCE: redesign spec §1 (the board), §1.4 (the fit rule and the Auto-plan adapter), §1.6 (what
 * is persisted), §9.1 (the order of the day). It replaces #58's lane model on this screen: a lane
 * was a van plus one of three seating plans plus a capability report, and a van is now a van plus
 * five numbers somebody counted (conflict C1, founder direction 2026-10-17 2:38 PM ET).
 *
 * Two deliberate properties:
 *
 *  - **Ids, not codes.** Every van and every child in here is the id the database holds
 *    (`ops.vehicle.id`, `ops.child_profile.child_token`), because the board puts them in its
 *    addresses and in its markup, and §9.3's rule is ids in a URL and never a code on a screen.
 *    The fixture keys stay inside this module, where the synthetic day is read.
 *  - **One fit rule, two sides.** A drag asks `rejectReason` (src/domain/plan/fit.ts) in the
 *    browser and `checkPlan` below re-asks the same function on the server, so a plan the screen
 *    refused cannot be saved by posting round it — #58's rule for `tryMove`, kept.
 *
 * Auto-plan is the exception that proves it: it wraps the existing capacity solver rather than
 * writing a second search (§1.4, and the common rule to reuse `src/domain/solver`). The van's
 * counts become one synthetic seating plan (`setupToLayout`), the solver places the children it
 * always did, and oxygen — which a seating plan cannot express — is checked afterwards against
 * the same `fits` every other caller uses.
 *
 * Pure: no clock, no database, no network. The store (src/modules/plan) brings the rows; the
 * words are in src/ui/copy.ts.
 */
import { VANS } from "@/config/vans";
import type { NeedFlags, RejectReason } from "@/config/equipment";
import {
  planAssignment,
  ridersInOrder,
  routePlan,
  type Assignment,
  type Direction,
  type ManualPlacements,
  type PlanInput,
  type PlanLane,
  type PlanRider,
  type RoutePlan,
} from "@/domain/solver";
import { planMap, type PlanMapData } from "@/domain/plan/map";
import { plannedWindow, stopLabel } from "@/domain/board/scenario";
import {
  CHILDREN,
  childTokenOf,
  vehicleIdOf,
  type Child as DemoChild,
} from "@/modules/demo/fixtures/standard";
import { fill, places, planBoard } from "@/ui/copy";
import { fits, rejectReason, usedBy, type FitRider, type Used, type VanSetup } from "./fit";
import { needsOf } from "./needs";
import { driverFor } from "./day";
import { setupToVehicle, type SetupSource, type SetupState } from "./setup";

/* ───────────────────────────── the day ───────────────────────────── */

/** The four places a child can be on a board (§1.6's `bucket`). */
export const BUCKETS = ["VAN", "UNASSIGNED", "FAMILY_DRIVES", "ABSENT"] as const;
export type Bucket = (typeof BUCKETS)[number];

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

export type BoardVan = {
  /** `ops.vehicle.id`. */
  id: string;
  /** 1-based: the number in "Van 2" and the slot in the route palette. */
  slot: number;
  /** "Van 2" — the only name this van has on screen. */
  name: string;
  /** "Marco D." — who is driving it today. */
  driverName: string;
  setup: VanSetup;
  setupState: SetupState;
  setupSource: SetupSource;
  /** The day the setup was carried forward from, when it was not set today. */
  setupFromDate?: string;
  /** Who set it, in words, when anybody did. */
  setupBy?: string | null;
};

/** A child this leg drives: the fit rule's rider, plus where and when. */
export type BoardRider = FitRider & {
  /** "Okeeheelee Park" — a landmark, never an address. */
  stopLabel: string;
  /** "15:55", site-local, which is the order the stops are driven in. */
  window: string;
};

/** A child of the day who is not ours to place this leg. */
export type OtherChild = { token: string; name: string; bucket: Bucket };

export type BoardDay = {
  /** "2026-10-17", the service date in centre time. */
  date: string;
  direction: Direction;
  vans: readonly BoardVan[];
  riders: readonly BoardRider[];
  others: readonly OtherChild[];
};

/* ───────────────────────────── the day, from the fixtures ───────────────────────────── */

/** "Van 1" / "Van 2" / "Van 3" — the one name a van has on this screen (§1.5). */
export function vanNameOf(slot: number): string {
  return fill(planBoard.vanName, { n: slot });
}

/**
 * The children this leg drives: a stop of their own, and a ride that is not the family's.
 *
 * A child whose leg is the family's own is not ours to plan — the census children arrive with
 * their family and have no stop (fixtures/standard.ts) — so they are not a rider here. Putting
 * them in a van would invent a pickup the day does not have.
 */
function ridersOfDay(direction: Direction): DemoChild[] {
  return CHILDREN.filter((child) => {
    const mode = direction === "AM" ? child.amMode : child.pmMode;
    return mode !== "FAMILY" && child.stopKey !== null;
  });
}

function toRider(child: DemoChild, direction: Direction): BoardRider {
  const label = stopLabel(child);
  if (label === null) throw new Error(`child ${child.key} has no stop to plan`);
  return {
    token: childTokenOf(child.key),
    name: child.label,
    needs: needsOf(child),
    stopLabel: label,
    window: plannedWindow(child, direction),
  };
}

/**
 * The riders of one leg. A child the day records as away is not one of them: they are in the
 * Absent group instead, and a van cannot be given somebody who is not coming.
 */
export function boardRiders(direction: Direction, absentTokens: readonly string[] = []): BoardRider[] {
  const absent = new Set(absentTokens);
  return ridersOfDay(direction)
    .map((child) => toRider(child, direction))
    .filter((rider) => !absent.has(rider.token));
}

/**
 * The children who are on the day's roster and not in the board's columns: the families who
 * drive their own child (§1.3's "Family drives" group) and anybody away today ("Absent").
 *
 * `absentTokens` comes from the day's attendance, not from here — a child is away because a
 * record says so, never because a fixture guessed.
 */
export function otherChildren(
  direction: Direction,
  absentTokens: readonly string[] = [],
): OtherChild[] {
  const absent = new Set(absentTokens);
  const riding = new Set(boardRiders(direction, absentTokens).map((rider) => rider.token));
  return CHILDREN.map((child) => ({ token: childTokenOf(child.key), name: child.label }))
    .filter((child) => !riding.has(child.token))
    .map((child) => ({
      ...child,
      bucket: absent.has(child.token) ? ("ABSENT" as const) : ("FAMILY_DRIVES" as const),
    }));
}

/** What a van's setup resolved to, which is the one thing the board cannot read from fixtures. */
export type VanSetupFacts = Pick<
  BoardVan,
  "setup" | "setupState" | "setupSource" | "setupFromDate" | "setupBy"
>;

/**
 * The vans on the road, named and numbered, each with the setup it is planned against today.
 *
 * The fleet and the drivers are the day's own (src/config/vans.ts over the demo fixtures, and
 * `driverFor`), so the board, the Today board and the ramp iPad name the same three vans. Only
 * the setup comes from outside — it is in the database — so that is the one thing passed in.
 */
export function boardVans(setupOf: (vehicleKey: string) => VanSetupFacts): BoardVan[] {
  return VANS.map((van) => ({
    id: vehicleIdOf(van.vehicleKey),
    slot: van.slot,
    name: vanNameOf(van.slot),
    driverName: driverFor(van.vehicleKey),
    ...setupOf(van.vehicleKey),
  }));
}

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

/** The riders in one van, in the order that van drives their stops. */
export function ridersInVan(
  day: BoardDay,
  plan: BoardPlan,
  vanId: string,
): BoardRider[] {
  const inVan = day.riders.filter((rider) => plan[rider.token]?.vanId === vanId);
  // The solver's own ordering, so a van's list and the map's stop numbers agree.
  const ordered = ridersInOrder(inVan.map(asPlanRider));
  return ordered.flatMap((planRider) => {
    const rider = inVan.find((r) => r.token === planRider.child.token);
    return rider ? [rider] : [];
  });
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

/* ───────────────────────────── the solver's question ───────────────────────────── */

/**
 * One rider as the capacity solver reads a child — built from the four flags and nothing else.
 *
 * The chair's securement and footprint are the same on every chair here and every spot in every
 * van (src/domain/plan/setup.ts), so neither can decide a placement: that is conflict C3's
 * deferral written in the solver's own vocabulary. `tether` is the car seat and `escort` is the
 * nurse, which is how a seating plan says "an anchored seat" and "one more seat taken".
 */
function asPlanRider(rider: BoardRider): PlanRider {
  return {
    child: {
      token: rider.token,
      displayName: rider.name,
      mobility: rider.needs.wheelchair ? "WC" : "AMB",
      securement: "OTHER",
      wcLengthCm: rider.needs.wheelchair ? 1 : undefined,
      wcWidthCm: rider.needs.wheelchair ? 1 : undefined,
      tether: rider.needs.carSeat,
      escort: rider.needs.nurse,
    },
    stopLabel: rider.stopLabel,
    window: rider.window,
  };
}

function asPlanLane(van: BoardVan, date: string): PlanLane {
  return {
    id: van.id,
    vehicle: setupToVehicle(van.id, van.setup),
    capability: {
      vehicleId: van.id,
      serviceDate: date,
      // The setup is what somebody counted, so the solver is told the van's places are the ones
      // it has — "unknown until arrival" is not a state this model has: a van with no row yet is
      // planned on yesterday's counts and *says so* on screen (§9.1's soft step, conflict C5).
      state: "REPORTED",
      observedLayoutId: setupToVehicle(van.id, van.setup).layouts[0].id,
      liftOk: van.setup.hasLift,
      latchOk: true,
      unavailablePositionIds: [],
    },
    driverName: van.driverName,
  };
}

/** The day as the capacity solver's own question (§1.4's adapter). */
export function solverInput(day: BoardDay): PlanInput {
  return {
    direction: day.direction,
    centerLabel: places.center,
    lanes: day.vans.map((van) => asPlanLane(van, day.date)),
    riders: day.riders.map(asPlanRider),
  };
}

/** The board as the solver's assignment: van id → the child tokens in it. */
export function asAssignment(day: BoardDay, plan: BoardPlan): Assignment {
  const assignment: Record<string, string[]> = Object.fromEntries(day.vans.map((van) => [van.id, []]));
  for (const rider of day.riders) {
    const placement = plan[rider.token];
    if (placement?.bucket === "VAN" && placement.vanId && assignment[placement.vanId]) {
      assignment[placement.vanId].push(rider.token);
    }
  }
  // Drive order inside each van, so the plan the map draws and the plan the columns show agree.
  for (const van of day.vans) {
    assignment[van.id] = ridersInVan(day, plan, van.id).map((rider) => rider.token);
  }
  return assignment;
}

/** The plan as the map draws it: the solver's own reading, named by the board's van names. */
export function boardMap(day: BoardDay, plan: BoardPlan): PlanMapData {
  const input = solverInput(day);
  const nameOf = new Map(day.vans.map((van) => [van.id, van.name]));
  return planMap(routePlan(input, asAssignment(day, plan)), (laneId) => nameOf.get(laneId) ?? "");
}

/** The solver's full reading of a plan, for anything that needs more than the map. */
export function boardRoutePlan(day: BoardDay, plan: BoardPlan): RoutePlan {
  return routePlan(solverInput(day), asAssignment(day, plan));
}

/* ───────────────────────────── Auto-plan ───────────────────────────── */

/**
 * The rest of the day, planned: the capacity solver's own search over the vans' counts, keeping
 * every child a person has already placed where they put them.
 *
 * Three steps, and the third is the one a seating plan cannot do:
 *  1. the day becomes one synthetic seating plan per van (`setupToLayout`);
 *  2. `planAssignment` searches it, hardest rider first, checking each placement — pinned
 *     children are handed to it as `manual`, so they are planned around rather than re-planned;
 *  3. oxygen is checked afterwards, van by van, with the same `fits` every other caller uses: a
 *     van over its oxygen mounts gives up its last oxygen rider, who is offered the other vans in
 *     the day's own order and left in Unassigned if none of them can take them.
 *
 * A child the search cannot place stays in Unassigned with no reason attached: the reason is a
 * property of a *van* on this board (the dimmed column and its one-word chip), and inventing a
 * second explanation here would be a second source of truth about the same arithmetic.
 */
export function autoPlan(day: BoardDay, plan: BoardPlan): BoardPlan {
  const manual: Record<string, string | null> = {};
  for (const rider of day.riders) {
    const placement = plan[rider.token];
    if (!placement?.pinned) continue;
    manual[rider.token] = placement.bucket === "VAN" ? placement.vanId : null;
  }

  const searched = planAssignment(solverInput(day), manual as ManualPlacements);
  let next: Record<string, Placement> = { ...plan };
  for (const rider of day.riders) {
    next[rider.token] = { bucket: "UNASSIGNED", vanId: null, pinned: plan[rider.token]?.pinned === true };
  }
  for (const van of day.vans) {
    for (const token of searched[van.id] ?? []) {
      next[token] = { bucket: "VAN", vanId: van.id, pinned: plan[token]?.pinned === true };
    }
  }
  return oxygenChecked(day, next);
}

/** Every van within its oxygen mounts, by moving or unplacing the riders it cannot hold. */
function oxygenChecked(day: BoardDay, plan: Record<string, Placement>): BoardPlan {
  let next: BoardPlan = plan;
  for (const van of day.vans) {
    // Last placed, first asked to move: the earlier riders are the harder ones to place.
    const riders = [...ridersInVan(day, next, van.id)].reverse();
    for (const rider of riders) {
      if (fits(van.setup, ridersInVan(day, next, van.id))) break;
      if (!rider.needs.oxygen) continue;
      const elsewhere = day.vans.find(
        (other) =>
          other.id !== van.id &&
          rejectReason(other.setup, ridersInVan(day, next, other.id), rider) === null,
      );
      next = moveTo(next, rider.token, elsewhere?.id ?? null);
      // Moved by the search and not by a person, so it is not pinned.
      next = { ...next, [rider.token]: { ...next[rider.token], pinned: plan[rider.token].pinned } };
    }
  }
  return next;
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
    let aboard: BoardRider[] = [];
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

/** The needs of one rider by token, for the screen's chips. */
export function needsByToken(day: BoardDay, token: string): NeedFlags | null {
  return day.riders.find((rider) => rider.token === token)?.needs ?? null;
}
