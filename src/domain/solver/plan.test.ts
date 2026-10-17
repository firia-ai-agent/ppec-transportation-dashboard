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
  tryMove,
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

/**
 * `tryMove`: one move, asked and answered (Veri's finding, 2026-10-17).
 *
 * The screen used to call `canTake` and then `withMove` as two steps, and deleting the first one
 * — accepting every drag, putting a four-point chair in a van with L-track hardware — passed
 * every test in this file. The tests above are the reason why: each asks `canTake` directly, so
 * each one still passes when nothing *consults* it. These ask the mover instead, which is the
 * thing the screen calls, so a mover that stopped asking has nowhere left to hide.
 *
 * The refusal carries no assignment at all. That is the type doing the work the comment used to
 * do: a caller cannot apply a move it was not granted, because there is nothing there to apply.
 */
describe("tryMove", () => {
  const input = inputFor("AM");
  const planned: Assignment = planAssignment(input);

  /** A rider the solver placed in one lane who a second lane would also take. */
  function aMovableRider() {
    const planToday = routePlan(input, planned);
    const from = laneOf(planToday, "C3");
    const target = planToday.lanes.find(
      (lane) => lane.lane.id !== from && lane.seats.ambUsed < lane.seats.ambAvailable,
    );
    expect(target, "the planned day leaves a spare seat somewhere").toBeDefined();
    return { token: "C3", from: from as string, to: target?.lane.id as string };
  }

  it("accepts a move the solver agrees with, and hands back the new assignment", () => {
    const { token, from, to } = aMovableRider();
    const result = tryMove(input, planned, token, to);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable: the move was accepted");
    expect(result.assignment[to]).toContain(token);
    expect(result.assignment[from]).not.toContain(token);
    // Nobody else moved, and the whole roster is still placed.
    expect(Object.values(result.assignment).flat().sort()).toEqual(
      Object.values(planned).flat().sort(),
    );
    // Still a plan the four constraints agree with, which is the point of asking first.
    expectEveryRiderFits(routePlan(input, result.assignment));
    // Pure: the assignment it was given is not the assignment it returned.
    expect(planned[from]).toContain(token);
  });

  /**
   * The refusal, and the whole reason this function exists: Zoe B.'s chair is held by four-point
   * straps and the centre van's wheelchair position is L-track hardware, so the van cannot take
   * her. Remove the `canTake` call inside `tryMove` and this is the test that fails.
   */
  it("refuses a move the van cannot take, returns the reason, and moves nobody", () => {
    const result = tryMove(input, planned, "C6", "V2");

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("the centre van cannot hold a four-point chair");
    expect(result.cause).toBe("NO_SECUREMENT");
    // The refusal has no assignment in it at all, so there is nothing to apply by mistake.
    expect(result).toEqual({ ok: false, cause: "NO_SECUREMENT" });
    // And the assignment the caller holds is untouched: she is still in the van she was in.
    expect(planned.V2).not.toContain("C6");
    expect(Object.entries(planned).find(([, tokens]) => tokens.includes("C6"))?.[0]).toBe("V1");
    expect(routePlan(input, planned).unplaced).toEqual([]);
  });

  it("gives the cause for every kind of refusal, in the solver's own words", () => {
    // No wheelchair place and no lift at all, which is a different sentence from "full".
    expect(tryMove(input, planned, "C2", "V4")).toEqual({ ok: false, cause: "NO_WC_PLACE" });
    // A van nobody has checked is refused rather than guessed about.
    const unchecked = inputFor(
      "AM",
      planLanes().map((lane) =>
        lane.id === "V2" ? { ...lane, capability: notCheckedYet(lane.vehicle.id) } : lane,
      ),
    );
    expect(tryMove(unchecked, planned, "C3", "V2")).toEqual({
      ok: false,
      cause: "UNKNOWN_UNTIL_ARRIVAL",
    });
    // A lane that is not on the road today, and a child who is not on the roster: neither is a
    // move the screen can make, and neither is allowed to fall through as an accepted one.
    expect(tryMove(input, planned, "C3", "V9")).toEqual({ ok: false, cause: "NO_VEHICLE" });
    expect(tryMove(input, planned, "C99", "V4")).toEqual({ ok: false, cause: "NO_VEHICLE" });
  });

  it("always allows taking a child out of every van", () => {
    const result = tryMove(input, planned, "C6", null);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable: taking a child out is always allowed");
    expect(Object.values(result.assignment).flat()).not.toContain("C6");
    // She is in no van, for the one reason that is not a capacity fact.
    const out = routePlan(input, result.assignment);
    expect(out.unplaced.find((u) => u.rider.child.token === "C6")?.cause).toBe("NOT_IN_A_VAN");
  });
});

