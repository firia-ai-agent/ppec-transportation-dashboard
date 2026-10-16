import { describe, expect, it } from "vitest";
import { canTransition, LEG } from "@/domain/machines";
import { legState } from "@/db/schema";
import { BOARD_CENSUS, CHILDREN, RUNS } from "@/modules/demo/fixtures/standard";
import { board as boardCopy } from "@/ui/copy";
import { legStates } from "@/ui/states";
import {
  BOARD_GROUPS,
  NEXT_STEPS,
  boardInstantMs,
  buildBoard,
  groupForState,
  matchesQuery,
  rideStateFrom,
  type BoardRow,
  type LegRow,
  type RideView,
} from "./board";
import {
  dispatcherOf,
  manifestFor,
  receivingAdultOf,
  solverChild,
  solverVehicle,
  vehicleOf,
} from "./scenario";

/**
 * The board, as a projection (PRD §14 SURF-01).
 *
 * Two things are being checked here and they are different questions. The first is that the
 * board never says anything the domain would not: a ride's state is reached by walking the leg
 * machine, and a walk that the machine refuses is a bug in this projection, not a state to be
 * rendered. The second is that the day it shows is the synthetic day the demo seeds — the same
 * 28 children, the same three runs — rather than a set of rows written to look convincing.
 */

const board = buildBoard();
const rowOf = (key: string): BoardRow => {
  const row = board.rows.find((r) => r.childKey === key);
  if (!row) throw new Error(`no row for ${key}`);
  return row;
};
/** One row of the board: one child's one ride. */
const legOf = (key: string, direction: "AM" | "PM"): LegRow => {
  const leg = board.legs.find(
    (l) => l.child.childKey === key && l.ride.direction === direction,
  );
  if (!leg) throw new Error(`no ${direction} row for ${key}`);
  return leg;
};
const am = (row: BoardRow): RideView => row.rides.find((r) => r.direction === "AM")!;
const pm = (row: BoardRow): RideView => row.rides.find((r) => r.direction === "PM")!;

describe("the board is the seeded day, one row per child and ride", () => {
  it("has the census the scenario builds, in fixture order", () => {
    expect(board.rows).toHaveLength(BOARD_CENSUS);
    expect(board.rows.map((r) => r.childKey)).toEqual(CHILDREN.map((c) => c.key));
  });

  it("is one row per child and ride: two rows a child, morning before afternoon", () => {
    expect(board.legs).toHaveLength(BOARD_CENSUS * 2);
    expect(board.legs.map((l) => l.key)).toEqual(
      CHILDREN.flatMap((c) => [`${c.key}/AM`, `${c.key}/PM`]),
    );
    // Every row points at the child's own day, so the row and the drawer cannot disagree.
    for (const leg of board.legs) {
      expect(leg.child.rides, leg.key).toContain(leg.ride);
    }
  });

  it("gives every row a step the copy module has words for", () => {
    for (const leg of board.legs) expect(NEXT_STEPS, leg.key).toContain(leg.nextStep);
  });

  it("labels a child by first name and last initial, and never with a surname (D-3)", () => {
    for (const row of board.rows) {
      expect(row.childLabel, row.childKey).toMatch(/^[A-Z][a-z]+ [A-Z]\.$/);
    }
  });

  it("is deterministic: the same instant builds the same board", () => {
    expect(buildBoard(boardInstantMs())).toEqual(buildBoard(boardInstantMs()));
  });

  it("every row carries where its data came from (NFR-09)", () => {
    for (const row of board.rows) expect(row.sourceMode).toBe("SIMULATED");
  });
});

describe("every ride state is a legal walk of the leg machine", () => {
  it("each step of each path is an edge the machine allows", () => {
    for (const row of board.rows) {
      for (const ride of row.rides) {
        expect(ride.path[0], `${row.childKey} ${ride.direction}`).toBe("SCHEDULED");
        expect(ride.path.at(-1)).toBe(ride.state);
        for (let i = 1; i < ride.path.length; i += 1) {
          const from = ride.path[i - 1];
          const to = ride.path[i];
          const legal = LEG.edges.some((e) => (e.from === from || e.from === "*") && e.to === to);
          expect(legal, `${row.childKey} ${ride.direction}: ${from} → ${to}`).toBe(true);
        }
      }
    }
  });

  it("refuses to build a state the machine has no edge to", () => {
    // A verified vehicle whose solve is not feasible may not lock a manifest, so the walk stops
    // at CAPABILITY_VERIFIED rather than skipping to a van on the road.
    const { state } = rideStateFrom({
      assigned: true,
      capability: "VERIFIED",
      solver: "INFEASIBLE",
      departed: true,
      pickupArrived: true,
      dropoffArrived: true,
    });
    expect(state).toBe("CAPABILITY_VERIFIED");
  });

  it("a child the family brings stays scheduled: there is no ride to advance", () => {
    const { state, path } = rideStateFrom({
      assigned: false,
      capability: "UNKNOWN",
      solver: null,
      departed: false,
      pickupArrived: false,
      dropoffArrived: false,
    });
    expect(state).toBe("SCHEDULED");
    expect(path).toEqual(["SCHEDULED"]);
  });

  it("every leg state the §3 vocabulary knows has a group", () => {
    for (const state of legState.enumValues) {
      expect(BOARD_GROUPS).toContain(groupForState(state));
    }
  });
});

