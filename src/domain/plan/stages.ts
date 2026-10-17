/**
 * What the day knows about each of its vans right now, and the solver input that follows from it.
 *
 * The Plan routes screen collects three kinds of fact as staff work: which van is on a lane
 * (a substitution, AT-05), what has been said about it (nobody yet, the provider's report, a ramp
 * check, or the two steps of VEH-05's chain), and whose chair the ramp has measured (AT-04). Put
 * together with the scenario and the run, those facts *are* the question the solver is asked —
 * `PlanInput` — and this module is the one place that turns one into the other.
 *
 * It lives in the domain rather than in the screen because two callers need the same answer: the
 * screen, which re-solves on every drag, and the save endpoint, which is handed the same facts
 * over HTTP and must re-ask the solver the same question before it keeps a plan. A second copy
 * of "V1 was substituted, so nothing is known about the van on that lane" is a second answer,
 * and then a plan could be refused on screen and saved by a request — which is the hole the
 * endpoint exists to close.
 *
 * Pure: no clock, no database, no network.
 */
import type { Assignment, DailyCapability, PlanInput, PlanLane, PlanRider } from "@/domain/solver";
import { places, rampPreview } from "@/ui/copy";
import { VEHICLES } from "@/modules/demo/fixtures/standard";
import {
  asMeasured,
  askedProvider,
  checkedAtRamp,
  DRIVERS,
  notCheckedYet,
  RELIEF_DRIVERS,
  planLanes,
  planRiders,
  reportedByProvider,
  substituted,
  vehicleByKey,
  type DemoScenario,
  type Direction,
} from "./day";

/**
 * The three answers a lane can be given about what arrived (VEH-02, VEH-04), plus the two the
 * substitution chain puts it in. "Not checked yet" is first because it is the honest state of a
 * morning, and it is never read as a yes.
 *
 * `CHANGED` and `ASKED` are not answers anybody taps: they are where a substitution puts a lane,
 * and where asking the provider again puts it — VEH-05's chain, substitution → unknown →
 * re-request → re-solve, is this field moving through its values.
 */
export const ARRIVAL_ANSWERS = ["NOT_CHECKED", "REPORTED", "RAMP_CHECKED"] as const;
export type ArrivalAnswer = (typeof ARRIVAL_ANSWERS)[number];

export const LANE_STAGES = [...ARRIVAL_ANSWERS, "CHANGED", "ASKED"] as const;
export type LaneStageState = (typeof LANE_STAGES)[number];

/** What the day knows about one lane's van, as the screen lets staff change it. */
export type LaneStage = {
  /** The van on this lane now, which is not always the van it started the day as (AT-05). */
  vehicleKey: string;
  driverName: string;
  arrival: LaneStageState;
  /** The configuration the ramp saw, pinned at the moment it was recorded (ASM-17). */
  rampLayoutId?: string;
};

/** The observation the solver reads for a lane in this stage. */
export function capabilityOf(stage: LaneStage): DailyCapability {
  switch (stage.arrival) {
    case "NOT_CHECKED":
      return notCheckedYet(stage.vehicleKey);
    case "CHANGED":
      return substituted(stage.vehicleKey);
    case "ASKED":
      return askedProvider(stage.vehicleKey);
    case "RAMP_CHECKED":
      return stage.rampLayoutId
        ? checkedAtRamp(stage.vehicleKey, stage.rampLayoutId, rampPreview.observedBy)
        : reportedByProvider(stage.vehicleKey);
    default:
      return reportedByProvider(stage.vehicleKey);
  }
}

/** Every lane of a scenario before anything has been reported, planned or substituted. */
export function initialStages(scenario: DemoScenario): Record<string, LaneStage> {
  return Object.fromEntries(
    planLanes(scenario).map((lane) => [
      lane.id,
      { vehicleKey: lane.vehicle.id, driverName: lane.driverName, arrival: "REPORTED" as const },
    ]),
  );
}

