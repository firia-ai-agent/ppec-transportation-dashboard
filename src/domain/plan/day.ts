/**
 * The day the Plan routes screen plans: the demo scenario, in the shapes the capacity solver
 * and its planner (src/domain/solver/plan.ts) speak.
 *
 * Same job as src/domain/board/scenario.ts does for the board, and it reuses that module's
 * projections rather than writing a second one — one definition of "the scenario's V1 as the
 * solver sees it" is the only way the board and this screen can agree about a van. What is new
 * here is the planning day itself: which children are ours to drive, which vans the day has,
 * who is driving them, which van is in reserve for a substitution (AT-05), and what the ramp
 * measures when a chair arrives bigger than the file says (AT-04).
 *
 * Pure data and pure functions: no clock, no database, no network. Every person is synthetic
 * and is written first name plus last initial (ADR-015, DECISION-LEDGER row 31); the stops are
 * the MOCKS §1 public landmarks and never a home.
 */
import { solverChild, solverVehicle, plannedWindow, stopLabel } from "@/domain/board/scenario";
import type { DailyCapability, PlanLane, PlanRider, Vehicle } from "@/domain/solver";
import { SERVICE_DATE } from "@/fixtures/fleet";
import {
  CHILDREN,
  RUNS,
  VEHICLES,
  childByKey,
  type Child as DemoChild,
  type NeedCategory,
} from "@/modules/demo/fixtures/standard";

export type Direction = "AM" | "PM";

/**
 * The synthetic service date the capability observations below belong to — the same one the ramp
 * check reads (src/fixtures/fleet.ts), because the two screens look at one van on one day.
 */
export const PLAN_SERVICE_DATE = SERVICE_DATE;

/**
 * Today's drivers, one per van, synthetic.
 *
 * The scenario names families, children, therapists and provider dispatchers, and no drivers —
 * nothing in the build needed one until a lane had to say who was on it. A substitution that
 * changes the van also changes the person at the wheel, and a coordinator approving one needs
 * both names, so the names live here with the rest of the day's fiction rather than being
 * invented in the view.
 */
export const DRIVERS: Readonly<Record<string, string>> = {
  V1: "Marco D.",
  V2: "Nadia P.",
  V3: "Omar T.",
  V4: "Bea L.",
};

/**
 * The drivers on call, for a driver substitution (AT-05) that does not change the van. One per
 * lane, so two lanes cannot both be given the same person.
 */
export const RELIEF_DRIVERS: readonly string[] = ["Gus M.", "Priya K.", "Tobin E."];

/** The name to show when a van has nobody on file to drive it. */
export function driverFor(vehicleKey: string): string {
  return DRIVERS[vehicleKey] ?? RELIEF_DRIVERS[0];
}

/* ───────────────────────────── vans ───────────────────────────── */

export function vehicleByKey(key: string): Vehicle {
  const vehicle = VEHICLES.find((v) => v.key === key);
  if (!vehicle) throw new Error(`unknown vehicle ${key}`);
  return solverVehicle(vehicle);
}

/**
 * The two scenarios the screen can replay, both on the one service date above.
 *
 * `EVERY_RIDER_FITS` is the scenario's own fleet and what the screen opens on: three vans, nine
 * riders, and a van for each of them. It is what the browser check plans and asserts every
 * child into a van that fits them.
 *
 * `ONE_RIDER_HAS_NO_VAN` is the other half of §9, and it exists because the first never shows
 * it: with everyone placed, the group at the top of the screen and the reasons in it (AT-12)
 * are unreachable in a normal walk. Here the convertible van is off the road and the provider
 * has sent the small substitute in its place, so no van holds a four-point strap — one child's
 * chair has nowhere to go, for a reason a coordinator can act on, and the other eight riders
 * still get a van.
 *
 * Neither is a different *day*: `PLAN_SERVICE_DATE` is the only date either one replays, and
 * nothing about the solver changes between them — the second is the same planner over a
 * different fleet. They were called days until Vera's review on 2026-10-17, which is also why
 * the screen's own labels no longer read like a calendar (src/ui/copy.ts `demoScenario`).
 */
