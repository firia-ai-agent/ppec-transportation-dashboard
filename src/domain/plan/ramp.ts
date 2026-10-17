/**
 * What a ramp check does to the day (PRD §9 l.876, AT-04 "unknown equipment at arrival").
 *
 * The ramp iPad (SURF-04) used to be a surface with no consequences: staff answered the §4.4
 * checklist, the solver said whether the run fitted, and that was the end of it — the plan the
 * coordinator was looking at and the board the centre was running on knew nothing about the van
 * that had just arrived set up the wrong way round. This module is the consequence. One ramp
 * observation goes in; the day's plan comes out re-asked, with the children the van can no
 * longer carry moved into a van that fits them or left waiting for one, and the reason named.
 *
 * Every placement and every refusal here is the solver's: each one goes through `tryMove`
 * (src/domain/solver/plan.ts), which is the one call that asks `canTake` and edits the
 * assignment as a single decision. Nothing in this file decides that a child fits.
 *
 * Pure: no clock, no database, no network, no LLM. The same observation always produces the
 * same re-plan, which is what lets three screens show one answer and a browser check assert it.
 */
import { ridersInOrder, routePlan, tryMove } from "@/domain/solver";
import type {
  Assignment,
  DailyCapability,
  Layout,
  Leg,
  PlanInput,
  PlanLane,
  PlanRider,
  RoutePlan,
  Unplaced,
  UnplacedCause,
  Vehicle,
} from "@/domain/solver";
import { solverLeg } from "@/domain/board/scenario";
import { RUNS } from "@/modules/demo/fixtures/standard";
import { places, rampPreview } from "@/ui/copy";
import {
  PLAN_SERVICE_DATE,
  planLanes,
  planRiders,
  vehicleByKey,
  type Direction,
} from "./day";

/**
 * The ramp checks the afternoon rides: the vans arrive at the centre, staff walk the checklist,
 * and the children board for the ride home (`rampPreview.subtitle`). A morning ramp check is a
 * different surface — the provider confirms at the kerb (PRD §9) — so this module has one
 * direction and does not take it as an argument from a screen.
 */
export const RAMP_DIRECTION: Direction = "PM";

/**
 * When the observation was made, for the vans that arrive mid-afternoon. A fixed instant rather
 * than a clock: this is the demo day's own fiction, and a screenshot of it has to be the same
 * tomorrow (ADR-015).
 */
const OBSERVED_AT = `${PLAN_SERVICE_DATE}T15:05:00-04:00`;

/** A vehicle's configuration by its trade code ("1WC/3A"), which is what a ramp check names. */
export function layoutOfCode(vehicle: Vehicle, code: string): Layout {
  const layout = vehicle.layouts.find((l) => l.code === code);
  if (!layout) throw new Error(`vehicle ${vehicle.id} has no configuration ${code}`);
  return layout;
}

/**
 * A finished ramp check of one van, in the smallest form that can be carried between screens.
 *
 * Positions are given by their place in the configuration rather than by id, so the value is
 * short enough to put in a link and carries no child, family or device data of any kind — the
 * only things in it are a van key, a configuration code, two yes/no answers and seat numbers.
 *
 * "Not sure" cannot appear here. A check with a row still unanswered leaves the run unchecked
 * (`rampPreview.checklistIntro`), and an unchecked run is not a finding to re-plan a day with,
 * so the ramp screen only offers the day a check whose every row has an answer.
 */
export type RampFinding = {
  /** The lane the van is on, which in this scenario is the van's own key. */
  laneId: string;
  vehicleKey: string;
  /** The configuration the van actually arrived in. */
  layoutCode: string;
  liftOk: boolean;
  latchOk: boolean;
  /** 1-based places in that configuration that are out of service, ascending. */
  outOfService: readonly number[];
};

