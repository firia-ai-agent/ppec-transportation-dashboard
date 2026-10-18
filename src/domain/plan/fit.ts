/**
 * Does this van, set up the way it is today, hold these children? One pure function, and the
 * only answer on either side of the wire (redesign spec §1.4).
 *
 * It replaces layout matching on the planning and ramp screens. A van is no longer one of three
 * mutually exclusive seating plans (PRD §7 / conflict C1) — it is five numbers somebody counted
 * when it arrived — so "fits" is arithmetic over those numbers and the needs on each child's
 * approved profile, and nothing else. Securement hardware and chair footprint stay on the
 * profile and are not part of fit in v1 (C3, deferred after the demo by the founder on
 * 2026-10-17 2:59 PM ET); nor are seating separation and maximum ride time (C7, same ruling).
 *
 * **Peak equals total.** Every rider on one leg is aboard together at the centre end of the run —
 * a morning run ends at the centre with everyone in the van, an afternoon run starts there — so
 * the busiest moment is the whole roster and there is no per-stop arithmetic to do. That is the
 * assumption §8 names and defers: multi-leg peak-onboard fitting comes after the demo.
 *
 * Three callers, one function, which is the point:
 *  - the board while dragging, to pre-check every van against the lifted child;
 *  - the board's save endpoint, which re-asks it on the server, because a request did not come
 *    from the screen (the same "replay on the server" rule #58 established for `checkPlan`);
 *  - the ramp iPad, which asks it again as the front desk changes the counts, so "Mia R. won't
 *    fit · 1 car seat short" is the same verdict the coordinator's screen gave.
 *
 * Pure: no clock, no database, no network, no copy. The reasons it returns are keys
 * (src/config/equipment.ts `RejectReason`); the words for them are in src/ui/copy.ts.
 */
import {
  EQUIPMENT_COUNTERS,
  type CounterKey,
  type NeedFlags,
  type RejectReason,
} from "@/config/equipment";

/** What one van has on board today: the four counts and whether the lift works. */
export type VanSetup = {
  seats: number;
  wheelchairSpots: number;
  carSeats: number;
  oxygenMounts: number;
  hasLift: boolean;
};

/** A child as the fit rule reads them: who they are, and what they need. */
export type FitRider = {
  /** The child's id. Never a fixture key on this screen (§9.3: ids, never codes). */
  token: string;
  /** "Mia R." — the name a coordinator reads, for the refusal line and the screen reader. */
  name: string;
  needs: NeedFlags;
};

/** How much of each counter a set of riders takes. Every counter, always, so a meter can read it. */
export type Used = Readonly<Record<CounterKey, number>>;

/**
 * The order a refusal is decided in — the first counter that fails is the one the chip names.
 *
 * Not the display order (§0's Seats, Wheelchair, Car seats, Oxygen) and not quite §1.4's written
 * order either: the spec lists LIFT first, and the acceptance it is gated by (§1.7 #1) drags a
 * wheelchair rider onto a van with **no wheelchair spot and no lift** and requires the chip to
 * read `Wheelchair`. So the missing spot is named ahead of the missing lift, which is also the
 * more useful of the two answers and the same reasoning the capacity solver's own ranking uses
 * (src/domain/solver/plan.ts `CAUSE_PREFERENCE`): a van with nowhere to put a chair is a
 * different conversation from a van with a place for it and a lift that will not lift.
 */
export const REJECT_ORDER: readonly RejectReason[] = [
  "WHEELCHAIR",
  "LIFT",
  "OXYGEN",
  "CAR_SEAT",
  "SEAT",
];

/** Every counter at zero. */
export function noneUsed(): Record<CounterKey, number> {
  const used = {} as Record<CounterKey, number>;
  for (const counter of EQUIPMENT_COUNTERS) used[counter.key] = 0;
  return used;
}

/** How much of each counter these riders take, counter by counter (§1.4's four sums). */
export function usedBy(riders: readonly FitRider[]): Used {
  const used = noneUsed();
  for (const counter of EQUIPMENT_COUNTERS) {
    used[counter.key] = riders.reduce((n, rider) => n + counter.demandOf(rider.needs), 0);
  }
  return used;
}

/** Does this van need its lift today? Only a rider in their own chair boards by lift. */
export function needsLift(riders: readonly FitRider[]): boolean {
  return riders.some((rider) => rider.needs.wheelchair);
}

/**
 * Every way this van is short for these riders, in refusal order: the counter, how much is
 * missing, and nothing about which child is to blame — a van that is one car seat short is one
 * car seat short whoever is in it.
 *
 * `LIFT` has no count: a lift is not a number, it either works or it does not, so its shortfall
 * is reported as 1 and read as a yes/no (the ramp line says "{n} {thing} short" for counters and
 * names the lift on its own).
 */
