import { describe, expect, it } from "vitest";
import { checkPlan, placedCount, saveRefusalLine } from "./save";
import { planInputOf, type PlanDay } from "./stages";
import { initialStages, readPlanDay, type LaneStageState } from "./stages";
import { driverFor } from "./day";
import { planAssignment, tryMove, type Assignment } from "@/domain/solver";
import { planRoutes, securement, vanName } from "@/ui/copy";

/**
 * The check a saved plan has to pass.
 *
 * The point of these is adversarial: the screen only ever sends plans it built, so what is
 * asserted here is what happens to the plans it would *not* have built — a chair in a van with
 * no straps, a child in two vans, somebody else's child id, a van that is on no lane today. Each
 * one is refused, and the refusal that comes back is the one a coordinator would have read on
 * the screen for the same verdict.
 */
function dayOf(scenario: PlanDay["scenario"] = "EVERY_RIDER_FITS", direction: PlanDay["direction"] = "AM"): PlanDay {
  return { scenario, direction, stages: initialStages(scenario), measured: [] };
}

/** The lanes as a request may describe them: ids only, no person (`AskedLane`). */
function asked(stages: Record<string, { vehicleKey: string; arrival: LaneStageState }>) {
  return Object.fromEntries(
    Object.entries(stages).map(([laneId, stage]) => [
      laneId,
      { vehicleKey: stage.vehicleKey, arrival: stage.arrival },
    ]),
  );
}

/** A plan the screen would have made: the planner's own, which the solver agreed with. */
function plannedBy(day: PlanDay): Assignment {
  return planAssignment(planInputOf(day));
}

describe("a plan the screen made is a plan the server keeps", () => {
  it("accepts the planner's own assignment, and reports what is in a van", () => {
    const day = dayOf();
    const input = planInputOf(day);
    const checked = checkPlan(input, plannedBy(day));
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    expect(placedCount(checked.assignment)).toBe(input.riders.length);
    // Every lane the day has is a key, so the saved plan is the whole day and not a fragment.
    expect(Object.keys(checked.assignment).sort()).toEqual(input.lanes.map((l) => l.id).sort());
  });

  it("accepts a plan with nobody in it: an empty day is a plan, and it is not a refusal", () => {
    const day = dayOf();
    const input = planInputOf(day);
    const empty = Object.fromEntries(input.lanes.map((lane) => [lane.id, []]));
    const checked = checkPlan(input, empty);
    expect(checked.ok).toBe(true);
    expect(placedCount(empty)).toBe(0);
  });

  it("accepts a plan a coordinator rearranged by hand, because the solver still agrees", () => {
    const day = dayOf();
    const input = planInputOf(day);
    const moved = tryMove(input, plannedBy(day), "C8", "V2");
    expect(moved.ok).toBe(true);
    if (!moved.ok) return;
    expect(checkPlan(input, moved.assignment).ok).toBe(true);
  });
});

