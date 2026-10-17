import { describe, expect, it } from "vitest";
import { ACTORS, canTransition, LEG } from "@/domain/machines";
import { legState } from "@/db/schema";
import {
  BOARD_CENSUS,
  CHILDREN,
  DEMO_DAY_RIDES,
  FINISHED_DAY_RIDES,
  RUNS,
  type RideRecord,
} from "@/modules/demo/fixtures/standard";
import { board as boardCopy } from "@/ui/copy";
import { legStates } from "@/ui/states";
import { clockLabel } from "@/ui/service-date";
import {
  BOARD_GROUPS,
  BOARD_SCENARIO_TICK,
  NEXT_STEPS,
  NOTHING_REPORTED,
  buildBoard,
  demoDay,
  demoDayAtTick,
  groupForState,
  matchesQuery,
  rideStateFrom,
  serviceDayFor,
  type BoardRow,
  type LegRow,
  type RideFacts,
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
/** The day before the demo day, read after the last van is in: every ride on it has an outcome. */
const finished = buildBoard(serviceDayFor(demoDay().previousIso));
const rowOf = (key: string): BoardRow => {
  const row = board.rows.find((r) => r.childKey === key);
  if (!row) throw new Error(`no row for ${key}`);
  return row;
};
/** One row of the board: one child's one ride. */
const legIn = (of: typeof board, key: string, direction: "AM" | "PM"): LegRow => {
  const leg = of.legs.find((l) => l.child.childKey === key && l.ride.direction === direction);
  if (!leg) throw new Error(`no ${direction} row for ${key}`);
  return leg;
};
const legOf = (key: string, direction: "AM" | "PM"): LegRow => legIn(board, key, direction);

/** One ride, with nothing observed about it: the starting point for a walk under test. */
const facts = (over: Partial<RideFacts> = {}): RideFacts => ({
  assigned: true,
  capability: "UNKNOWN",
  solver: null,
  departed: false,
  pickupArrived: false,
  dropoffArrived: false,
  receivingAdultOnFile: true,
  ...NOTHING_REPORTED,
  ...over,
});

/**
 * The finished day, with one of its recorded rides replaced — for asking what the board does
 * with a record the scenario would never write. The fixture is put back afterwards, pass or
 * fail, because every other suite in this file reads the real one.
 */
function buildFinishedWith(record: RideRecord): ReturnType<typeof buildBoard> {
  const at = FINISHED_DAY_RIDES.findIndex(
    (r) => r.childKey === record.childKey && r.direction === record.direction,
  );
  const original = FINISHED_DAY_RIDES[at];
  FINISHED_DAY_RIDES[at] = record;
  try {
    return buildBoard(serviceDayFor(demoDay().previousIso));
  } finally {
    FINISHED_DAY_RIDES[at] = original;
  }
}

/**
 * The **demo day**, with one extra recorded ride — for asking what a board read mid-morning does
 * with an outcome the finished day has and it does not. `DEMO_DAY_RIDES` is put back afterwards,
 * pass or fail, because every other suite in this file reads the real one (one ride, the hold).
 */
function buildLiveWith(record: RideRecord): ReturnType<typeof buildBoard> {
  DEMO_DAY_RIDES.push(record);
  try {
    return buildBoard(demoDay());
  } finally {
    DEMO_DAY_RIDES.pop();
  }
}

/** Everything a vehicle and a geofence can possibly report about a ride, and nothing a person has. */
const VEHICLE_SAW_EVERYTHING: Partial<RideFacts> = {
  capability: "VERIFIED",
  solver: "FEASIBLE",
  departed: true,
  pickupArrived: true,
  dropoffArrived: true,
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

  it("is deterministic: the same day builds the same board", () => {
    expect(buildBoard(demoDay())).toEqual(buildBoard(demoDay()));
    expect(board.day.phase).toBe("LIVE");
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
    const { state } = rideStateFrom(
      facts({ ...VEHICLE_SAW_EVERYTHING, solver: "INFEASIBLE" }),
    );
    expect(state).toBe("CAPABILITY_VERIFIED");
  });

  it("a child the family brings stays scheduled: there is no ride to advance", () => {
    const { state, path } = rideStateFrom(facts({ assigned: false }));
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
  it("no row on the live board reaches 'handed off': nobody has reported anything yet", () => {
    for (const row of board.rows) {
      for (const ride of row.rides) expect(ride.state).not.toBe("COMPLETED_HANDOFF");
    }
  });

  it("the walk cannot be pushed past the vehicle's arrival, however much it has seen", () => {
    const { state } = rideStateFrom(facts(VEHICLE_SAW_EVERYTHING));
    expect(state).toBe("ARRIVED_PICKUP");
    // And the machine agrees it is not one step from done, whoever asks.
    expect(canTransition(LEG, "ARRIVED_DROPOFF", "COMPLETED_HANDOFF", "Y")).toBe(false);
    expect(canTransition(LEG, "ARRIVED_DROPOFF", "COMPLETED_HANDOFF", "S")).toBe(true);
  });

  /**
   * The rule stated as the one thing that changes it. Every vehicle fact is held fixed — the van
   * left, reached the kerb, reached the drop-off — and the person facts are added one at a time.
   * Nothing a device reports gets past the boarding report, and nothing gets past the arrival
   * without a custody event. If a later change ever let an arrival stand in for a handoff, the
   * last two rows of this table are what would catch it.
   */
  it.each([
    { reported: false, verified: false, custody: false, state: "ARRIVED_PICKUP" },
    { reported: true, verified: false, custody: false, state: "BOARDED_REPORTED" },
    { reported: true, verified: true, custody: false, state: "ARRIVED_DROPOFF" },
    { reported: true, verified: true, custody: true, state: "COMPLETED_HANDOFF" },
  ])(
    "boarding reported $reported, verified $verified, custody $custody ⇒ $state",
    ({ reported, verified, custody, state }) => {
      const walked = rideStateFrom(
        facts({
          ...VEHICLE_SAW_EVERYTHING,
          boardingReported: reported,
          boardingVerified: verified,
          custodyEvent: custody,
        }),
      );
      expect(walked.state).toBe(state);
    },
  );

  it("the label for a vehicle at the drop-off says so, and never 'Handed off'", () => {
    expect(legStates.ARRIVED_DROPOFF.label).toBe("Arrived (vehicle)");
    expect(legStates.ARRIVED_DROPOFF.label).not.toMatch(/handed off/i);
  });

  /**
   * The finished day is where both answers are on one board, which is the only place the
   * difference between them can be seen: ten rides were received by somebody and say so, one
   * van is standing at a kerb with the handoff not recorded, and the count of the first kind is
   * exactly the count of custody events the day recorded. Nothing rounds an arrival up.
   */
  it("on a finished day, a ride is handed off exactly when a custody event was recorded", () => {
    const handedOff = finished.legs.filter((l) => l.ride.state === "COMPLETED_HANDOFF");
    const recorded = FINISHED_DAY_RIDES.filter((r) => r.receivedBy !== null);
    expect(handedOff.map((l) => l.key).sort()).toEqual(
      recorded.map((r) => `${r.childKey}/${r.direction}`).sort(),
    );

    const arrived = legIn(finished, "C6", "PM");
    expect(arrived.ride.state).toBe("ARRIVED_DROPOFF");
    expect(arrived.ride.path).toContain("ARRIVED_DROPOFF");
    expect(arrived.ride.path).not.toContain("COMPLETED_HANDOFF");
    // The van is there and the board asks the person for the one thing only a person can do.
    expect(arrived.nextStep).toBe("CONFIRM_HANDOFF");
  });

  /**
   * And on a day that is over, that ride needs a person — which is the other half of AT-10 and
   * was the half the board got wrong.
   *
   * Zoe B.'s afternoon van arrived and no custody event was ever recorded. The state is right
   * and stays right: "Arrived (vehicle)", never a handoff. But it sat under **On the way** on a
   * board whose vans are all back in the yard, which reads as a ride still in progress that will
   * close itself — and it was missing from "Only needs action", the one view a coordinator
   * closing out the day works from. So the last unrecorded handoff of the day was the one row
   * nobody was told about.
   */
  describe("a finished day's unrecorded handoff is a thing to do, not a ride in progress", () => {
    const arrived = legIn(finished, "C6", "PM");

    it("is in needs action, with the reason named and the handoff asked for", () => {
      expect(arrived.ride.receivedBy).toBeNull();
      expect(arrived.group).toBe("NEEDS_ACTION");
      expect(arrived.needsActionReasons).toEqual(["HANDOFF_UNRECORDED"]);
      expect(arrived.nextStep).toBe("CONFIRM_HANDOFF");
    });

    /** AT-10 is untouched by all of it: the row still says the van arrived and no more. */
    it("still says the van arrived, and nothing about a handoff", () => {
      expect(arrived.ride.state).toBe("ARRIVED_DROPOFF");
      expect(arrived.ride.path).not.toContain("COMPLETED_HANDOFF");
      expect(legStates[arrived.ride.state].label).not.toMatch(/handed off/i);
    });

    /** Which is what the "Only needs action" toggle filters the board to, so it counts it. */
    it("is counted by the only-needs-action filter", () => {
      const needsAction = finished.legs.filter((l) => l.group === "NEEDS_ACTION");
      expect(needsAction.map((l) => l.key).sort()).toEqual(["C2/PM", "C6/PM"]);
      expect(finished.needsActionCount).toBe(needsAction.length);
      expect(finished.groups[0].group).toBe("NEEDS_ACTION");
    });

    /**
     * The same arrival on a board read mid-morning is **not** a thing to do: the van is at the
     * kerb now, and the handoff is what happens next rather than what nobody did. That contrast
     * is the rule — it is the day that is over, not the state, that makes the row open work.
     */
    it("and the same ride mid-morning is on the way, with the handoff still to come", () => {
      const live = buildLiveWith({
        childKey: "C6",
        direction: "PM",
        departed: true,
        pickupArrived: true,
        boardingReportedBy: "PROVIDER",
        boardingVerified: true,
        dropoffArrived: true,
        receivedBy: null,
      });
      const leg = legIn(live, "C6", "PM");
      expect(leg.ride.state).toBe("ARRIVED_DROPOFF");
      expect(leg.group).toBe("ON_THE_WAY");
      expect(leg.needsActionReasons).toEqual([]);
      expect(leg.nextStep).toBe("CONFIRM_HANDOFF");
    });
  });
});

/**
 * AT-13, the UI half: the scenario has one family with no adult on file who may receive their
 * child (standard.ts: every scope except RECEIVE_CHILD). Staff have to see that in the morning,
 * not at the kerb in the afternoon.
 */
describe("a child with no adult on file to receive them (AT-13)", () => {
  const noReceiver = CHILDREN.filter((c) => !c.scopes.includes("RECEIVE_CHILD"));
  /** The day after the demo day: the plan, where no ride has run and none has ended held. */
  const planned = buildBoard(serviceDayFor(demoDay().nextIso));

  it("the scenario really does contain one, so this suite is about something", () => {
    expect(noReceiver.map((c) => c.key)).toEqual(["C2"]);
  });

  /**
   * Read on a day the ride has not run yet, which is where this reason belongs: the afternoon
   * needs a person because nobody on file may receive the child, and the step is to record one.
   * On the demo day the same ride has already ended holding him, and a held child outranks it
   * (below) — the reason is the same fact one stage earlier.
   */
  it("has the afternoon ride under needs action, with the reason and the step named", () => {
    const leg = legIn(planned, "C2", "PM");
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
    // One child, one ride: no other row on either day carries a receiver-shaped reason.
    for (const of_ of [board, planned]) {
      for (const leg of of_.legs) {
        if (leg.child.childKey === "C2") continue;
        expect(leg.needsActionReasons, leg.key).not.toContain("NO_RECEIVING_ADULT");
      }
    }
  });

  /**
   * The other half of AT-13, and the half the acceptance test is actually about: **a ride that
   * ends there**. The scenario drove Noah O. home, nobody on file could receive him, and no
   * custody event was recorded — so the leg machine's only remaining edge is HELD_NO_RECEIVER,
   * by the system. Everything after that is the "no auto-return" rule: nothing moves the ride
   * on, the board keeps asking for a person, and the only exit the machine has is a staff one.
   *
   * Read on the **demo day**, because that is the board a demo walk opens (`DEMO_DAY_RIDES`,
   * Vera 2026-10-16): a story only a crafted `?date=` could reach was a story the demo did not
   * tell. The finished day records the same ride, and the suite below reads it there too.
   */
  describe("and a ride that ends held, on the day a walk opens (AT-13)", () => {
    const leg = legOf("C2", "PM");

    it("ends HELD_NO_RECEIVER, by a walk the machine allowed one edge at a time", () => {
      expect(leg.ride.state).toBe("HELD_NO_RECEIVER");
      expect(leg.ride.path).toEqual([
        "SCHEDULED",
        "PROVISIONAL_ASSIGNED",
        "CAPABILITY_PENDING",
        "CAPABILITY_REPORTED",
        "CAPABILITY_VERIFIED",
        "MANIFEST_LOCKED",
        "EN_ROUTE_PICKUP",
        "ARRIVED_PICKUP",
        "BOARDED_REPORTED",
        "BOARDED_VERIFIED",
        "IN_TRANSIT",
        "ARRIVED_DROPOFF",
        "HELD_NO_RECEIVER",
      ]);
      for (let i = 1; i < leg.ride.path.length; i += 1) {
        const [from, to] = [leg.ride.path[i - 1], leg.ride.path[i]];
        const legal = LEG.edges.some((e) => (e.from === from || e.from === "*") && e.to === to);
        expect(legal, `${from} → ${to}`).toBe(true);
      }
    });

    it("is held because nobody on file may receive the child, and says so first", () => {
      expect(leg.child.receivingAdult).toBeNull();
      expect(leg.group).toBe("NEEDS_ACTION");
      // One fact, said once, and it is the first thing the row says.
      expect(leg.needsActionReasons).toEqual(["CHILD_HELD"]);
      expect(leg.nextStep).toBe("CALL_CONTACTS");
    });

    it("never turns into a handoff, and nothing automatic takes it anywhere (CA-04)", () => {
      expect(leg.ride.state).not.toBe("COMPLETED_HANDOFF");
      // PRD §6.6 / l.750: the hold exits by staff only, and no wildcard edge leaves it — which
      // is what "no automatic return to the centre" is, written as a machine.
      expect(LEG.noWildcardFrom).toContain("HELD_NO_RECEIVER");
      for (const actor of ACTORS) {
        for (const to of legState.enumValues) {
          const allowed = canTransition(LEG, "HELD_NO_RECEIVER", to, actor);
          if (!allowed) continue;
          expect([actor, to], "only staff may move a held ride").toEqual(["S", "COMPLETED_HANDOFF"]);
        }
      }
    });

    it("is the one ride on either day that ended holding a child", () => {
      for (const of_ of [board, finished]) {
        const held = of_.legs.filter((l) => l.ride.state === "HELD_NO_RECEIVER");
        expect(held.map((l) => l.key)).toEqual(["C2/PM"]);
        // And it is the same child the scenario gives no authorized receiving adult — not a
        // second case written into a day by hand.
        expect(held[0].child.childKey).toBe(noReceiver[0].key);
      }
    });

    /**
     * The fixture's half of the rule: the demo day records *acts*, so the hold on screen is the
     * machine's conclusion and not a state somebody typed. A fixture that wrote
     * "HELD_NO_RECEIVER" down would be claiming the outcome this suite exists to derive.
     */
    it("is written as acts, with no state and no custody event in it", () => {
      expect(DEMO_DAY_RIDES.map((r) => `${r.childKey}/${r.direction}`)).toEqual(["C2/PM"]);
      const [record] = DEMO_DAY_RIDES;
      expect(record.receivedBy).toBeNull();
      expect(record.dropoffArrived).toBe(true);
      expect(record.boardingVerified).toBe(true);
      expect(Object.keys(record)).not.toContain("state");
    });

    it("leaves the rest of the demo day where the replay has it: one outcome, not a finished day", () => {
      // The one recorded ride is the hold and nothing else: no other row on the live board
      // claims an outcome, so nothing on it says a child was received.
      expect(board.legs.filter((l) => l.ride.receivedBy !== null)).toEqual([]);
      expect(legOf("C2", "AM").ride.state).toBe("EN_ROUTE_PICKUP");
    });

    it("keeps the morning of the same child done on the finished day (AT-07)", () => {
      // The centre receives every child it is open for, and needs no family scope to do it —
      // which is why the same child's morning ends handed off and their afternoon does not.
      expect(legIn(finished, "C2", "PM").ride.state).toBe("HELD_NO_RECEIVER");
      expect(legIn(finished, "C2", "AM").ride.state).toBe("COMPLETED_HANDOFF");
      expect(legIn(finished, "C2", "AM").ride.receivedBy).toBe("CENTER_STAFF");
    });

    /**
     * PRD §6.3: a handoff is a custody event naming a receiving adult *with can_receive_child*.
     * A day that recorded one for a family holding no such scope did not record a weaker
     * handoff — it recorded an impossible one, and the board refuses it rather than drawing it.
     */
    it("refuses a recorded handoff to an adult the family does not have (TRP-02)", () => {
      const record = FINISHED_DAY_RIDES.find((r) => r.childKey === "C2" && r.direction === "PM")!;
      expect(record.receivedBy).toBeNull();
      const impossible = { ...record, receivedBy: "ADULT_ON_FILE" as const };
      expect(() => buildFinishedWith(impossible)).toThrow(/an adult F2 does not have/);
    });
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
  it("a van with no displayable position has no age, and still a planned window (LOC-01)", () => {
    // LOC-01 is about a *position*: an unlinked device sends nothing we may draw. The family
    // still holds the window the plan gave them, which is not a thing the van's device knows.
    const ride = am(rowOf("C1"));
    expect(ride.gpsAgeSeconds).toBeNull();
    expect(ride.gpsFreshness).toBeNull();
    expect(ride.windowText).toMatch(/^\d{1,2}:\d{2}–\d{1,2}:\d{2} [AP]M$/);
    // Planned, so nothing claims the day has moved it.
    expect(ride.deltaSeconds).toBeNull();
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

  /**
   * The afternoon used to read "Window pending" on every row of the board, because the committed
   * routes had no afternoon in them (docs/ui/B12-SLICE1-DEFERRED.md §3.2). It has one now —
   * src/fixtures/run-routes.ts, each run's own children's own stops, read out of the scenario —
   * so every afternoon ride has the window its family is actually given.
   */
  it("an afternoon ride carries the window its own stop is planned for", () => {
    for (const leg of board.legs) {
      const { ride } = leg;
      if (ride.direction !== "PM") continue;
      if (ride.mode === "FAMILY") {
        // No van, no arrival to publish: the family brings the child themselves.
        expect(ride.windowText, leg.key).toBeNull();
        continue;
      }
      expect(ride.windowText, leg.key).toMatch(/^\d{1,2}:\d{2}–\d{1,2}:\d{2} [AP]M$/);
      expect(ride.deltaSeconds, leg.key).toBeNull();
    }
    // And it is this child's own afternoon, not the run's first drop: C2 is set down last.
    expect(pm(rowOf("C2")).windowText).toBe("4:20–4:30 PM");
    expect(pm(rowOf("C9")).windowText).toBe("3:50–4:00 PM");
  });

  it("no ride on the board says its window has not been worked out", () => {
    for (const leg of board.legs) {
      if (leg.ride.mode === "FAMILY") continue;
      expect(leg.ride.windowText, leg.key).not.toBeNull();
    }
  });

  /**
   * The window a family holds is the one the route gives their stop, and the plan the scenario
   * wrote by hand says the same thing — within a window's width, which is as exactly as a
   * 10-minute window can agree with anything. That is what "the route data and the scenario are
   * aligned" means in practice, and src/fixtures/run-routes.test.ts holds the per-stop version
   * of it against the geometry.
   */
  it("agrees with the plan the scenario wrote, to within one window", () => {
    for (const row of board.rows) {
      for (const ride of row.rides) {
        /*
         * Planned windows only. A van that is on the road publishes against the replay's own
         * clock, which starts at 07:30 and so runs later than the plan's first pickups — the
         * one piece of the §3.1 fixture gap that is left, and it belongs to the replay rather
         * than to the geometry this is about.
         */
        if (ride.windowText === null || ride.gpsFreshness !== null) continue;
        const planned = clockLabel(ride.plannedWindow);
        const [start, end] = ride.windowText.split("–");
        const meridiem = ride.windowText.slice(-2);
        const minutes = (text: string) => {
          const [, h, m, ap] = /(\d{1,2}):(\d{2})(?: ([AP]M))?/.exec(text) ?? [];
          const hour = Number(h) % 12 + ((ap ?? meridiem) === "PM" ? 12 : 0);
          return hour * 60 + Number(m);
        };
        const gap = Math.min(
          Math.abs(minutes(planned) - minutes(start)),
          Math.abs(minutes(planned) - minutes(end)),
        );
        expect(gap, `${row.childKey} ${ride.direction}: ${planned} vs ${ride.windowText}`)
          .toBeLessThanOrEqual(10);
      }
    }
  });
});

/**
 * One service date for the screen, and the phase of a day decides what the board can show of it
 * (./day.ts). The live day is the only one with a replayed van on it; the day before it is the
 * only one with outcomes; the day after it is the plan.
 */
describe("the board is about one day, and says which", () => {
  it("carries the day it was built for", () => {
    expect(board.day.iso).toBe(demoDay().iso);
    expect(finished.day.phase).toBe("ENDED");
    expect(buildBoard(serviceDayFor(demoDay().nextIso)).day.phase).toBe("PLANNED");
  });

  it("has a live van only on the day the replays belong to", () => {
    expect(board.legs.some((l) => l.ride.gpsFreshness !== null)).toBe(true);
    for (const day of [finished, buildBoard(serviceDayFor(demoDay().nextIso))]) {
      for (const leg of day.legs) {
        expect(leg.ride.gpsFreshness, `${day.day.iso} ${leg.key}`).toBeNull();
        expect(leg.ride.stoppedSeconds, `${day.day.iso} ${leg.key}`).toBe(0);
      }
    }
  });

  /**
   * A day that has not started has **no van out and nothing checked**, and that is a rule about
   * the day rather than about the hour it is read at.
   *
   * The committed replays belong to the demo day alone, and they are read by instant: ask one for
   * a position at six in the morning of the day *after* and the track has long since finished, so
   * the last accepted point comes back and the van looks like it left. From there the whole day
   * unravels on its own — a van that left was checked at the ramp, a checked van can be solved, a
   * solved manifest can be locked — and the plan would be showing vans on the road, ramp checks
   * nobody did and arrivals at kerbs, a day ahead of itself. So this is asserted at both ends:
   * nothing is on the road, and nothing has been observed about any van.
   */
  it("has no van out and nothing checked on a day that has not started", () => {
    const planned = buildBoard(serviceDayFor(demoDay().nextIso));
    expect(planned.day.phase).toBe("PLANNED");
    expect(planned.legs.length).toBeGreaterThan(0);
    for (const leg of planned.legs) {
      // The vehicle facts, from the one module that could have produced them: none of them.
      expect(leg.ride.path, leg.key).not.toContain("EN_ROUTE_PICKUP");
      expect(leg.ride.path, leg.key).not.toContain("ARRIVED_PICKUP");
      expect(leg.ride.path, leg.key).not.toContain("ARRIVED_DROPOFF");
      // And nobody has looked at the van, so there is nothing for the solver to answer with.
      expect(leg.ride.capability, leg.key).toBe("UNKNOWN");
      if (leg.ride.vehicleLabel === null) continue;
      expect(leg.ride.solver, leg.key).toBe("CAPABILITY_PENDING");
      expect(leg.ride.state, leg.key).toBe("CAPABILITY_PENDING");
    }
    // The plan is the plan: no ride on it has an outcome either.
    expect(planned.legs.filter((l) => l.ride.receivedBy !== null)).toEqual([]);
  });

  it("asks nobody about a van on a day that has not started (PRD §18.2 step 5)", () => {
    const planned = buildBoard(serviceDayFor(demoDay().nextIso));
    for (const leg of planned.legs) {
      expect(["NOTHING", "RECORD_RECEIVER"], leg.key).toContain(leg.nextStep);
    }
    // …and does ask on the day the vans are running, which is the contrast that makes it a rule.
    expect(legOf("C1", "AM").nextStep).toBe("ASK_ABOUT_VAN");
  });

  /**
   * The same day, read later (./day.ts `demoDayAtTick`). Two things, and the first one is the
   * one that matters most: the default is the board the whole file above is written against and
   * has to stay it, to the row. A clock that moved the board it was wired into would have made
   * every assertion in this file a statement about a different day.
   *
   * The second is that advancing it moves the morning *on* rather than redeciding it. C3's
   * morning is the ride to test that on, because the only thing that changes about it is the
   * hour: at 07:42 its van is on the way to Greenacres City Hall, and at 07:45 — tick 180 — it
   * has reached the kerb. Nobody signed anything in between, so this is a vehicle fact moving a
   * ride's state, which is exactly what a clock is allowed to do. AT-10 holds while it does:
   * the ride reaches ARRIVED_PICKUP and asks for boarding, not a handoff.
   */
  describe("the demo day read at a later tick", () => {
    it("is the board above when the clock is left where it is", () => {
      expect(buildBoard(demoDayAtTick(BOARD_SCENARIO_TICK))).toEqual(board);
    });

    it("moves a ride whose van has reached the kerb by then, and only that ride", () => {
      const before = legIn(board, "C3", "AM");
      expect(before.ride.state).toBe("EN_ROUTE_PICKUP");
      expect(before.nextStep).toBe("NOTHING");

      const later = buildBoard(demoDayAtTick(BOARD_SCENARIO_TICK + 36));
      expect(later.nowMs).toBe(board.nowMs + 180_000);
      const after = legIn(later, "C3", "AM");
      expect(after.ride.state).toBe("ARRIVED_PICKUP");
      // A geofence arrival asks a person for the next thing; it does not supply it (AT-10).
      expect(after.nextStep).toBe("CONFIRM_BOARDING");
      expect(after.ride.receivedBy).toBeNull();

      // Three minutes is three minutes: no other ride's state moved with it.
      const stateOf = (of: typeof board) => of.legs.map((l) => `${l.key}:${l.ride.state}`);
      expect(stateOf(later).filter((s, i) => s !== stateOf(board)[i])).toEqual([
        `${after.key}:ARRIVED_PICKUP`,
      ]);
    });
  });

  it("has no rows at all on a day the scenario does not run (PRD §18.1 Mon–Fri)", () => {
    const saturday = serviceDayFor("2026-10-17");
    expect(saturday.scheduled).toBe(false);
    const weekend = buildBoard(saturday);
    expect(weekend.legs).toHaveLength(0);
    expect(weekend.rows).toHaveLength(0);
  });

  /** AT-12's shape, on the day it happened: the van did not fit, so staff called it off. */
  it("shows the run whose van does not fit as cancelled by staff, needing nothing further", () => {
    for (const key of ["C1", "C4", "C5"]) {
      const leg = legIn(finished, key, "AM");
      expect(leg.ride.state, key).toBe("CANCELED_TRANSPORT");
      expect(leg.group, key).toBe("NOT_RIDING");
      // A ride that is over needs nothing: the seating question was answered by cancelling it.
      expect(leg.needsActionReasons, key).toEqual([]);
      expect(leg.nextStep, key).toBe("NOTHING");
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