/**
 * AT-10, the UI half: a vehicle reaching a place is not a child changing hands. The replay can
 * see an arrival and nothing more, so the board may show an arrival and nothing more — the
 * handoff needs a custody event naming the adult who received the child (PRD SURF-01
 * acceptance, §6.3 ARRIVED_DROPOFF → COMPLETED_HANDOFF by a person).
 */
describe("a geofence arrival is never a handoff (AT-10)", () => {
  it("no row reaches 'handed off' from the day's observations", () => {
    for (const row of board.rows) {
      for (const ride of row.rides) expect(ride.state).not.toBe("COMPLETED_HANDOFF");
    }
  });

  it("the walk cannot be pushed past the vehicle's arrival, however much it has seen", () => {
    const { state } = rideStateFrom({
      assigned: true,
      capability: "VERIFIED",
      solver: "FEASIBLE",
      departed: true,
      pickupArrived: true,
      dropoffArrived: true,
    });
    expect(state).toBe("ARRIVED_PICKUP");
    // And the machine agrees it is not one step from done, whoever asks.
    expect(canTransition(LEG, "ARRIVED_DROPOFF", "COMPLETED_HANDOFF", "Y")).toBe(false);
    expect(canTransition(LEG, "ARRIVED_DROPOFF", "COMPLETED_HANDOFF", "S")).toBe(true);
  });

  it("the label for a vehicle at the drop-off says so, and never 'Handed off'", () => {
    expect(legStates.ARRIVED_DROPOFF.label).toBe("Arrived (vehicle)");
    expect(legStates.ARRIVED_DROPOFF.label).not.toMatch(/handed off/i);
  });
});

/**
 * AT-13, the UI half: the scenario has one family with no adult on file who may receive their
 * child (standard.ts: every scope except RECEIVE_CHILD). Staff have to see that in the morning,
 * not at the kerb in the afternoon.
 */
describe("a child with no adult on file to receive them (AT-13)", () => {
  const noReceiver = CHILDREN.filter((c) => !c.scopes.includes("RECEIVE_CHILD"));

  it("the scenario really does contain one, so this suite is about something", () => {
    expect(noReceiver.map((c) => c.key)).toEqual(["C2"]);
  });

  it("has the afternoon ride under needs action, with the reason and the step named", () => {
    const leg = legOf("C2", "PM");
    expect(leg.group).toBe("NEEDS_ACTION");
    expect(leg.needsActionReasons).toContain("NO_RECEIVING_ADULT");
    expect(leg.nextStep).toBe("RECORD_RECEIVER");
    // There is no adult to name, which is the whole of the problem.
    expect(leg.child.receivingAdult).toBeNull();
  });

  it("is still visible in the morning: the fact is on the child, not on one ride", () => {
    // The step belongs to the ride it stops — the afternoon — but the morning row carries the
    // same child, and the board's receiver column reads it from there (AT-13 is seen at 07:00).
    expect(legOf("C2", "AM").child.receivingAdult).toBeNull();
    expect(legOf("C2", "AM").needsActionReasons).not.toContain("NO_RECEIVING_ADULT");
  });

  it("and every other riding child has a named adult, never a role", () => {
    for (const row of board.rows) {
      if (row.childKey === "C2") {
        expect(row.receivingAdult).toBeNull();
        continue;
      }
      expect(row.receivingAdult?.name, row.childKey).toMatch(/^[A-Z][a-z]+ [A-Z]\.$/);
      expect(row.receivingAdult?.relationship, row.childKey).toMatch(/^(parent|grandparent)$/);
    }
    for (const leg of board.legs) {
      if (leg.key === "C2/PM") continue;
      expect(leg.needsActionReasons, leg.key).not.toContain("NO_RECEIVING_ADULT");
    }
  });

  it("names the adult from the family's own guardian, with no surname anywhere (D-3)", () => {
    expect(receivingAdultOf(CHILDREN.find((c) => c.key === "C1")!)).toEqual({
      name: "Alma R.",
      relationship: "parent",
    });
    expect(receivingAdultOf(CHILDREN.find((c) => c.key === "C9")!)).toEqual({
      name: "Lena V.",
      relationship: "grandparent",
    });
  });
});