describe("a move the screen refused cannot be saved by sending it anyway", () => {
  /**
   * The hole this closes. In the scenario where one child cannot be placed, no van carries
   * four-point straps — the screen refuses that drag and says so — and a request that puts the
   * chair in a van regardless is the same question asked without the screen. It gets the same
   * answer, because it is the same `tryMove`.
   */
  it("refuses the chair the day has no hardware for, and names the van and the child", () => {
    const day = dayOf("ONE_RIDER_HAS_NO_VAN");
    const input = planInputOf(day);
    const lane = input.lanes[0];
    const forced: Assignment = Object.fromEntries(
      input.lanes.map((l) => [l.id, l.id === lane.id ? ["C6"] : []]),
    );

    // The screen's own answer to the same move, for comparison.
    const dragged = tryMove(input, { [lane.id]: [] }, "C6", lane.id);
    expect(dragged.ok).toBe(false);

    const checked = checkPlan(input, forced);
    expect(checked.ok).toBe(false);
    if (checked.ok) return;
    expect(checked.reason).toBe("REFUSED");
    if (checked.reason !== "REFUSED") return;
    expect(checked.childToken).toBe("C6");
    expect(checked.laneId).toBe(lane.id);
    if (!dragged.ok) expect(checked.cause).toBe(dragged.cause);

    const line = saveRefusalLine(input, checked);
    expect(line).toContain("Zoe B.");
    expect(line).toContain(vanName(lane.vehicle.description));
    expect(line).toContain(securement.FOUR_POINT_STRAP.toLowerCase());
    // No code in it, and nothing about a constraint or a deficit type.
    expect(line).not.toMatch(/\bV\d\b|\bC\d\b|DEFICIT|WC_|FOUR_POINT/);
  });

  it("refuses a van filled past its places, at the child the places ran out on", () => {
    /*
     * The sedan is built with three seats and two of them have anchors. Its three children all
     * ride in a car seat or a booster, so the third of them has no anchored seat to use — the
     * refusal is about *that* child and not about the two already aboard, and the cause is "this
     * van is full" rather than "this van is not built for this child", because it would have
     * taken any of the three on their own.
     */
    const day = dayOf();
    const input = planInputOf(day);
    const sedan = input.lanes.find((lane) => lane.vehicle.description.includes("sedan"));
    expect(sedan).toBeDefined();
    if (!sedan) return;
    const tokens = ["C1", "C4", "C5"];
    const overfull: Assignment = Object.fromEntries(
      input.lanes.map((lane) => [lane.id, lane.id === sedan.id ? tokens : []]),
    );
    const checked = checkPlan(input, overfull);
    expect(checked.ok).toBe(false);
    if (checked.ok || checked.reason !== "REFUSED") return;
    expect(checked.childToken).toBe("C5");
    expect(checked.cause).toBe("NO_SEAT");
    expect(saveRefusalLine(input, checked)).toContain(planRoutes.missing.NO_SEAT);
    // Each of them alone is fine, which is what makes this a fullness refusal.
    for (const token of tokens) {
      const alone = Object.fromEntries(
        input.lanes.map((lane) => [lane.id, lane.id === sedan.id ? [token] : []]),
      );
      expect(checkPlan(input, alone).ok, token).toBe(true);
    }
  });

  it("refuses a van nobody has reported on, because unknown is not a yes", () => {
    const day = dayOf();
    const stages = { ...day.stages };
    const laneId = Object.keys(stages)[0];
    stages[laneId] = { ...stages[laneId], arrival: "NOT_CHECKED" };
    const input = planInputOf({ ...day, stages });
    const forced: Assignment = Object.fromEntries(
      input.lanes.map((lane) => [lane.id, lane.id === laneId ? ["C7"] : []]),
    );
    const checked = checkPlan(input, forced);
    expect(checked.ok).toBe(false);
    if (checked.ok || checked.reason !== "REFUSED") return;
    expect(checked.cause).toBe("UNKNOWN_UNTIL_ARRIVAL");
  });

  it("checks the whole van and not one child at a time", () => {
    /*
     * Two children who each fit the substitute van alone and cannot both be in it: the refusal
     * has to come from filling the lane, which is why the check is a replay rather than a loop
     * of independent questions.
     */
    const day = dayOf("ONE_RIDER_HAS_NO_VAN");
    const input = planInputOf(day);
    const small = input.lanes.find((lane) => lane.vehicle.description.includes("substitute"));
    expect(small).toBeDefined();
    if (!small) return;
    for (const token of ["C2", "C7"]) {
      const alone: Assignment = Object.fromEntries(
        input.lanes.map((lane) => [lane.id, lane.id === small.id ? [token] : []]),
      );
      expect(checkPlan(input, alone).ok, token).toBe(true);
    }
    const both: Assignment = Object.fromEntries(
      input.lanes.map((lane) => [lane.id, lane.id === small.id ? ["C2", "C7", "C8"] : []]),
    );
    expect(checkPlan(input, both).ok).toBe(false);
  });
});

/**
 * THE ID SWAP, at the plan's own ids.
 *
 * Every id in a saved plan arrives from outside: child tokens and lane ids in the assignment,
 * and the van, driver and configuration ids in the day it describes. The rule is the one the
 * reviewer's procedure fixes — a refusal that confirms nothing — so an id from another run, from
 * another role's fleet, or from nowhere at all gets one answer, in the same words, and the
 * answer never says which of the three it was.
 */
