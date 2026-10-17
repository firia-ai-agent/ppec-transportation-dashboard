import { describe, expect, it } from "vitest";
import {
  ARRIVAL_PARAM,
  arrivalInput,
  arrivedAsPlanned,
  arrivedVerdict,
  boardArrival,
  decodeFinding,
  encodeFinding,
  observedCapability,
  rampArrivals,
  replanForArrival,
  type RampFinding,
} from "./arrival";
import { plannedAssignment, planRiders } from "./day";
import { childByKey, RUNS, VEHICLES } from "@/modules/demo/fixtures/standard";
import { routePlan } from "@/domain/solver";

/**
 * AT-04 over the demo scenario: a ramp check that finds the wrong or missing equipment, and the
 * day re-planned around it.
 *
 * Every expectation here is about the *scenario's own* children and vans — Zoe B. in the
 * convertible van, Owen C. and Ivy H. beside her, the center van with the spare seats — because
 * the whole point of this module is that the ramp iPad, the plan and the Today board are three
 * views of one day (src/modules/demo/fixtures/standard.ts).
 */
const CONVERTIBLE = "V1";
const CENTER_VAN = "V2";
const SEDAN = "V4";

function finding(over: Partial<RampFinding> = {}): RampFinding {
  return {
    laneId: CONVERTIBLE,
    layoutCode: "1WC/3A",
    outOfService: [],
    unanswered: [],
    liftOk: true,
    latchOk: true,
    measured: [],
    ...over,
  };
}

describe("the vans at the ramp are the day's own runs", () => {
  const arrivals = rampArrivals();

  it("is one tile per run, in the day's order, named as the board names them", () => {
    expect(arrivals.map((a) => a.laneId)).toEqual(RUNS.map((run) => run.vehicleKey));
    expect(arrivals.map((a) => a.vehicle.description)).toEqual([
      "convertible van",
      "center van",
      "sedan",
    ]);
  });

  it("carries the children the scenario puts on each run, by the board's own labels", () => {
    const riders = (laneId: string) =>
      arrivals.find((a) => a.laneId === laneId)?.riders.map((r) => r.child.displayName);
    // R1 is the AT-04 run (PRD §18.1 l.1327): Zoe B. with her nurse, Owen C.'s vest, Ivy H.
    expect(riders(CONVERTIBLE)).toEqual(["Ivy H.", "Owen C.", "Zoe B."]);
    expect(riders(CENTER_VAN)).toEqual(["Theo V.", "Liam D.", "Noah O."]);
    expect(riders(SEDAN)).toEqual(["Ava N.", "Eli N.", "Mia R."]);
  });

  it("opens the checklist on the configuration the manifest planned (ASM-17)", () => {
    for (const arrival of arrivals) {
      const run = RUNS.find((r) => r.vehicleKey === arrival.laneId);
      expect(arrival.plannedLayoutId).toBe(`${arrival.laneId}/${run?.layoutCode}`);
    }
  });

  it("takes the time on a tile from the plan, not from a string beside the screen", () => {
    for (const arrival of arrivals) {
      // The afternoon run leaves the centre after lunch and before the first drop-off window.
      expect(arrival.leavesAt).toMatch(/^\d{1,2}:\d{2} PM$/);
      expect(arrival.leavesMs).toBeGreaterThan(0);
    }
    // Deterministic: the committed geometry says when, so two reads agree.
    expect(rampArrivals().map((a) => a.leavesAt)).toEqual(arrivals.map((a) => a.leavesAt));
  });

  it("every rider on a tile is a child the day plans, and nobody is on two vans", () => {
    const planned = new Set(planRiders("PM").map((r) => r.child.token));
    const seen = new Set<string>();
    for (const arrival of arrivals) {
      for (const rider of arrival.riders) {
        expect(planned.has(rider.child.token)).toBe(true);
        expect(seen.has(rider.child.token)).toBe(false);
        seen.add(rider.child.token);
      }
    }
  });
});

describe("a van that arrived as planned changes nothing", () => {
  const replan = replanForArrival(arrivedAsPlanned(rampArrivals()[0]));

  it("keeps every rider where the day put them", () => {
    expect(replan.changed).toBe(false);
    expect(replan.moves).toEqual([]);
    expect(replan.holds).toEqual([]);
    expect(replan.after).toEqual(replan.before);
  });

  it("still records that somebody has now seen the van", () => {
    const arrival = boardArrival(replan);
    expect(arrival.changes.get("C6")).toEqual({ kind: "CHECKED", laneId: CONVERTIBLE });
    expect(observedCapability(replan.finding).state).toBe("VERIFIED");
    expect(observedCapability(replan.finding).observedLayoutId).toBe("V1/1WC/3A");
  });

  it("is the verdict the plan already had: the run fits", () => {
    expect(arrivedVerdict(replan)).toBe("FEASIBLE");
  });
});