/**
 * COPY-GUIDE §1 "name the person": a van's capability is somebody's answer, and the board knows
 * whose. The centre's own fleet has nobody on file, which is a gap to say out loud rather than
 * a person to invent.
 */
describe("the person who answers for a van is named", () => {
  it("names the provider's dispatcher, first name and last initial", () => {
    expect(dispatcherOf(vehicleOf(RUNS.find((r) => r.key === "R1")!))).toBe("Hal B.");
    expect(dispatcherOf(vehicleOf(RUNS.find((r) => r.key === "R3")!))).toBe("Rae S.");
  });

  it("has nobody to name for the centre's own fleet, and says so with null", () => {
    expect(dispatcherOf(vehicleOf(RUNS.find((r) => r.key === "R2")!))).toBeNull();
  });

  it("so the step on an unreported van is the one with somebody in it to ask", () => {
    // C1's van is the unbound device: nothing has been reported about it all morning, so the
    // step is to ask the dispatcher who can answer.
    expect(legOf("C1", "AM").nextStep).toBe("ASK_ABOUT_VAN");
    expect(legOf("C1", "AM").ride.providerDispatcher).toBe("Rae S.");
    // C3 rides the centre's own van: same unanswered question in the afternoon, and the step
    // that sends it to the ramp, because there is no dispatcher on file to ring about it.
    expect(legOf("C3", "PM").nextStep).toBe("CHECK_VAN_AT_RAMP");
    expect(legOf("C3", "PM").ride.providerDispatcher).toBeNull();
  });
});

/** AT-07: the two rides of a day are independent, so the board carries both, separately. */
describe("the morning ride and the afternoon ride are separate things (AT-07)", () => {
  it("every row has exactly one of each, in order", () => {
    for (const row of board.rows) {
      expect(row.rides.map((r) => r.direction)).toEqual(["AM", "PM"]);
    }
  });

  it("they can be in different states on the same child", () => {
    const row = rowOf("C6");
    expect(am(row).state).not.toBe(pm(row).state);
  });

  it("each one carries its own planned window from the plan", () => {
    const row = rowOf("C1");
    expect(am(row).plannedWindow).toBe("07:10");
    expect(pm(row).plannedWindow).toBe("15:55");
  });
});

describe("the capacity solver answers for the van, and the board shows its answer", () => {
  it("a van nobody has reported on today cannot be solved, and says so (PRD §9)", () => {
    const row = rowOf("C1");
    expect(am(row).capability).toBe("UNKNOWN");
    expect(am(row).solver).toBe("CAPABILITY_PENDING");
    expect(am(row).solverPendingReason).not.toBeNull();
    expect(am(row).state).toBe("CAPABILITY_PENDING");
  });

  it("a van that is driving its run has been checked, and its riders fit", () => {
    for (const key of ["C6", "C7", "C8"]) {
      const ride = am(rowOf(key));
      expect(ride.capability, key).toBe("VERIFIED");
      expect(ride.solver, key).toBe("FEASIBLE");
    }
  });

  it("every run's manifest names each of its riders exactly once, in each direction", () => {
    for (const run of RUNS) {
      for (const direction of ["AM", "PM"] as const) {
        const stops = manifestFor(run, direction);
        const boarding = stops.flatMap((s) => s.boarding ?? []);
        const alighting = stops.flatMap((s) => s.alighting ?? []);
        expect(boarding.slice().sort()).toEqual(run.childKeys.slice().sort());
        expect(alighting.slice().sort()).toEqual(run.childKeys.slice().sort());
      }
    }
  });

  it("the vehicles it builds keep the fixture's layouts and lift", () => {
    for (const run of RUNS) {
      const fixture = vehicleOf(run);
      const vehicle = solverVehicle(fixture);
      expect(vehicle.layouts.map((l) => l.code)).toEqual(fixture.layouts.map((l) => l.code));
      expect(vehicle.liftEquipped).toBe(fixture.liftEquipped);
      // "V1 convertible van" is a label and then what it is; the tile shows the label alone.
      expect(vehicle.label).toBe(fixture.key);
    }
  });

  it("a rider who needs an anchored seat is passed to the solver as one (PRD §7 constraint 3)", () => {
    // C1 rides in a car seat and C7 in a vest; both need a tether/LATCH-capable seat.
    expect(solverChild(CHILDREN.find((c) => c.key === "C1")!).tether).toBe(true);
    expect(solverChild(CHILDREN.find((c) => c.key === "C7")!).tether).toBe(true);
    // C6's nurse rides along and takes a seat of their own.
    expect(solverChild(CHILDREN.find((c) => c.key === "C6")!).escort).toBe(true);
  });
});