describe("an id that is not this run's is refused, and the refusal confirms nothing", () => {
  const day = dayOf();
  const input = planInputOf(day);
  const laneIds = input.lanes.map((lane) => lane.id);
  const base = Object.fromEntries(laneIds.map((id) => [id, [] as string[]]));

  const swaps: Array<[string, Assignment]> = [
    // A child the day does not drive: the census children have no stop and are on no run.
    ["a child who is on no run today", { ...base, [laneIds[0]]: ["C12"] }],
    // A child id that matches nothing at all.
    ["a child id that matches nothing", { ...base, [laneIds[0]]: ["C999"] }],
    // The spare van, which is a real vehicle and is on no lane in this scenario.
    ["a van that is on no lane today", { ...base, V3: ["C7"] }],
    // A lane id that matches nothing.
    ["a lane id that matches nothing", { ...base, "lane-dead-beef": ["C7"] }],
    // The same child in two vans, which is not a capacity question and not a plan of this day.
    ["one child in two vans", { ...base, [laneIds[0]]: ["C7"], [laneIds[1]]: ["C7"] }],
  ];

  it.each(swaps)("%s is refused", (_what, assignment) => {
    const checked = checkPlan(input, assignment);
    expect(checked.ok).toBe(false);
    if (checked.ok) return;
    expect(checked.reason).toBe("NOT_THIS_RUN");
  });

  it("answers all of them in the same words, naming no child, van or id", () => {
    const answers = swaps.map(([, assignment]) => {
      const checked = checkPlan(input, assignment);
      return checked.ok ? "kept" : saveRefusalLine(input, checked);
    });
    expect(new Set(answers).size).toBe(1);
    const [answer] = answers;
    expect(answer).toBe(planRoutes.saveNotThisRun);
    for (const leak of ["C12", "C999", "V3", "lane-dead-beef", "Owen", "sedan"]) {
      expect(answer, leak).not.toContain(leak);
    }
  });

  it("refuses the day itself when the vans, lanes or configurations are not the day's", () => {
    const stages = asked(initialStages("EVERY_RIDER_FITS"));
    const laneId = Object.keys(stages)[0];
    const day = { scenario: "EVERY_RIDER_FITS" as const, direction: "AM" as const, measured: [] };

    // The honest one is accepted, so the refusals below are about the swap and not the shape.
    expect(readPlanDay({ ...day, stages })).not.toBeNull();

    const swapped = [
      // A vehicle that is not in the fleet at all.
      { ...stages, [laneId]: { ...stages[laneId], vehicleKey: "V99" } },
      // A configuration that van is not built with, pinned as though the ramp had seen it.
      {
        ...stages,
        [laneId]: { ...stages[laneId], arrival: "RAMP_CHECKED" as const, rampLayoutId: "L-nope" },
      },
      // A lane the scenario does not run.
      { ...stages, V3: { vehicleKey: "V3", arrival: "REPORTED" as const } },
    ];
    for (const stagesSwapped of swapped) {
      expect(readPlanDay({ ...day, stages: stagesSwapped })).toBeNull();
    }
    // And a chair measured for somebody who is not on this run.
    expect(readPlanDay({ ...day, stages, measured: ["C12"] })).toBeNull();
  });

  /**
   * Who is driving is not something a request may say.
   *
   * The name is on the screen and it changes nothing the solver decides, so it is not on the
   * wire at all: the lane the server rebuilds takes its driver from the day's own records. A
   * request that named one would be putting a person's name in a payload for nothing.
   */
  it("takes the driver from the day and not from the request", () => {
    const stages = asked(initialStages("EVERY_RIDER_FITS"));
    const read = readPlanDay({
      scenario: "EVERY_RIDER_FITS",
      direction: "AM",
      stages,
      measured: [],
    });
    expect(read).not.toBeNull();
    if (!read) return;
    for (const [laneId, stage] of Object.entries(read.stages)) {
      expect({ laneId, driver: stage.driverName }).toEqual({
        laneId,
        driver: driverFor(stage.vehicleKey),
      });
    }
    // Nothing a request carries is a person: the lane it describes is ids only.
    for (const lane of Object.values(stages)) {
      expect(Object.keys(lane).sort()).toEqual(["arrival", "vehicleKey"]);
    }
  });

  it("accepts the day a coordinator actually worked: a substitution, a report, a measurement", () => {
    const stages = asked(initialStages("EVERY_RIDER_FITS"));
    const laneId = Object.keys(stages)[0];
    const worked = {
      ...stages,
      [laneId]: { vehicleKey: "V3", arrival: "CHANGED" as const },
    };
    const read = readPlanDay({
      scenario: "EVERY_RIDER_FITS",
      direction: "AM",
      stages: worked,
      measured: ["C6"],
    });
    expect(read).not.toBeNull();
    if (!read) return;
    // Which is the question the screen would have asked: the substituted van carries nobody
    // until the provider reports, so a plan made around it is checked against *that* day.
    const substituted = planInputOf(read);
    const lane = substituted.lanes.find((l) => l.id === laneId);
    expect(lane?.capability.state).toBe("CHANGED");
    const forced: Assignment = Object.fromEntries(
      substituted.lanes.map((l) => [l.id, l.id === laneId ? ["C7"] : []]),
    );
    const checked = checkPlan(substituted, forced);
    expect(checked.ok).toBe(false);
    if (checked.ok || checked.reason !== "REFUSED") return;
    expect(checked.cause).toBe("UNKNOWN_UNTIL_ARRIVAL");
  });
});