/** The observation a finished ramp check records for the vehicle-day (ops.vehicle_capability_day). */
export function rampObservation(finding: RampFinding): DailyCapability {
  const vehicle = vehicleByKey(finding.vehicleKey);
  const layout = layoutOfCode(vehicle, finding.layoutCode);
  return {
    vehicleId: vehicle.id,
    serviceDate: PLAN_SERVICE_DATE,
    // Ramp staff saw the van themselves, so the observation is a verified one (ASM-17 pins the
    // configuration at the same moment).
    state: "VERIFIED",
    observedLayoutId: layout.id,
    liftOk: finding.liftOk,
    latchOk: finding.latchOk,
    unavailablePositionIds: finding.outOfService.flatMap((n) => {
      const position = layout.positions[n - 1];
      return position ? [position.id] : [];
    }),
    unknownPositionIds: [],
    observedAt: OBSERVED_AT,
    observedBy: rampPreview.observedBy,
  };
}

/* ───────────────────────── carrying the finding between screens ───────────────────────── */

const FIELD = "~";
const LIST = ",";
const YES = "y";
const NO = "n";

/**
 * The finding as one short, readable query value: "V1~2WC/1A~y~y~3".
 *
 * A link and not a store, because the three screens that read it are a client screen, a server
 * page and another server page, and the alternative — a cookie, a row, a module-level singleton
 * — would make "what did the ramp find" a thing that can differ between two tabs. There is no
 * database behind this surface at all (ADR-015, MOCKS-AND-DEMO §2), so the link *is* the record,
 * and it says so: the ramp screen hands the day its finding by handing over a URL.
 */
export function encodeRampFinding(finding: RampFinding): string {
  return [
    finding.vehicleKey,
    finding.layoutCode,
    finding.liftOk ? YES : NO,
    finding.latchOk ? YES : NO,
    [...finding.outOfService].sort((a, b) => a - b).join(LIST),
  ].join(FIELD);
}

/**
 * The finding a link carries, or null.
 *
 * Fail-closed on anything it cannot read as a van this day runs, a configuration that van has
 * and seat numbers that configuration holds: a mistyped or stale link shows the day as planned
 * rather than a day invented out of a bad parameter.
 */
export function decodeRampFinding(value: string | null | undefined): RampFinding | null {
  if (typeof value !== "string" || value.length === 0) return null;
  const [vehicleKey, layoutCode, lift, latch, out = ""] = value.split(FIELD);
  if (!vehicleKey || !layoutCode) return null;
  if ((lift !== YES && lift !== NO) || (latch !== YES && latch !== NO)) return null;
  const lane = planLanes().find((l) => l.id === vehicleKey);
  if (!lane) return null;
  const layout = lane.vehicle.layouts.find((l) => l.code === layoutCode);
  if (!layout) return null;
  const outOfService: number[] = [];
  for (const part of out.split(LIST).filter((p) => p.length > 0)) {
    const n = Number(part);
    if (!Number.isInteger(n) || n < 1 || n > layout.positions.length) return null;
    if (!outOfService.includes(n)) outOfService.push(n);
  }
  return {
    laneId: lane.id,
    vehicleKey,
    layoutCode,
    liftOk: lift === YES,
    latchOk: latch === YES,
    outOfService: outOfService.sort((a, b) => a - b),
  };
}

/* ───────────────────────────── the re-plan ───────────────────────────── */

/** One child the ramp check moved, named with the van they came off and the van they ride now. */
export type RampMove = {
  rider: PlanRider;
  fromLaneId: string;
  toLaneId: string;
};

export type RampReplan = {
  finding: RampFinding;
  /** The lanes and riders the re-plan was asked about, so a screen can re-solve from it. */
  input: PlanInput;
  /** The day as the provider reported it: the scenario's own runs, solved. */
  before: RoutePlan;
  /** The same day with the ramp's observation on the van that was checked. */
  after: RoutePlan;
  /** The assignment `after` reports, so a screen can keep moving children from here. */
  assignment: Assignment;
  moves: readonly RampMove[];
  /** Children the re-plan could not place in any van, with the solver's reason. */
  held: readonly Unplaced[];
};