export type Shortfall = { reason: RejectReason; short: number };

export function shortfalls(setup: VanSetup, riders: readonly FitRider[]): Shortfall[] {
  const used = usedBy(riders);
  const found: Shortfall[] = [];
  for (const counter of EQUIPMENT_COUNTERS) {
    const over = used[counter.key] - setup[counter.key];
    if (over > 0) found.push({ reason: counter.reject, short: over });
  }
  if (needsLift(riders) && !setup.hasLift) found.push({ reason: "LIFT", short: 1 });
  return found.sort((a, b) => REJECT_ORDER.indexOf(a.reason) - REJECT_ORDER.indexOf(b.reason));
}

/** §1.4's `fits(setup, riders)`: no counter is over and the lift is there if a chair needs it. */
export function fits(setup: VanSetup, riders: readonly FitRider[]): boolean {
  return shortfalls(setup, riders).length === 0;
}

/**
 * Why this van cannot take this child **on top of the riders it already has**, or `null` when it
 * can — §1.4's `rejectReason(setup, riders, child)`.
 *
 * `riders` is what is already in the van, and the child is added to it rather than asked about
 * alone, because capacity is a fact about the load: the honest answer to "can Noah O. go in Van
 * 2" depends on who is in Van 2. A child already in the van is not counted twice, so re-checking
 * a drop into the van a child is already in answers about the plan as it stands.
 */
export function rejectReason(
  setup: VanSetup,
  riders: readonly FitRider[],
  child: FitRider,
): RejectReason | null {
  const withChild = [...riders.filter((rider) => rider.token !== child.token), child];
  return shortfalls(setup, withChild)[0]?.reason ?? null;
}

/** The first thing a van is short of for the riders it already has, or `null` when it is fine. */
export function firstShortfall(setup: VanSetup, riders: readonly FitRider[]): Shortfall | null {
  return shortfalls(setup, riders)[0] ?? null;
}

/**
 * Is this van over on any counter as it stands? The "Over capacity" state (§1.3): a setup lowered
 * below the riders already in the van. Save is still allowed — the ramp check is what stops
 * anybody boarding — so this is a state to show, not a block.
 */
export function isOver(setup: VanSetup, riders: readonly FitRider[]): boolean {
  return !fits(setup, riders);
}

/* ───────────────────────────── placement: the one decision ───────────────────────────── */

/**
 * A van as the placement function reads it: an id, the number it wears, and what it carries.
 *
 * Deliberately not a `BoardVan`: placement is arithmetic over counts and must not be able to see
 * a driver, a colour or a seating plan.
 */
export type PlaceableVan = { id: string; slot: number; setup: VanSetup };

/** Where a person has already put somebody: child token → van id, or null for "leave them out". */
export type PinnedPlacements = Readonly<Record<string, string | null>>;

/** A child nobody can take, and the exact thing the day is short of for them. */
export type Unplaced = { token: string; shortfall: Shortfall };

export type PlacementResult = {
  /** Van id → the child tokens on it, in the order they were placed. */
  byVan: Readonly<Record<string, readonly string[]>>;
  /** Child token → the van they are on, or null when nobody can take them. */
  vanOf: Readonly<Record<string, string | null>>;
  /** Everybody with no van, each with their own shortfall, in the order they were tried. */
  unplaced: readonly Unplaced[];
};

/**
 * **The** placement function: every child placed, and an exact shortfall for every child who is
 * not (Firia's rule 2, 2026-10-17 5:48 PM ET — "ONE pure function, built on the counters in
 * fit.ts, places every child and computes every shortfall").
 *
 * It is the answer behind all five surfaces that ask the question: Auto-plan on the board, the
 * pre-check while a card is held, the re-check the save endpoint runs on the server, the ramp's
 * live Fits / won't-fit list, and Re-plan. The seat-level solver (src/domain/solver) makes no
 * placement decision anywhere — it only orders the stops of a van somebody has already been put
 * in — so there is no second arithmetic to disagree with this one.
 *
 * How it decides, in four rules that are all the rules there are:
 *
 *  1. **Vans in slot order, children hardest first.** A child in their own chair is the hardest
 *     to place, then oxygen, then a car seat, then a nurse; ties break on the child's token. The
 *     inputs are sorted before anything is placed, so the same day shuffled into any order gives
 *     an identical answer (Veri's property (d)).
 *  2. **Pinned children first, and only if they fit.** A person's own move is honoured ahead of
 *     every search. If the van has since been counted *down* under them — the front desk found
 *     one car seat where the plan had two — the pin is reported as a shortfall rather than
 *     quietly over-filling the van, so no counter is ever exceeded (property (a)).
 *  3. **The emptiest van that can take them.** Among the vans that fit the child, the one
 *     carrying the fewest riders, and the lowest slot of those. Filling Van 1 to the roof first
 *     is also a legal answer; this one spreads the day the way the mockup draws it and is just as
 *     deterministic.
 *  4. **A child nobody can take is named with the smallest true shortfall.** Every van is asked
 *     what it would be short of, and the gentlest honest answer wins — "1 car seat short" rather
 *     than the worst van's "3 seats short" — because that is the one a coordinator can act on.
 *
 * Pure: no clock, no database, no copy, no randomness.
 */
