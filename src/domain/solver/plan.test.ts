/**
 * Planner tests (PRD §7 l.784-800, §9; VEH-01…05; AT-04, AT-05, AT-12).
 *
 * Over the real demo scenario, not a toy fleet: the vans, layouts, children, equipment needs and
 * stops are the ones `demo reset --scenario=standard` seeds, so a plan that passes here is a
 * plan of the day the screen shows. Pure: no DB, no clock, no network.
 */
import { describe, expect, it } from "vitest";
import {
  PLAN_SERVICE_DATE,
  asMeasured,
  notCheckedYet,
  planLanes,
  planRiders,
  reportedByProvider,
  substituted,
  unapprovedNeeds,
  vehicleByKey,
} from "@/domain/plan/day";
import { solverChild } from "@/domain/board/scenario";
import { childByKey } from "@/modules/demo/fixtures/standard";
import { places } from "@/ui/copy";
import {
  canTake,
  causeOfDeficit,
  dropOffsCovered,
  planAssignment,
  planRoutes,
  routePlan,
  withMove,
  type Assignment,
  type Direction,
  type PlanInput,
  type PlanLane,
  type PlanRider,
  type RoutePlan,
} from "./plan";

function inputFor(
  direction: Direction = "AM",
  lanes: PlanLane[] = planLanes(),
  riders: PlanRider[] = planRiders(direction),
): PlanInput {
  return { direction, centerLabel: places.center, lanes, riders };
}

function tokensIn(plan: RoutePlan, laneId: string): string[] {
  return plan.lanes.find((l) => l.lane.id === laneId)?.riders.map((r) => r.child.token) ?? [];
}

function laneOf(plan: RoutePlan, childToken: string): string | null {
  const lane = plan.lanes.find((l) => l.riders.some((r) => r.child.token === childToken));
  return lane?.lane.id ?? null;
}

/** Everything the solver had to agree with for a plan to be called good. */
function expectEveryRiderFits(plan: RoutePlan): void {
  for (const lane of plan.lanes) {
    expect(lane.verdict.status, `${lane.lane.vehicle.label}`).toBe("FEASIBLE");
    expect(lane.verdict.autoAssigned).toBe(false);
    // A seat is never over-sold: the busiest stop is inside what the van has today.
    expect(lane.seats.wcUsed).toBeLessThanOrEqual(lane.seats.wcAvailable);
    expect(lane.seats.ambUsed).toBeLessThanOrEqual(lane.seats.ambAvailable);
    expect(lane.seats.tetherUsed).toBeLessThanOrEqual(lane.seats.tetherAvailable);
  }
  expect(dropOffsCovered(plan)).toBe(true);
}

describe("the day the screen plans", () => {
  it("is the nine children the centre drives, and the three vans the scenario runs", () => {
    const riders = planRiders("AM");
    expect(riders.map((r) => r.child.token)).toEqual([
      "C1", "C2", "C3", "C4", "C5", "C6", "C7", "C8", "C9",
    ]);
    // The census children arrive with their family, so there is no pickup to plan for them.
    expect(riders.every((r) => r.stopLabel.length > 0)).toBe(true);
    expect(planLanes().map((l) => l.id)).toEqual(["V1", "V2", "V4"]);
    expect(planLanes().map((l) => l.vehicle.label)).toEqual(["V1", "V2", "V4"]);
    expect(planLanes().map((l) => l.driverName)).toEqual(["Marco D.", "Nadia P.", "Bea L."]);
    expect(planLanes().every((l) => l.capability.serviceDate === PLAN_SERVICE_DATE)).toBe(true);
  });

  it("reads the children exactly as the board does, so the two screens cannot disagree", () => {
    for (const rider of planRiders("AM")) {
      expect(rider.child).toEqual(solverChild(childByKey(rider.child.token)));
    }
  });

  it("keeps an unapproved need out of the allocation and still on the record (VEH-01)", () => {
    // The one reported-but-unapproved item in the scenario (standard.ts): it must not change
    // today's plan, and the screen still shows it.
    expect(unapprovedNeeds("C6")).toEqual(["MEDICAL_DEVICE_POWER"]);
    expect(unapprovedNeeds("C1")).toEqual([]);
  });
});