describe("the arrival window and the van's location come from the replayed run", () => {
  it("a van with no displayable position has no window and no age (LOC-01)", () => {
    const ride = am(rowOf("C1"));
    expect(ride.windowText).toBeNull();
    expect(ride.gpsAgeSeconds).toBeNull();
    expect(ride.gpsFreshness).toBeNull();
  });

  it("a van on the road carries the window its families hold, and how far it has moved", () => {
    const ride = am(rowOf("C6"));
    expect(ride.windowText).toMatch(/^\d{1,2}:\d{2}–\d{1,2}:\d{2} [AP]M$/);
    expect(ride.deltaSeconds).toBeGreaterThan(0);
    // PRD §18.2 step 7: this run is standing in its injected stall.
    expect(ride.stoppedSeconds).toBeGreaterThanOrEqual(600);
  });

  it("a van whose position has gone stale pauses its texts and keeps its window (LOC-03)", () => {
    const ride = am(rowOf("C3"));
    expect(ride.gpsFreshness).toBe("STALE");
    expect(ride.etaPaused).toBe(true);
    // Never hide data (§4.1): the window the family holds is still on the row.
    expect(ride.windowText).not.toBeNull();
  });

  it("an afternoon ride has no committed geometry, and says the window is pending", () => {
    for (const row of board.rows) {
      expect(pm(row).windowText, row.childKey).toBeNull();
    }
  });
});

describe("grouping and counts", () => {
  it("every row is in exactly one group, and the groups add up to the board", () => {
    const grouped = board.groups.flatMap((g) => g.legs);
    expect(grouped).toHaveLength(board.legs.length);
    expect(new Set(grouped.map((l) => l.key)).size).toBe(board.legs.length);
  });

  it("needs action is the first group on the board (§4.1)", () => {
    expect(board.groups[0].group).toBe("NEEDS_ACTION");
    expect(board.needsActionCount).toBe(board.groups[0].legs.length);
  });

  it("the group names are the ones the copy guide fixes", () => {
    expect(boardCopy.groups.NEEDS_ACTION).toBe("Needs action");
    expect(boardCopy.groups.ON_THE_WAY).toBe("On the way");
    expect(boardCopy.groups.DONE).toBe("Done");
    expect(boardCopy.groups.NOT_RIDING).toBe("Not riding today");
  });

  /**
   * The reason the board is one row per ride: a child whose morning van is on the road and
   * whose afternoon van has not been reported on is in two places at once, and before this
   * the row had to pick one of them and drop the other.
   */
  it("a child's two rides are grouped separately, each by its own state", () => {
    const row = rowOf("C7");
    expect(am(row).state).toBe("EN_ROUTE_PICKUP");
    expect(pm(row).state).toBe("CAPABILITY_PENDING");
    expect(legOf("C7", "AM").group).toBe("ON_THE_WAY");
    expect(legOf("C7", "PM").group).toBe("GETTING_READY");
  });

  it("a child the family brings is not riding with us, and no van is implied", () => {
    const pad = board.legs.filter((l) => l.ride.mode === "FAMILY");
    expect(pad.length).toBeGreaterThan(0);
    for (const leg of pad) {
      expect(leg.group, leg.key).toBe("NOT_RIDING");
      expect(leg.nextStep, leg.key).toBe("NOTHING");
      expect(leg.ride.vehicleLabel, leg.key).toBeNull();
    }
  });

  it("a therapy session sits on the row for the half of the day it falls in", () => {
    // PRD §18.1: one session at 09:30 and one at 14:15.
    expect(rowOf("C3").therapy).toEqual({
      therapist: "Tasha L.",
      startsAt: "09:30",
      direction: "AM",
    });
    expect(rowOf("C6").therapy).toEqual({
      therapist: "Devon P.",
      startsAt: "14:15",
      direction: "PM",
    });
  });
});

describe("the shell's search box, applied to the board", () => {
  const leg = legOf("C6", "AM");

  it("matches a child by the name on screen, in any case", () => {
    expect(matchesQuery(leg, "zoe")).toBe(true);
    expect(matchesQuery(leg, "Zoe B.")).toBe(true);
  });

  it("matches a van and a provider, which is what the box offers to search", () => {
    expect(matchesQuery(leg, "V1")).toBe(true);
    expect(matchesQuery(leg, "palm lift")).toBe(true);
  });

  it("an empty query is not a filter", () => {
    expect(matchesQuery(leg, "   ")).toBe(true);
  });

  it("matches nothing it should not", () => {
    expect(matchesQuery(leg, "nobody rides this")).toBe(false);
  });

  it("a search for a child brings back both of their rides", () => {
    const found = board.legs.filter((l) => matchesQuery(l, "Zoe"));
    expect(found.map((l) => l.key)).toEqual(["C6/AM", "C6/PM"]);
  });
});
