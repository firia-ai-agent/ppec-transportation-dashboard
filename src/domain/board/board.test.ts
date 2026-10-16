import { describe, expect, it } from "vitest";
import { canTransition, LEG } from "@/domain/machines";
import { legState } from "@/db/schema";
import { BOARD_CENSUS, CHILDREN, RUNS } from "@/modules/demo/fixtures/standard";
import { board as boardCopy } from "@/ui/copy";
import { legStates } from "@/ui/states";
import {
  BOARD_GROUPS,
  activeRide,
  boardInstantMs,
  buildBoard,
  groupForState,
  matchesQuery,
  rideStateFrom,
  type BoardRow,
  type RideView,
} from "./board";
import { manifestFor, solverChild, solverVehicle, vehicleOf } from "./scenario";

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
const am = (row: BoardRow): RideView => row.rides.find((r) => r.direction === "AM")!;
const pm = (row: BoardRow): RideView => row.rides.find((r) => r.direction === "PM")!;

describe("the board is the seeded day, one row per child", () => {
  it("has the census the scenario builds, in fixture order", () => {
    expect(board.rows).toHaveLength(BOARD_CENSUS);
    expect(board.rows.map((r) => r.childKey)).toEqual(CHILDREN.map((c) => c.key));
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

  it("is on the board under needs action, with the reason named", () => {
    const row = rowOf("C2");
    expect(row.group).toBe("NEEDS_ACTION");
    expect(row.needsActionReasons).toContain("NO_RECEIVING_ADULT");
    expect(row.receivingAdultOnFile).toBe(false);
    expect(row.nextStep).toBe("COORDINATOR");
  });

  it("and every other riding child is not flagged for it", () => {
    for (const row of board.rows) {
      if (row.childKey === "C2") continue;
      expect(row.needsActionReasons, row.childKey).not.toContain("NO_RECEIVING_ADULT");
    }
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
  it("every row is in exactly one group, and the groups add up to the census", () => {
    const grouped = board.groups.flatMap((g) => g.rows);
    expect(grouped).toHaveLength(board.rows.length);
    expect(new Set(grouped.map((r) => r.childKey)).size).toBe(board.rows.length);
  });

  it("needs action is the first group on the board (§4.1)", () => {
    expect(board.groups[0].group).toBe("NEEDS_ACTION");
    expect(board.needsActionCount).toBe(board.groups[0].rows.length);
  });

  it("the group names are the ones the copy guide fixes", () => {
    expect(boardCopy.groups.NEEDS_ACTION).toBe("Needs action");
    expect(boardCopy.groups.ON_THE_WAY).toBe("On the way");
    expect(boardCopy.groups.DONE).toBe("Done");
    expect(boardCopy.groups.NOT_RIDING).toBe("Not riding today");
  });

  it("a child whose morning van is moving is on the way, whatever the afternoon says", () => {
    const row = rowOf("C7");
    expect(am(row).state).toBe("EN_ROUTE_PICKUP");
    expect(pm(row).state).toBe("CAPABILITY_PENDING");
    expect(row.group).toBe("ON_THE_WAY");
    expect(activeRide(row.rides).direction).toBe("AM");
  });

  it("a child the family brings is not riding with us, and no van is implied", () => {
    const pad = board.rows.filter((r) => r.rides.every((ride) => ride.mode === "FAMILY"));
    expect(pad.length).toBeGreaterThan(0);
    for (const row of pad) {
      expect(row.group).toBe("NOT_RIDING");
      expect(row.nextStep).toBe("FAMILY");
      for (const ride of row.rides) expect(ride.vehicleLabel).toBeNull();
    }
  });
});

describe("the shell's search box, applied to the board", () => {
  const row = rowOf("C6");

  it("matches a child by the name on screen, in any case", () => {
    expect(matchesQuery(row, "zoe")).toBe(true);
    expect(matchesQuery(row, "Zoe B.")).toBe(true);
  });

  it("matches a van and a provider, which is what the box offers to search", () => {
    expect(matchesQuery(row, "V1")).toBe(true);
    expect(matchesQuery(row, "palm lift")).toBe(true);
  });

  it("an empty query is not a filter", () => {
    expect(matchesQuery(row, "   ")).toBe(true);
  });

  it("matches nothing it should not", () => {
    expect(matchesQuery(row, "nobody rides this")).toBe(false);
  });
});
