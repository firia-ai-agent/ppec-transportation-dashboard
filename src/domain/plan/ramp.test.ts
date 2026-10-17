import { describe, expect, it } from "vitest";
import { buildBoard } from "@/domain/board/board";
import { demoDay } from "@/domain/board/day";
import { RUNS } from "@/modules/demo/fixtures/standard";
import {
  RAMP_DIRECTION,
  decodeRampFinding,
  encodeRampFinding,
  rampArrivals,
  rampObservation,
  rampReplan,
  rampRides,
  scenarioAssignment,
  type RampFinding,
} from "./ramp";
import { planRiders } from "./day";

/**
 * What a ramp check does to the day (PRD §9 l.876, AT-04).
 *
 * The findings below are the two a front desk can walk to on the iPad in half a minute, and
 * they are the two halves of the PRD's sentence: a van that arrived set up the wrong way round,
 * where the children it can no longer carry have another van to ride; and a van whose
 * wheelchair place is out of service, where one of them has nowhere to go and waits.
 */

/** The convertible van arrived set up for two wheelchairs instead of one and three seats. */
const SET_UP_FOR_TWO_CHAIRS: RampFinding = {
  laneId: "V1",
  vehicleKey: "V1",
  layoutCode: "2WC/1A",
  liftOk: true,
  latchOk: true,
  outOfService: [],
};

/** The centre's own van arrived with its wheelchair place out of service. */
const WHEELCHAIR_PLACE_OUT: RampFinding = {
  laneId: "V2",
  vehicleKey: "V2",
  layoutCode: "1WC/4A",
  liftOk: true,
  latchOk: true,
  outOfService: [1],
};

/** The van arrived exactly as the manifest planned it: a check with nothing to report. */
const AS_PLANNED: RampFinding = {
  laneId: "V1",
  vehicleKey: "V1",
  layoutCode: "1WC/3A",
  liftOk: true,
  latchOk: true,
  outOfService: [],
};

const named = (names: readonly { rider: { child: { displayName: string } } }[]): string[] =>
  names.map((n) => n.rider.child.displayName);

describe("the observation a finished check records", () => {
  it("is a verified one, and pins the configuration the van arrived in (ASM-17)", () => {
    const observation = rampObservation(SET_UP_FOR_TWO_CHAIRS);
    expect(observation.state).toBe("VERIFIED");
    expect(observation.observedLayoutId).toBe("V1/2WC/1A");
    expect(observation.vehicleId).toBe("V1");
  });

  it("names the places that are out of service, and leaves nothing unknown", () => {
    const observation = rampObservation(WHEELCHAIR_PLACE_OUT);
    // The first place in the centre van's configuration is its wheelchair place.
    expect(observation.unavailablePositionIds).toEqual(["V2/1WC/4A·W1"]);
    // A finished check has answered every row, so "not sure" cannot reach the solver from here.
    expect(observation.unknownPositionIds).toEqual([]);
  });
});

describe("a van that arrived set up the wrong way round", () => {
  const replan = rampReplan(SET_UP_FOR_TWO_CHAIRS);

  it("fitted before the ramp looked at it, which is what makes this a change", () => {
    const before = replan.before.lanes.find((lane) => lane.lane.id === "V1");
    expect(before?.verdict.status).toBe("FEASIBLE");
    expect(before?.riders.map((r) => r.child.displayName).sort()).toEqual([
      "Ivy H.",
      "Owen C.",
      "Zoe B.",
    ]);
  });

  it("moves the children it can no longer carry into a van that fits them", () => {
    expect(replan.moves.map((m) => m.rider.child.displayName)).toEqual(["Owen C.", "Ivy H."]);
    expect(replan.moves.every((m) => m.fromLaneId === "V1" && m.toLaneId === "V2")).toBe(true);
    expect(replan.held).toEqual([]);
  });

  it("leaves the rider the van can still carry exactly where they were", () => {
    const after = replan.after.lanes.find((lane) => lane.lane.id === "V1");
    expect(after?.riders.map((r) => r.child.displayName)).toEqual(["Zoe B."]);
  });

  it("re-plans into a van the solver agrees with, never just a van with a gap in it", () => {
    // The receiving lane is solved with the moved children aboard, so this is the solver's
    // verdict over the new load and not an arithmetic guess about seats.
    const receiving = replan.after.lanes.find((lane) => lane.lane.id === "V2");
    expect(receiving?.verdict.status).toBe("FEASIBLE");
    expect(receiving?.riders.map((r) => r.child.displayName).sort()).toEqual([
      "Ivy H.",
      "Liam D.",
      "Noah O.",
      "Owen C.",
      "Theo V.",
    ]);
    // Nobody is in two vans at once, and nobody has been dropped off the day.
    const placed = Object.values(replan.assignment).flat();
    expect(new Set(placed).size).toBe(placed.length);
    expect(placed.length + replan.after.unplaced.length).toBe(planRiders(RAMP_DIRECTION).length);
  });
});