describe("a feasible plan (VEH-03)", () => {
  it("puts every child in a van that fits their equipment, both directions", () => {
    for (const direction of ["AM", "PM"] as const) {
      const input = inputFor(direction);
      const plan = planRoutes(input);
      expect(plan.unplaced, direction).toEqual([]);
      expectEveryRiderFits(plan);
      // Every rider, once, somewhere.
      const placed = plan.lanes.flatMap((l) => l.riders.map((r) => r.child.token)).sort();
      expect(placed, direction).toEqual(input.riders.map((r) => r.child.token).sort());
    }
  });

  it("is the same plan every time it is asked for", () => {
    const input = inputFor("AM");
    expect(planAssignment(input)).toEqual(planAssignment(input));
  });

  it("puts the chair that only V1's securement fits in V1, and the other chair elsewhere", () => {
    const plan = planRoutes(inputFor("AM"));
    // Zoe B.'s chair is held by four-point straps, and V1 is the only van in the scenario with
    // a position built for them.
    expect(laneOf(plan, "C6")).toBe("V1");
    // Noah O.'s L-track chair fits V2's position, and V1 is busy with the other chair.
    expect(laneOf(plan, "C2")).toBe("V2");
  });

  it("drives each lane's stops in window order, and ends at the centre in the morning", () => {
    const plan = planRoutes(inputFor("AM"));
    for (const lane of plan.lanes) {
      const windows = lane.riders.map((r) => r.window);
      expect([...windows]).toEqual([...windows].sort());
      const last = lane.leg.stops[lane.leg.stops.length - 1];
      expect(last.label).toBe(places.center);
      expect(last.alighting?.length).toBe(lane.riders.length);
    }
  });

  it("boards everyone at the centre in the afternoon, and sets each child down at their own stop", () => {
    const plan = planRoutes(inputFor("PM"));
    for (const lane of plan.lanes) {
      expect(lane.leg.stops[0].label).toBe(places.center);
      expect(lane.leg.stops[0].boarding?.length).toBe(lane.riders.length);
      for (const rider of lane.riders) {
        const stop = lane.leg.stops.find((s) => (s.alighting ?? []).includes(rider.child.token));
        expect(stop?.label, rider.child.displayName).toBe(rider.stopLabel);
      }
    }
    expect(dropOffsCovered(plan)).toBe(true);
  });

  it("never asks a van to carry a chair its securement does not hold", () => {
    const plan = planRoutes(inputFor("AM"));
    for (const lane of plan.lanes) {
      for (const rider of lane.riders.filter((r) => r.child.mobility === "WC")) {
        const stop = lane.verdict.plan.find((p) => p.onboard.includes(rider.child.token));
        const seat = stop?.wcAssignments.find((a) => a.childToken === rider.child.token);
        expect(seat, rider.child.displayName).toBeDefined();
        const position = lane.layout.positions.find((p) => p.id === seat?.positionId);
        expect(position?.kind === "WC" && position.securement).toBe(rider.child.securement);
      }
    }
  });
});