/**
 * A re-plan keeps a coordinator's own placements, and it asks the same question a move asks.
 *
 * A pin is a move that was made a minute earlier, so the two cannot answer differently: a van
 * that refuses Zoe B. when she is dragged into it has to refuse her when "Plan routes" is asked
 * to plan around her being in it. `planAssignment` used to push a pinned rider into their lane
 * with no check at all, which meant the one button on the screen could seat a chair in a van
 * with nothing to hold it — and a van really can change under a placement between the drag and
 * the press (a lift reported broken, a substitution, a chair measured larger at the ramp).
 *
 * Both paths call `canTake`, and these tests are over the mover and the planner rather than over
 * `canTake` itself: asking the check directly passes whether or not anybody consults it.
 */
describe("a re-plan keeps only the placements the solver still agrees to", () => {
  const input = inputFor("AM");
  const empty: Assignment = Object.fromEntries(input.lanes.map((lane) => [lane.id, []]));

  it("keeps a placement exactly when a move of the same child into the same van is allowed", () => {
    for (const rider of input.riders) {
      const token = rider.child.token;
      for (const lane of input.lanes) {
        const move = tryMove(input, empty, token, lane.id);
        const kept = (planAssignment(input, { [token]: lane.id })[lane.id] ?? []).includes(token);
        expect(kept, `${token} → ${lane.id}`).toBe(move.ok);
      }
    }
  });

  it("refuses to seat a pinned chair in a van whose securement does not hold it", () => {
    // The same refusal as `tryMove(input, planned, "C6", "V2")`: L-track hardware, four-point
    // chair. Delete the check inside `planAssignment` and this is the test that fails.
    expect(tryMove(input, empty, "C6", "V2").ok).toBe(false);
    const again = planAssignment(input, { C6: "V2" });
    expect(again.V2).not.toContain("C6");
    // Not dropped either: she is planned like anybody else, into the one van built for her.
    expect(again.V1).toContain("C6");
    expectEveryRiderFits(routePlan(input, again));
  });

  it("drops a placement the van can no longer take, and says why in the plan", () => {
    // Zoe B. was dragged into V1, which is the only van with four-point straps. Then the
    // provider sent a different van, and the one that arrived has none.
    const pinned = { C6: "V1" };
    expect(planAssignment(input, pinned).V1).toContain("C6");

    const spare = vehicleByKey("V3");
    const substitutedInput = inputFor(
      "AM",
      planLanes().map((lane) =>
        lane.id === "V1"
          ? { ...lane, vehicle: spare, capability: reportedByProvider(spare.id), driverName: "Omar T." }
          : lane,
      ),
    );
    const again = planAssignment(substitutedInput, pinned);
    expect(again.V1).not.toContain("C6");
    // She is in no van and the screen has a reason to show, rather than sitting in a van that
    // cannot hold her chair while the lane quietly reads INFEASIBLE.
    const plan = routePlan(substitutedInput, again);
    expect(plan.unplaced.map((row) => row.rider.child.token)).toEqual(["C6"]);
    expect(plan.unplaced[0].cause).toBe("NO_SECUREMENT");
    expectEveryLaneSolved(plan);
  });

  it("still lets a coordinator take somebody out of a van, which no van has to agree to", () => {
    // The one placement that is never checked, here for the same reason `tryMove` grants it
    // without asking: a van carrying one fewer rider cannot break a constraint.
    const again = planAssignment(input, { C6: null });
    expect(Object.values(again).flat()).not.toContain("C6");
    expect(tryMove(input, empty, "C6", null).ok).toBe(true);
  });

  it("never seats a pinned child the lane refuses, over every placement of the whole day", () => {
    // One pin at a time, every child into every van: whatever comes back, each lane is still a
    // lane the solver agrees with, and nobody is in a van that was asked and said no.
    for (const rider of input.riders) {
      for (const lane of input.lanes) {
        const again = planAssignment(input, { [rider.child.token]: lane.id });
        for (const planned of routePlan(input, again).lanes) {
          expect(
            ["FEASIBLE", "CAPABILITY_PENDING"],
            `${rider.child.token} → ${lane.id} leaves ${planned.lane.id}`,
          ).toContain(planned.verdict.status);
        }
      }
    }
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