describe("a van whose wheelchair place is out of service", () => {
  const replan = rampReplan(WHEELCHAIR_PLACE_OUT);

  it("leaves the wheelchair rider waiting, because no other van has a place for them", () => {
    expect(replan.moves).toEqual([]);
    expect(named(replan.held)).toEqual(["Noah O."]);
  });

  it("says it is a capacity fact, which is the one the PRD holds a leg state for", () => {
    // VANS_FULL / NO_SEAT are the two causes src/app/plan-preview/lanes.ts shows as
    // LEFT_BEHIND_CAPACITY — "Waiting: vehicle full" (PRD l.750, l.876). Any other cause here
    // would mean the screens label this child with the wrong kind of "no van".
    expect(replan.held[0].cause).toBe("VANS_FULL");
  });

  it("gives that child the §9 options, each one needing a coordinator (AT-12)", () => {
    const options = replan.held[0].options;
    expect(options.length).toBeGreaterThan(0);
    expect(options.every((option) => option.requiresApproval)).toBe(true);
    expect(options.every((option) => option.approverRole === "COORDINATOR")).toBe(true);
  });

  it("leaves the rest of that van's riders on it", () => {
    const after = replan.after.lanes.find((lane) => lane.lane.id === "V2");
    expect(after?.riders.map((r) => r.child.displayName).sort()).toEqual(["Liam D.", "Theo V."]);
  });
});

describe("a check with nothing to report", () => {
  const replan = rampReplan(AS_PLANNED);

  it("changes nothing, so no screen shows a change", () => {
    expect(replan.moves).toEqual([]);
    expect(replan.held).toEqual([]);
    expect(rampRides(replan).size).toBe(0);
  });

  it("still plans the day it was asked about", () => {
    expect(replan.after.lanes.map((lane) => lane.riders.length)).toEqual(
      replan.before.lanes.map((lane) => lane.riders.length),
    );
  });
});

describe("what the other screens read", () => {
  it("names only the children the check actually changed", () => {
    const rides = rampRides(rampReplan(SET_UP_FOR_TWO_CHAIRS));
    expect([...rides.keys()].sort()).toEqual(["C7", "C8"]);
    expect(rides.get("C7")).toEqual({ kind: "MOVED", fromLaneId: "V1", toLaneId: "V2" });
  });

  it("marks a child with no van as held, on the lane the check was about", () => {
    const rides = rampRides(rampReplan(WHEELCHAIR_PLACE_OUT));
    expect(rides.get("C2")).toEqual({ kind: "HELD", laneId: "V2", cause: "VANS_FULL" });
  });
});

describe("the finding a link carries", () => {
  it("survives the round trip", () => {
    for (const finding of [SET_UP_FOR_TWO_CHAIRS, WHEELCHAIR_PLACE_OUT, AS_PLANNED]) {
      expect(decodeRampFinding(encodeRampFinding(finding))).toEqual(finding);
    }
  });

  it("is short and readable, and names no child", () => {
    expect(encodeRampFinding(WHEELCHAIR_PLACE_OUT)).toBe("V2~1WC/4A~y~y~1");
    const encoded = encodeRampFinding(SET_UP_FOR_TWO_CHAIRS);
    for (const rider of planRiders(RAMP_DIRECTION)) {
      expect(encoded).not.toContain(rider.child.displayName);
      expect(encoded).not.toContain(rider.child.token);
    }
  });

  it("fails closed on anything it cannot read, so a bad link shows the day as planned", () => {
    for (const value of [
      null,
      undefined,
      "",
      "V1",
      "V9~1WC/3A~y~y~",
      "V1~9WC/9A~y~y~",
      "V1~1WC/3A~maybe~y~",
      "V1~1WC/3A~y~y~9",
      "V1~1WC/3A~y~y~0",
      "V1~1WC/3A~y~y~two",
    ]) {
      expect(decodeRampFinding(value), `${value}`).toBeNull();
    }
  });
});

describe("the iPad and the board are looking at one day", () => {
  const arrivals = rampArrivals();

  it("shows the day's own vans, in the day's own order", () => {
    expect(arrivals.map((a) => a.laneId)).toEqual(RUNS.map((run) => run.vehicleKey));
    expect(arrivals.map((a) => a.vehicle.label)).toEqual(["V1", "V2", "V4"]);
  });

  it("names the same children, on the same vans, as the Today board", () => {
    const board = buildBoard(demoDay());
    const onTheBoard = new Map<string, string>();
    for (const leg of board.legs) {
      if (leg.ride.direction !== RAMP_DIRECTION || leg.ride.vehicleLabel === null) continue;
      onTheBoard.set(leg.child.childLabel, leg.ride.vehicleLabel);
    }
    const onTheIpad = new Map<string, string>();
    for (const arrival of arrivals) {
      for (const rider of arrival.riders) {
        onTheIpad.set(rider.child.displayName, arrival.vehicle.label);
      }
    }
    expect(onTheIpad.size).toBeGreaterThan(0);
    expect([...onTheIpad.entries()].sort()).toEqual([...onTheBoard.entries()].sort());
  });

  it("opens each checklist on the configuration that run planned", () => {
    for (const arrival of arrivals) {
      const run = RUNS.find((r) => r.vehicleKey === arrival.laneId);
      expect(arrival.plannedLayoutId).toBe(`${arrival.vehicle.id}/${run?.layoutCode}`);
    }
  });

  it("starts the re-plan from the runs the board is running, not from a fresh search", () => {
    const assignment = scenarioAssignment(planRiders(RAMP_DIRECTION));
    for (const run of RUNS) {
      expect(assignment[run.vehicleKey]).toEqual(run.childKeys);
    }
  });
});