export const DEMO_SCENARIOS = ["EVERY_RIDER_FITS", "ONE_RIDER_HAS_NO_VAN"] as const;
export type DemoScenario = (typeof DEMO_SCENARIOS)[number];

/** The vans the day plans with: one lane each, in the scenario's own run order. */
export const LANE_VEHICLE_KEYS: readonly string[] = RUNS.map((run) => run.vehicleKey);

/** The van the convertible's absence is covered with, which is the scenario's own reserve van. */
const STAND_IN_VEHICLE_KEY = "V3";

/** The van that is off the road in the scenario where one child has no van. */
const ABSENT_VEHICLE_KEY = "V1";

/** The vans on the road, lane by lane, in one of the two scenarios. */
export function laneVehicleKeys(
  scenario: DemoScenario = "EVERY_RIDER_FITS",
): readonly string[] {
  if (scenario === "EVERY_RIDER_FITS") return LANE_VEHICLE_KEYS;
  return LANE_VEHICLE_KEYS.map((key) =>
    key === ABSENT_VEHICLE_KEY ? STAND_IN_VEHICLE_KEY : key,
  );
}

/**
 * The vans the day holds in reserve — V3 in the standard scenario, which is there for exactly
 * this: the provider's substitute (PRD l.1328, AT-05). In the scenario where the convertible is
 * off the road, the reserve is on a lane and the convertible is what a substitution could
 * bring back.
 */
export const SPARE_VEHICLE_KEYS: readonly string[] = VEHICLES.map((v) => v.key).filter(
  (key) => !LANE_VEHICLE_KEYS.includes(key),
);

export function spareVehicleKeys(
  scenario: DemoScenario = "EVERY_RIDER_FITS",
): readonly string[] {
  const onTheRoad = laneVehicleKeys(scenario);
  return VEHICLES.map((v) => v.key).filter((key) => !onTheRoad.includes(key));
}

/* ───────────────────── what the day knows about a van ───────────────────── */

/**
 * Nobody has said anything about this van today.
 *
 * The normal state of a morning, not an error (PRD §9, DESIGN-DIRECTION §4.2): the solver
 * answers CAPABILITY_PENDING and the lane takes nobody, because unknown is never read as a yes.
 */
export function notCheckedYet(vehicleId: string): DailyCapability {
  return {
    vehicleId,
    serviceDate: PLAN_SERVICE_DATE,
    state: "UNKNOWN",
    liftOk: null,
    latchOk: null,
    unavailablePositionIds: [],
  };
}

/**
 * The provider has reported what the van can do today, and has not said which configuration it
 * will arrive in — so the planner is free to search L(v), which is what planning *is*. The
 * configuration is pinned later, by whoever sees the van (`checkedAtRamp`).
 */
export function reportedByProvider(vehicleId: string): DailyCapability {
  return {
    vehicleId,
    serviceDate: PLAN_SERVICE_DATE,
    state: "REPORTED",
    observedLayoutId: null,
    liftOk: true,
    latchOk: true,
    unavailablePositionIds: [],
  };
}

/** Ramp staff have seen the van and the configuration it arrived in (ASM-17 pins it here). */
export function checkedAtRamp(vehicleId: string, layoutId: string, observedBy: string): DailyCapability {
  return {
    vehicleId,
    serviceDate: PLAN_SERVICE_DATE,
    state: "VERIFIED",
    observedLayoutId: layoutId,
    liftOk: true,
    latchOk: true,
    unavailablePositionIds: [],
    observedAt: `${PLAN_SERVICE_DATE}T07:05:00-04:00`,
    observedBy,
  };
}

/**
 * A different van is coming (VEH-05). CHANGED is its own state and not UNKNOWN: the solver says
 * "a different vehicle is coming, and what it can carry is unknown until the provider reports"
 * rather than the plain morning sentence, because those are two different days.
 */