describe("unknown until arrival (VEH-04, AT-04)", () => {
  it("plans nobody into a van nobody has reported on, and says that is why", () => {
    const lanes = planLanes().map((lane) =>
      lane.id === "V2" ? { ...lane, capability: notCheckedYet(lane.vehicle.id) } : lane,
    );
    const input = inputFor("AM", lanes);
    const plan = planRoutes(input);
    const unchecked = plan.lanes.find((l) => l.lane.id === "V2");

    // Unknown is never read as a yes: the van carries nobody, and the verdict is "not known
    // yet" rather than "does not fit" — nothing about it has been ruled out (PRD §9).
    expect(tokensIn(plan, "V2")).toEqual([]);
    expect(unchecked?.verdict.status).toBe("CAPABILITY_PENDING");
    expect(unchecked?.verdict.severity).toBe("AMBER");
    expect(unchecked?.verdict.pendingReason).toMatch(/unknown until arrival/);
    // Its anchors are not counted as free either, because nobody has reported on them.
    expect(unchecked?.seats.tetherAvailable).toBe(0);

    // The two remaining vans fill up, so the children they cannot also take are told the true
    // reason — every van that fits them is full — and not a sentence about the unchecked one,
    // which would be wrong: an empty V1 would have taken any of them.
    expect(plan.unplaced.map((u) => u.cause)).toEqual(Array(4).fill("VANS_FULL"));
    expect(plan.lanes.filter((l) => l.verdict.status === "FEASIBLE")).toHaveLength(2);
  });

  it("names the unchecked van when it is the only one that fits a child", () => {
    // Noah O.'s L-track chair fits the centre van's position; the sedan has no wheelchair place
    // at all. With those two as the whole day, the answer is "not known yet", never "no van".
    const lanes = planLanes()
      .filter((lane) => lane.id !== "V1")
      .map((lane) => (lane.id === "V2" ? { ...lane, capability: notCheckedYet(lane.vehicle.id) } : lane));
    const plan = planRoutes(inputFor("AM", lanes));
    const noah = plan.unplaced.find((u) => u.rider.child.token === "C2");
    expect(noah?.cause).toBe("UNKNOWN_UNTIL_ARRIVAL");
    expect(noah?.laneId).toBe("V2");
    // And it is still a decision for a human, with the §9 options attached.
    expect(noah?.options.map((o) => o.kind)).toEqual(["FAMILY_TRANSPORT", "DELAY", "CANCEL"]);
  });

  it("a chair measured larger at the ramp makes the planned run infeasible before boarding", () => {
    const input = inputFor("AM");
    const assignment = planAssignment(input);
    const measured = inputFor(
      "AM",
      planLanes(),
      input.riders.map((rider) => (rider.child.token === "C6" ? asMeasured(rider) : rider)),
    );
    const before = routePlan(input, assignment);
    const after = routePlan(measured, assignment);

    expect(before.lanes.find((l) => l.lane.id === "V1")?.verdict.status).toBe("FEASIBLE");
    const lane = after.lanes.find((l) => l.lane.id === "V1");
    expect(lane?.verdict.status).toBe("INFEASIBLE");
    expect(lane?.verdict.deficit?.type).toBe("WC_FOOTPRINT");
    expect(lane?.verdict.severity).toBe("RED");
    // The child is still in the lane: the solver proposes, a human decides, and nobody is
    // quietly removed from a run (PRD §9).
    expect(lane?.riders.some((r) => r.child.token === "C6")).toBe(true);
    // And every way out needs a named human.
    expect(lane?.verdict.options.length).toBeGreaterThan(0);
    expect(lane?.verdict.options.every((o) => o.requiresApproval)).toBe(true);
    expect(lane?.verdict.autoAssigned).toBe(false);
  });

  it("leaves the measured chair with no van at all once the plan is re-run (AT-04 → AT-12)", () => {
    const measured = inputFor(
      "AM",
      planLanes(),
      planRiders("AM").map((rider) => (rider.child.token === "C6" ? asMeasured(rider) : rider)),
    );
    const plan = planRoutes(measured);
    const zoe = plan.unplaced.find((u) => u.rider.child.token === "C6");
    expect(zoe?.cause).toBe("CHAIR_TOO_LARGE");
    expect(zoe?.options.map((o) => o.kind)).toEqual(["FAMILY_TRANSPORT", "DELAY", "CANCEL"]);
    expect(zoe?.options.every((o) => o.requiresApproval && o.approverRole === "COORDINATOR")).toBe(true);
    // Everyone else still rides.
    expect(plan.unplaced.map((u) => u.rider.child.token)).toEqual(["C6"]);
  });
});