describe("two walking seats out of service (PRD §18.2 step 6)", () => {
  /** The convertible van arrives as planned, with two of its three walking seats unusable. */
  const replan = replanForArrival(finding({ outOfService: [3, 4] }));

  it("is infeasible for the run as it was planned, before anyone boards (AT-04)", () => {
    expect(arrivedVerdict(replan)).toBe("INFEASIBLE");
    expect(replan.changed).toBe(true);
  });

  it("keeps the chair and her nurse in the van that fits them", () => {
    expect(replan.stays).toContain("C6");
    expect(replan.after[CONVERTIBLE]).toEqual(["C6"]);
  });

  it("moves the other two into the center van, which the scenario keeps the seats in", () => {
    expect(replan.moves.map((m) => [m.childLabel, m.toLaneId])).toEqual([
      ["Owen C.", CENTER_VAN],
      ["Ivy H.", CENTER_VAN],
    ]);
    expect(replan.holds).toEqual([]);
  });

  it("every placement it made is one the solver stands behind", () => {
    const after = routePlan(replan.input, replan.after);
    for (const lane of after.lanes) {
      if (lane.lane.id === SEDAN) continue; // the scenario's own infeasible run (AT-12)
      expect(lane.verdict.status, lane.lane.id).toBe("FEASIBLE");
    }
    expect(after.unplaced.map((u) => u.rider.child.token)).not.toContain("C7");
  });

  it("leaves the other vans' riders exactly where they were", () => {
    expect(replan.after[SEDAN]).toEqual(replan.before[SEDAN]);
    // The center van keeps its own three and gains the two it was asked to take.
    for (const token of replan.before[CENTER_VAN]) {
      expect(replan.after[CENTER_VAN]).toContain(token);
    }
  });
});

describe("the van arrives set up with no wheelchair spaces", () => {
  const replan = replanForArrival(finding({ layoutCode: "0WC/6A", liftOk: true }));

  it("holds the child whose chair no van today can hold, and says what is missing", () => {
    expect(replan.holds.map((h) => [h.childLabel, h.cause])).toEqual([
      ["Zoe B.", "NO_SECUREMENT"],
    ]);
    // The center van's place is L-track and her chair takes four-point straps: the thing to ask
    // the provider about, rather than "no wheelchair place", which is true of every sedan.
    expect(childByKey("C6").securement).toBe("FOUR_POINT_STRAP");
  });

  it("leaves the two walking riders on the van, which has six seats in that setup", () => {
    expect(replan.stays).toEqual(["C8", "C7"]);
    expect(replan.moves).toEqual([]);
  });

  it("hands the coordinator the §9 options for the child it could not place (AT-12)", () => {
    const [hold] = replan.holds;
    expect(hold.unplaced.options.length).toBeGreaterThan(0);
    for (const option of hold.unplaced.options) {
      expect(option.requiresApproval).toBe(true);
      expect(option.affectedChildTokens).toEqual(["C6"]);
    }
  });

  it("is a hold and not a quiet drop: the child is in the plan's own unplaced list", () => {
    expect(replan.plan.unplaced.map((u) => u.rider.child.token)).toContain("C6");
  });
});

describe("a chair measured larger at the ramp (AT-04's own lever)", () => {
  const replan = replanForArrival(finding({ measured: ["C6"] }));

  it("plans against the chair that arrived, not the chair on file", () => {
    const rider = replan.input.riders.find((r) => r.child.token === "C6");
    expect(rider?.child.wcLengthCm).toBe(142);
    expect(childByKey("C6").wcLengthCm).toBe(128);
  });

  it("holds her, because no van's place takes a chair that size", () => {
    expect(replan.holds.map((h) => h.childLabel)).toEqual(["Zoe B."]);
    expect(replan.holds[0].cause).toBe("CHAIR_TOO_LARGE");
  });

  it("never measures a child the ramp did not measure", () => {
    const others = replan.input.riders.filter((r) => r.child.token !== "C6");
    for (const rider of others) {
      const onFile = childByKey(rider.child.token);
      expect(rider.child.wcLengthCm).toBe(onFile.wcLengthCm);
    }
  });
});

describe("the lift will not come down", () => {
  const replan = replanForArrival(finding({ liftOk: false }));

  it("takes the chair off a van that cannot board her, and says it is the ramp", () => {
    expect(replan.stays).not.toContain("C6");
    const outcome = [...replan.moves, ...replan.holds].find((row) => row.childToken === "C6");
    expect(outcome).toBeDefined();
  });
});