export function substituted(vehicleId: string): DailyCapability {
  return {
    vehicleId,
    serviceDate: PLAN_SERVICE_DATE,
    state: "CHANGED",
    liftOk: null,
    latchOk: null,
    unavailablePositionIds: [],
  };
}

/** The provider has been asked again and has not answered yet (VEH-05, the middle step). */
export function askedProvider(vehicleId: string): DailyCapability {
  return {
    vehicleId,
    serviceDate: PLAN_SERVICE_DATE,
    state: "REQUESTED",
    liftOk: null,
    latchOk: null,
    unavailablePositionIds: [],
  };
}

/* ───────────────────────────── riders ───────────────────────────── */

/**
 * The children this day drives, in the direction asked for.
 *
 * A child whose leg is the family's own (`FAMILY`) is not ours to plan — the census children
 * arrive with their family and have no stop of their own (standard.ts) — so they are not on
 * this screen at all. Putting them in a lane would invent a pickup the day does not have.
 */
export function planRiders(direction: Direction): PlanRider[] {
  return CHILDREN.filter((child) => {
    const mode = direction === "AM" ? child.amMode : child.pmMode;
    return mode !== "FAMILY" && child.stopKey !== null;
  }).map((child) => toRider(child, direction));
}

function toRider(child: DemoChild, direction: Direction): PlanRider {
  const label = stopLabel(child);
  if (label === null) throw new Error(`child ${child.key} has no stop to plan`);
  return { child: solverChild(child), stopLabel: label, window: plannedWindow(child, direction) };
}

/**
 * The approved needs the solver is allowed to plan against (VEH-01, DECISION-LEDGER row 1:
 * fulfilment counts approved needs only).
 */
export function approvedNeeds(childToken: string): NeedCategory[] {
  return childByKey(childToken)
    .needs.filter((need) => need.state === "APPROVED")
    .map((need) => need.category);
}

/**
 * The needs on file that are *not* approved yet.
 *
 * VEH-01 asks for these to be on screen and visibly not part of the allocation: a reported item
 * is a real thing a family told us, and hiding it would lose it, while counting it would plan
 * the day against a need no director has signed. So the lane shows them, muted, with a line
 * saying they are not used for planning — and the solver never sees them.
 */
export function unapprovedNeeds(childToken: string): NeedCategory[] {
  return childByKey(childToken)
    .needs.filter((need) => need.state !== "APPROVED")
    .map((need) => need.category);
}

/**
 * The chair as the ramp measures it, for the one child whose equipment arrives different from
 * the file (AT-04: unknown equipment at arrival).
 *
 * The approved profile says 128 × 70 cm; the chair that arrives has a new headrest and a tray,
 * and measures 142 × 74. No van in the scenario has a wheelchair place that takes it, which is
 * the point: the run is infeasible *before* anyone boards, and a coordinator has to decide.
 */
export const MEASURED_AT_ARRIVAL: Readonly<Record<string, { wcLengthCm: number; wcWidthCm: number }>> = {
  C6: { wcLengthCm: 142, wcWidthCm: 74 },
};

/** The rider with the chair the ramp measured, when there is a measurement for them. */
export function asMeasured(rider: PlanRider): PlanRider {
  const measured = MEASURED_AT_ARRIVAL[rider.child.token];
  if (!measured) return rider;
  return { ...rider, child: { ...rider.child, ...measured } };
}

/* ───────────────────────────── the lanes ───────────────────────────── */

/**
 * The day's lanes before anything has been reported or planned: one per van the scenario runs,
 * each with the provider's report for today and the driver on it.
 *
 * The lane's id is the van it starts the day as. It stays that lane's id after a substitution,
 * because the children planned into it are the same children with the same stops — see
 * `PlanLane` in src/domain/solver/plan.ts.
 */
export function planLanes(scenario: DemoScenario = "EVERY_RIDER_FITS"): PlanLane[] {
  return laneVehicleKeys(scenario).map((key) => ({
    id: key,
    vehicle: vehicleByKey(key),
    capability: reportedByProvider(key),
    driverName: driverFor(key),
  }));
}