/**
 * The day's runs as the scenario states them: one lane per van, carrying that run's children.
 *
 * The re-plan starts from here rather than from a fresh search, because this is the plan the
 * centre is actually running — the same `RUNS` the Today board reads — and a ramp check is a
 * change to *that*, not an invitation to re-shuffle every van in the building.
 */
export function scenarioAssignment(riders: readonly PlanRider[]): Assignment {
  const planned = new Set(riders.map((rider) => rider.child.token));
  return Object.fromEntries(
    RUNS.map((run) => [run.vehicleKey, run.childKeys.filter((key) => planned.has(key))]),
  );
}

function laneOrder(input: PlanInput, laneId: string): PlanLane[] {
  return input.lanes.filter((lane) => lane.id !== laneId);
}

/**
 * The day re-planned around one ramp check.
 *
 * Three steps, each one the solver's:
 *
 *  1. the van that was checked is emptied and asked to take its own riders back, hardest to
 *     place first — the order `planAssignment` uses, for the same reason: fill a van with
 *     walking riders and the chair place it had is still there, while the seats a chair's
 *     attendant needed are gone;
 *  2. every rider it will not take is offered to the other vans, in the day's own lane order,
 *     and the first one that says yes gets them. That is a *move*, and it is the whole of
 *     "children who no longer fit ride a van that fits them";
 *  3. a rider no van will take comes out of every van. They are not quietly dropped: they land
 *     in `after.unplaced` with the solver's own reason, which is what the screens read.
 *
 * Nobody on this surface has boarded — the check happens before the ride home — so re-planning
 * breaks no rule. PRD §9 l.876 is the other half of that sentence and this module respects it:
 * once a child is aboard there is no auto re-plan, and `tryMove` is never asked about a boarded
 * child because a boarded child is not in this input.
 */
export function rampReplan(finding: RampFinding, direction: Direction = RAMP_DIRECTION): RampReplan {
  const riders = planRiders(direction);
  const baseLanes = planLanes();
  const baseInput: PlanInput = {
    direction,
    centerLabel: places.center,
    lanes: baseLanes,
    riders,
  };
  const base = scenarioAssignment(riders);
  const before = routePlan(baseInput, base);

  const observation = rampObservation(finding);
  const input: PlanInput = {
    ...baseInput,
    lanes: baseLanes.map((lane) =>
      lane.id === finding.laneId ? { ...lane, capability: observation } : lane,
    ),
  };

  // Hardest to place first, so the van keeps the riders with the fewest alternatives.
  const onTheVan = (base[finding.laneId] ?? [])
    .flatMap((token) => riders.filter((rider) => rider.child.token === token))
    .sort((a, b) => weight(b) - weight(a) || a.window.localeCompare(b.window));

  // Step 1: the checked van, emptied and asked again.
  let assignment: Assignment = { ...base, [finding.laneId]: [] };
  const displaced: PlanRider[] = [];
  for (const rider of onTheVan) {
    const moved = tryMove(input, assignment, rider.child.token, finding.laneId);
    if (moved.ok) assignment = moved.assignment;
    else displaced.push(rider);
  }

  // Steps 2 and 3: a van that fits them, or out of every van with the reason.
  const moves: RampMove[] = [];
  for (const rider of displaced) {
    const taken = laneOrder(input, finding.laneId).find((lane) => {
      const moved = tryMove(input, assignment, rider.child.token, lane.id);
      if (!moved.ok) return false;
      assignment = moved.assignment;
      return true;
    });
    if (taken) {
      moves.push({ rider, fromLaneId: finding.laneId, toLaneId: taken.id });
      continue;
    }
    const out = tryMove(input, assignment, rider.child.token, null);
    if (out.ok) assignment = out.assignment;
  }

  const after = routePlan(input, assignment);
  return {
    finding,
    input,
    before,
    after,
    assignment,
    moves,
    held: after.unplaced.filter((unplaced) =>
      displaced.some((rider) => rider.child.token === unplaced.rider.child.token),
    ),
  };
}