describe("a place nobody could answer for is never a free one", () => {
  it("reads 'not sure' as unavailable, exactly as the solver does (PRD §7 l.797)", () => {
    const observed = observedCapability(finding({ unanswered: [2, 3] }));
    expect(observed.unknownPositionIds).toEqual(["V1/1WC/3A·A1", "V1/1WC/3A·A2"]);
    const unsure = replanForArrival(finding({ unanswered: [2, 3] }));
    const out = replanForArrival(finding({ outOfService: [2, 3] }));
    expect(unsure.moves.map((m) => m.childToken)).toEqual(out.moves.map((m) => m.childToken));
    expect(unsure.holds.map((h) => h.childToken)).toEqual(out.holds.map((h) => h.childToken));
  });
});

describe("the day under it is the day the board renders", () => {
  it("plans from the vans the runs put each child in, never from a fresh search", () => {
    const planned = plannedAssignment("PM");
    for (const run of RUNS) expect(planned[run.vehicleKey]).toEqual(run.childKeys);
    expect(replanForArrival(finding()).before).toEqual(planned);
  });

  it("leaves the unchecked vans on the provider's report, so unknown is not read as a yes", () => {
    const input = arrivalInput(finding());
    for (const lane of input.lanes) {
      expect(lane.capability.state).toBe(lane.id === CONVERTIBLE ? "VERIFIED" : "REPORTED");
    }
  });

  it("names a van by what it is, so no screen reading this has to print a code", () => {
    for (const lane of arrivalInput(finding()).lanes) {
      expect(lane.vehicle.description).not.toMatch(/^V\d/);
      expect(VEHICLES.map((v) => v.label)).toContain(
        `${lane.vehicle.label} ${lane.vehicle.description}`,
      );
    }
  });
});

describe("the board's half of a ramp check", () => {
  const replan = replanForArrival(finding({ outOfService: [3, 4] }));
  const arrival = boardArrival(replan);

  it("says what happened to each child whose ride it was about, and to nobody else", () => {
    expect(arrival.changes.get("C6")).toEqual({ kind: "CHECKED", laneId: CONVERTIBLE });
    expect(arrival.changes.get("C7")).toEqual({
      kind: "MOVED",
      fromLaneId: CONVERTIBLE,
      toLaneId: CENTER_VAN,
    });
    // Nobody on another van is in it at all: their ride did not change.
    expect(arrival.changes.has("C2")).toBe(false);
    expect(arrival.changes.has("C1")).toBe(false);
  });

  it("carries the configuration each van now holds its riders in", () => {
    expect(arrival.layoutCode).toBe("1WC/3A");
    expect(arrival.layoutCodes.get(CENTER_VAN)).toBe("1WC/4A");
  });

  it("carries each lane's verdict, so a row never has to re-solve the day", () => {
    expect(arrival.verdicts.get(CONVERTIBLE)).toBe("FEASIBLE");
    expect(arrival.verdicts.get(CENTER_VAN)).toBe("FEASIBLE");
  });

  it("is about the afternoon, which is the run a ramp check is about (PRD §9 l.865)", () => {
    expect(arrival.direction).toBe("PM");
  });
});

describe("carrying a finding between screens", () => {
  it("round-trips every field", () => {
    const original = finding({
      layoutCode: "2WC/1A",
      outOfService: [3],
      unanswered: [2],
      liftOk: false,
      latchOk: null,
      measured: ["C6"],
    });
    expect(decodeFinding(encodeFinding(original))).toEqual(original);
  });

  it("keeps the ordinary case short, which is what a demo URL is read as", () => {
    expect(encodeFinding(finding({ outOfService: [3, 4] }))).toBe("V1~1WC/3A~out=3,4");
    expect(ARRIVAL_PARAM).toBe("arrival");
  });

  it("answers null for anything this day cannot be about", () => {
    expect(decodeFinding(undefined)).toBeNull();
    expect(decodeFinding("")).toBeNull();
    // A van on no lane, a configuration this van is not built with, a place it does not have,
    // a child who is not riding it, and a field nothing reads.
    expect(decodeFinding("V9~1WC/3A")).toBeNull();
    expect(decodeFinding("V1~4WC/9A")).toBeNull();
    expect(decodeFinding("V1~1WC/3A~out=9")).toBeNull();
    expect(decodeFinding("V1~1WC/3A~out=0")).toBeNull();
    expect(decodeFinding("V1~1WC/3A~measured=C2")).toBeNull();
    expect(decodeFinding("V1~1WC/3A~colour=blue")).toBeNull();
    expect(decodeFinding("V1~1WC/3A~lift=maybe")).toBeNull();
  });

  it("never lets a parameter re-plan a van the ramp did not check", () => {
    const decoded = decodeFinding("V2~1WC/4A~out=1");
    expect(decoded?.laneId).toBe(CENTER_VAN);
    const replan = replanForArrival(decoded!);
    // Only the checked van's riders move, whichever van that is.
    for (const row of [...replan.moves, ...replan.holds]) {
      expect(row.fromLaneId).toBe(CENTER_VAN);
    }
  });
});