export function placeRiders(
  vans: readonly PlaceableVan[],
  riders: readonly FitRider[],
  pinned: PinnedPlacements = {},
): PlacementResult {
  const inSlotOrder = [...vans].sort((a, b) => a.slot - b.slot || a.id.localeCompare(b.id));
  const byVan: Record<string, FitRider[]> = Object.fromEntries(inSlotOrder.map((van) => [van.id, []]));
  const vanOf: Record<string, string | null> = {};
  const unplaced: Unplaced[] = [];

  const ordered = [...riders].sort(
    (a, b) => hardness(b.needs) - hardness(a.needs) || a.token.localeCompare(b.token),
  );
  /** Who could not be placed, and which vans their shortfall is about (their pin, or all). */
  const refused: { rider: FitRider; scope: readonly PlaceableVan[] }[] = [];
  // A pin is a decision somebody already made, so it is honoured before the search runs.
  const pinnedFirst = [
    ...ordered.filter((rider) => rider.token in pinned),
    ...ordered.filter((rider) => !(rider.token in pinned)),
  ];

  for (const rider of pinnedFirst) {
    const pin = rider.token in pinned ? pinned[rider.token] : undefined;
    if (pin === null) {
      // Pinned out of every van by a person: not a shortfall, just not in a van.
      vanOf[rider.token] = null;
      continue;
    }
    // A pinned child is asked of their own van and of no other: "Van 3 is a car seat short" is
    // the answer to a pin that no longer fits, not "Van 1 could have taken them".
    const scope = pin === undefined ? inSlotOrder : inSlotOrder.filter((van) => van.id === pin);
    const chosen = emptiest(
      scope.filter((van) => rejectReason(van.setup, byVan[van.id], rider) === null),
      byVan,
    );
    if (chosen) {
      byVan[chosen.id].push(rider);
      vanOf[rider.token] = chosen.id;
      continue;
    }
    vanOf[rider.token] = null;
    refused.push({ rider, scope });
  }

  /*
   * The shortfall is computed **after** everybody is placed, not while the search runs, so it
   * describes the plan as it ends up: "Mia R. won't fit · 1 car seat short" is about the board a
   * coordinator is looking at, and a child placed after her must not leave her line describing a
   * van that has since filled up differently.
   */
  for (const { rider, scope } of refused) {
    unplaced.push({ token: rider.token, shortfall: shortestFall(scope, byVan, rider) });
  }

  return {
    byVan: Object.fromEntries(
      Object.entries(byVan).map(([id, aboard]) => [id, aboard.map((rider) => rider.token)]),
    ),
    vanOf,
    unplaced,
  };
}

/** How hard a child is to place: the chair first, then oxygen, then a car seat, then the nurse. */
function hardness(needs: NeedFlags): number {
  return (needs.wheelchair ? 8 : 0) + (needs.oxygen ? 4 : 0) + (needs.carSeat ? 2 : 0) + (needs.nurse ? 1 : 0);
}

/** The van carrying the fewest riders, lowest slot first. Null when none of them can take the child. */
function emptiest(
  candidates: readonly PlaceableVan[],
  byVan: Readonly<Record<string, readonly FitRider[]>>,
): PlaceableVan | null {
  let best: PlaceableVan | null = null;
  for (const van of candidates) {
    if (!best || byVan[van.id].length < byVan[best.id].length) best = van;
  }
  return best;
}

/**
 * The smallest true thing the day is short of for one child: every van asked what adding them
 * would break, and the least bad of those answers.
 *
 * With no vans at all there is nothing to be short *of* but a seat, which is the honest floor:
 * a day with no van cannot carry a child.
 */
function shortestFall(
  vans: readonly PlaceableVan[],
  byVan: Readonly<Record<string, readonly FitRider[]>>,
  rider: FitRider,
): Shortfall {
  let best: Shortfall | null = null;
  for (const van of vans) {
    const found = shortfalls(van.setup, [...byVan[van.id], rider])[0];
    if (!found) continue;
    if (
      !best ||
      found.short < best.short ||
      (found.short === best.short &&
        REJECT_ORDER.indexOf(found.reason) < REJECT_ORDER.indexOf(best.reason))
    ) {
      best = found;
    }
  }
  return best ?? { reason: "SEAT", short: 1 };
}