/** How hard a child is to place: a chair, then an anchored seat, then a plain seat. */
function weight(rider: PlanRider): number {
  if (rider.child.mobility === "WC") return 3;
  if (rider.child.tether) return 2;
  return 1;
}

/* ───────────────────────── what the other screens read ───────────────────────── */

/** What the ramp check did to one child's afternoon ride. */
export type RampRide =
  | { kind: "MOVED"; fromLaneId: string; toLaneId: string }
  | { kind: "HELD"; laneId: string; cause: UnplacedCause };

/**
 * The re-plan as the Today board and the planning screen read it: child key → what changed.
 *
 * Only the children the check actually changed are in here. A child the van still carries, and
 * a child on another van the check never touched, have nothing to show — a board that marked
 * every row because one van arrived wrong would be telling the centre nothing.
 */
export function rampRides(replan: RampReplan): Map<string, RampRide> {
  const rides = new Map<string, RampRide>();
  for (const move of replan.moves) {
    rides.set(move.rider.child.token, {
      kind: "MOVED",
      fromLaneId: move.fromLaneId,
      toLaneId: move.toLaneId,
    });
  }
  for (const unplaced of replan.held) {
    rides.set(unplaced.rider.child.token, {
      kind: "HELD",
      laneId: replan.finding.laneId,
      cause: unplaced.cause,
    });
  }
  return rides;
}

/* ───────────────────────── the vans the ramp is looking at ───────────────────────── */

/**
 * One van arriving at the ramp, as the checklist needs it: the van, the ride home it is about
 * to drive, and the configuration the manifest planned for it.
 *
 * Read out of the day the Today board reads (`RUNS` in src/modules/demo/fixtures/standard.ts,
 * projected by src/domain/board/scenario.ts), so the names on the iPad are the names on the
 * board: the same children, the same vans, the same manifest order. The ramp screen used to
 * carry its own fleet fixture, which is how an iPad could show a rider the board had never
 * heard of.
 */
export type RampArrival = {
  /** The lane this van is on, which is what a finding and a re-plan are keyed by. */
  laneId: string;
  vehicle: Vehicle;
  /** The ride home, with the manifest the plan gives it. */
  leg: Leg;
  riders: readonly PlanRider[];
  /** The configuration the manifest planned, which is what the checklist opens on. */
  plannedLayoutId: string;
  /** The first child this run sets down, and when — the only clock fact on the tile. */
  firstDropOff: string;
};

/**
 * The vans at the ramp, in the day's own run order.
 *
 * Every lane the day runs is here, including one whose run already does not fit: the ramp sees
 * the vans that arrive, not the vans whose plans are tidy.
 */
export function rampArrivals(direction: Direction = RAMP_DIRECTION): RampArrival[] {
  const riders = planRiders(direction);
  const byToken = new Map(riders.map((rider) => [rider.child.token, rider]));
  return planLanes().map((lane) => {
    const run = RUNS.find((r) => r.vehicleKey === lane.id);
    if (!run) throw new Error(`lane ${lane.id} has no run in the day`);
    const laneRiders = ridersInOrder(
      run.childKeys.flatMap((key) => {
        const rider = byToken.get(key);
        return rider ? [rider] : [];
      }),
    );
    return {
      laneId: lane.id,
      vehicle: lane.vehicle,
      leg: solverLeg(run, direction),
      riders: laneRiders,
      plannedLayoutId: layoutOfCode(lane.vehicle, run.layoutCode).id,
      firstDropOff: laneRiders[0]?.window ?? "",
    };
  });
}