describe("substitution (VEH-05, AT-05)", () => {
  const spare = vehicleByKey("V3");

  it("goes unknown, then is re-requested, then re-solves", () => {
    const planned = planAssignment(inputFor("AM"));

    // 1. The provider sends a different van. Nothing is known about it yet, and the lane says so
    //    with its own sentence rather than the plain morning one.
    const changed = inputFor(
      "AM",
      planLanes().map((lane) =>
        lane.id === "V1"
          ? { ...lane, vehicle: spare, capability: substituted(spare.id), driverName: "Omar T." }
          : lane,
      ),
    );
    const pending = routePlan(changed, planned);
    const pendingLane = pending.lanes.find((l) => l.lane.id === "V1");
    expect(pendingLane?.verdict.status).toBe("CAPABILITY_PENDING");
    expect(pendingLane?.lane.vehicle.label).toBe("V3");
    expect(pendingLane?.lane.driverName).toBe("Omar T.");
    expect(pendingLane?.verdict.pendingReason).toMatch(/A different vehicle is coming/);

    // 2. The provider answers, and the same lane is solved again — with the substitute's own
    //    hardware, which does not hold the chair that was planned into it.
    const answered = inputFor(
      "AM",
      changed.lanes.map((lane) =>
        lane.id === "V1" ? { ...lane, capability: reportedByProvider(spare.id) } : lane,
      ),
    );
    const resolved = routePlan(answered, planned);
    const lane = resolved.lanes.find((l) => l.lane.id === "V1");
    expect(lane?.verdict.status).toBe("INFEASIBLE");
    expect(causeOfDeficit(lane?.verdict.deficit?.type ?? "WC_POSITION")).toBe("NO_SECUREMENT");
  });

  it("tells the family nothing and leaves the child who no longer fits with a reason (AT-12)", () => {
    const substitutedLanes = planLanes().map((lane) =>
      lane.id === "V1"
        ? { ...lane, vehicle: spare, capability: reportedByProvider(spare.id), driverName: "Omar T." }
        : lane,
    );
    const plan = planRoutes(inputFor("AM", substitutedLanes));
    const zoe = plan.unplaced.find((u) => u.rider.child.token === "C6");
    expect(zoe?.cause).toBe("NO_SECUREMENT");
    expect(zoe?.laneId).toBeNull();
    // PRD §9's option set, minus the two this screen has nothing to name: nobody is auto-moved,
    // nothing is sent, and each option waits for a coordinator.
    expect(zoe?.options.map((o) => o.kind)).toEqual(["FAMILY_TRANSPORT", "DELAY", "CANCEL"]);
    expect(zoe?.options.every((o) => o.requiresApproval)).toBe(true);
    expect(zoe?.options.flatMap((o) => o.affectedChildTokens)).toEqual(["C6", "C6", "C6"]);
    // Everyone whose needs the remaining vans do cover still has a van.
    expect(plan.unplaced.map((u) => u.rider.child.token)).toEqual(["C6"]);
    expectEveryLaneSolved(plan);
  });

  it("a different driver changes nothing about what the van can carry", () => {
    const input = inputFor("AM");
    const samePlan = planAssignment(input);
    const relieved = inputFor(
      "AM",
      planLanes().map((lane) => (lane.id === "V1" ? { ...lane, driverName: "Gus M." } : lane)),
    );
    expect(planAssignment(relieved)).toEqual(samePlan);
    expect(routePlan(relieved, samePlan).lanes.find((l) => l.lane.id === "V1")?.verdict.status).toBe(
      "FEASIBLE",
    );
  });
});

function expectEveryLaneSolved(plan: RoutePlan): void {
  for (const lane of plan.lanes) {
    expect(["FEASIBLE", "CAPABILITY_PENDING"], lane.lane.vehicle.label).toContain(
      lane.verdict.status,
    );
  }
}

