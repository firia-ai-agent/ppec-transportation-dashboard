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