/** A plan with every lane in it and nobody in any of them. */
export function emptyAssignment(scenario: DemoScenario): Assignment {
  return Object.fromEntries(planLanes(scenario).map((lane) => [lane.id, []]));
}

/**
 * The scenario's lanes, as the stages have them now.
 *
 * A lane with no stage is the lane the scenario hands over, untouched: the screen switches
 * scenario and its stages arrive in the same render, so for one render a lane can be ahead of
 * them.
 */
export function lanesFromStages(
  scenario: DemoScenario,
  stages: Readonly<Record<string, LaneStage>>,
): PlanLane[] {
  return planLanes(scenario).map((lane) => {
    const stage = stages[lane.id];
    if (!stage) return lane;
    return {
      id: lane.id,
      vehicle: vehicleByKey(stage.vehicleKey),
      capability: capabilityOf(stage),
      driverName: stage.driverName,
    };
  });
}

/** The day's riders for one run, with the ramp's measurement where there is one (AT-04). */
export function ridersWithMeasurements(
  direction: Direction,
  measured: readonly string[],
): PlanRider[] {
  return planRiders(direction).map((rider) =>
    measured.includes(rider.child.token) ? asMeasured(rider) : rider,
  );
}

export type PlanDay = {
  scenario: DemoScenario;
  direction: Direction;
  stages: Readonly<Record<string, LaneStage>>;
  /** Child tokens whose chair the ramp has measured. */
  measured: readonly string[];
};

/** The question the solver is asked, for a day in this state. One definition, two callers. */
export function planInputOf(day: PlanDay): PlanInput {
  return {
    direction: day.direction,
    centerLabel: places.center,
    lanes: lanesFromStages(day.scenario, day.stages),
    riders: ridersWithMeasurements(day.direction, day.measured),
  };
}

/**
 * A day as a *request* describes it, accepted only if every id in it belongs to this run.
 *
 * The save endpoint is handed the lanes, the vans on them, who is driving, what has been
 * reported and whose chair was measured — because the solver's answer depends on all five, and a
 * server that re-asked the question with its own defaults would be answering a different one
 * (a van substituted on screen can carry nobody until the provider reports, and a plan made
 * around that is not a plan the morning's defaults would allow).
 *
 * Which means these are ids from outside, so each one is checked against the day rather than
 * used: the lanes are exactly the scenario's own, the van is one of the fleet's, a pinned
 * configuration is one that van is built with, the driver is somebody the day has on file, and a
 * measured chair belongs to a child on this run. Anything else is `null` — one answer, so the
 * caller cannot tell which id was wrong, or whether it exists somewhere they cannot see.
 *
 * `null` and not a throw: this is a request, and a bad id is a refusal rather than a fault.
 */
export function readPlanDay(asked: {
  scenario: DemoScenario;
  direction: Direction;
  stages: Readonly<Record<string, LaneStage>>;
  measured: readonly string[];
}): PlanDay | null {
  const laneIds = planLanes(asked.scenario).map((lane) => lane.id);
  const named = Object.keys(asked.stages);
  if (named.length !== laneIds.length) return null;
  if (!laneIds.every((id) => named.includes(id))) return null;

  const fleet = new Set(VEHICLES.map((vehicle) => vehicle.key));
  const drivers = new Set([...Object.values(DRIVERS), ...RELIEF_DRIVERS]);
  for (const id of laneIds) {
    const stage = asked.stages[id];
    if (!fleet.has(stage.vehicleKey)) return null;
    if (!drivers.has(stage.driverName)) return null;
    if (stage.rampLayoutId !== undefined) {
      const built = vehicleByKey(stage.vehicleKey).layouts.map((layout) => layout.id);
      if (!built.includes(stage.rampLayoutId)) return null;
    }
  }

  const roster = new Set(planRiders(asked.direction).map((rider) => rider.child.token));
  if (!asked.measured.every((token) => roster.has(token))) return null;

  return {
    scenario: asked.scenario,
    direction: asked.direction,
    stages: asked.stages,
    measured: asked.measured,
  };
}