describe("moving a child between vans", () => {
  const input = inputFor("AM");
  const planned: Assignment = planAssignment(input);

  it("accepts a move the solver agrees with, and the plan still fits", () => {
    const planToday = routePlan(input, planned);
    const from = laneOf(planToday, "C3");
    // Liam D. walks and needs no anchor, so any lane with a spare seat can take him.
    const target = planToday.lanes.find(
      (lane) => lane.lane.id !== from && lane.seats.ambUsed < lane.seats.ambAvailable,
    );
    expect(target, "the planned day leaves a spare seat somewhere").toBeDefined();
    const laneId = target?.lane.id as string;
    expect(canTake(input, planned, laneId, "C3")).toEqual({ ok: true });
    const moved = routePlan(input, withMove(planned, "C3", laneId));
    expect(tokensIn(moved, laneId)).toContain("C3");
    expectEveryRiderFits(moved);
  });

  it("refuses a chair the target van's securement does not hold, and names the cause", () => {
    // Zoe B.'s four-point chair against the centre van, whose position is L-track.
    expect(canTake(input, planned, "V2", "C6")).toEqual({ ok: false, cause: "NO_SECUREMENT" });
    // Noah O.'s chair against the sedan, which has no wheelchair place and no lift at all.
    expect(canTake(input, planned, "V4", "C2")).toEqual({ ok: false, cause: "NO_WC_PLACE" });
  });

  it("separates a van that is full from a van that was never built for the child", () => {
    // One sedan, three seats, four walking riders: the fourth is left out because the van is
    // full, which is a different sentence from "this van cannot carry you".
    const sedanOnly = inputFor(
      "AM",
      planLanes().filter((lane) => lane.id === "V4"),
      planRiders("AM").filter((rider) => ["C1", "C3", "C8", "C9"].includes(rider.child.token)),
    );
    const plan = planRoutes(sedanOnly);
    expect(plan.lanes[0].riders).toHaveLength(3);
    expect(plan.unplaced).toHaveLength(1);
    expect(plan.unplaced[0].cause).toBe("VANS_FULL");
    expect(plan.unplaced[0].laneId).toBe("V4");
    // And the same question asked directly is "no free seat", not "no van for you".
    const left = plan.unplaced[0].rider.child.token;
    expect(canTake(sedanOnly, planAssignment(sedanOnly), "V4", left)).toEqual({
      ok: false,
      cause: "NO_SEAT",
    });
  });

  it("refuses a move into a van nobody has checked, rather than guessing", () => {
    const lanes = planLanes().map((lane) =>
      lane.id === "V2" ? { ...lane, capability: notCheckedYet(lane.vehicle.id) } : lane,
    );
    const unchecked = inputFor("AM", lanes);
    expect(canTake(unchecked, planned, "V2", "C3")).toEqual({
      ok: false,
      cause: "UNKNOWN_UNTIL_ARRIVAL",
    });
  });

  it("takes a child out of every van, and says they are in none", () => {
    const out = routePlan(input, withMove(planned, "C9", null));
    expect(out.lanes.every((lane) => !lane.riders.some((r) => r.child.token === "C9"))).toBe(true);
    const row = out.unplaced.find((u) => u.rider.child.token === "C9");
    // Somewhere would still take them, so the reason is that nobody has — not a capacity fact
    // dressed up as one — and there is nothing for a coordinator to approve.
    expect(row?.cause).toBe("NOT_IN_A_VAN");
    expect(row?.options).toEqual([]);
  });

  it("changes nothing when a move is refused", () => {
    const before = routePlan(input, planned);
    const check = canTake(input, planned, "V2", "C6");
    expect(check.ok).toBe(false);
    // The caller keeps the old assignment on a refusal, which is what the screen does.
    expect(routePlan(input, planned)).toEqual(before);
  });
});

describe("no van at all", () => {
  it("says so plainly rather than inventing one", () => {
    const plan = planRoutes(inputFor("AM", []));
    expect(plan.lanes).toEqual([]);
    expect(plan.unplaced).toHaveLength(9);
    expect(new Set(plan.unplaced.map((u) => u.cause))).toEqual(new Set(["NO_VEHICLE"]));
  });

  it("offers the family, delay and cancel options, each needing a coordinator", () => {
    const plan = planRoutes(inputFor("AM", []));
    for (const row of plan.unplaced) {
      expect(row.options.map((o) => o.kind)).toEqual(["FAMILY_TRANSPORT", "DELAY", "CANCEL"]);
      expect(row.options.every((o) => o.requiresApproval)).toBe(true);
    }
  });
});

describe("before anything is planned", () => {
  it("has every child in the group at the top, and no plan anybody has to defend", () => {
    const input = inputFor("AM");
    const plan = routePlan(input, {});
    expect(plan.lanes.every((lane) => lane.riders.length === 0)).toBe(true);
    expect(plan.unplaced.map((u) => u.cause)).toEqual(Array(9).fill("NOT_IN_A_VAN"));
    // An empty lane is not called feasible on the strength of carrying nobody: it says what the
    // day knows about the van, which the screen reads off the capability state.
    expect(plan.lanes.every((lane) => lane.seats.wcUsed === 0 && lane.seats.ambUsed === 0)).toBe(true);
  });
});
