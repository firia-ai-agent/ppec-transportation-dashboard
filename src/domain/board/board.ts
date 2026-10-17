/**
 * The Today board, computed (PRD §14 SURF-01, DESIGN-DIRECTION §4.1).
 *
 * One row per child **and ride**: a row is "Mia R., morning", so a child's two rides are two
 * rows with their own state, van, arrival window, needs-action reasons and next step. That is
 * AT-07 made structural — a leg absence is not a day absence, and the morning being on the road
 * says nothing about the afternoon — and it is why nothing here has to choose which of a
 * child's two rides "the row" is about. The drawer is still per child: it is where the two rows
 * are read as one day.
 *
 * Every fact on a row is an answer from a module that already owns the question:
 *  - the ride's state is walked through the **leg machine** (src/domain/machines.ts) one legal
 *    edge at a time, so a state the board shows is a state the domain allows;
 *  - whether the vehicle fits its riders is the **capacity solver** (src/domain/solver), run
 *    over today's manifest and today's capability observation;
 *  - the arrival window, its shift and the GPS age are the **ETA / replay engine**
 *    (src/domain/eta) over the committed ADR-007 routes.
 *
 * The data under all of it is the demo scenario — the same synthetic day `demo reset` seeds
 * (src/modules/demo/fixtures/standard.ts). Nothing on a row is written down as a state: there
 * is no table of "C2 is en route" anywhere in this slice, because a board that can be edited
 * into saying anything proves nothing.
 *
 * Pure and deterministic: no clock, no database, no network. The instant is an argument.
 */

import {
  canTransition,
  LEG,
  type Actor,
} from "@/domain/machines";
import { frameAt, type ReplayFrame } from "@/domain/eta/replay";
import { feasible, type SolveResult, type SolveStatus } from "@/domain/solver";
import { gpsFreshnessFor, type GpsFreshness } from "@/ui/states";
import { serviceDateIso } from "@/ui/service-date";
import type { attendanceState, capabilityState, legState } from "@/db/schema";
import {
  childByKey,
  demoDayRecordFor,
  rideRecordFor,
  THERAPISTS,
  THERAPY_SESSIONS,
  type Child as DemoChild,
  type Need,
  type Receiver,
  type RideRecord,
  type Run as DemoRun,
} from "@/modules/demo/fixtures/standard";
import { demoDay, type DayPhase, type ServiceDay } from "./day";
import {
  boardChildren,
  capabilityFor,
  CENTER_STOP_ID,
  dispatcherOf,
  plannedWindow,
  plannedWindowFor,
  receivingAdultOf,
  replayForVehicle,
  runOfChild,
  solverLeg,
  solverVehicle,
  stopLabel,
  vehicleOf,
  type Direction,
  type ReceivingAdult,
} from "./scenario";

type LegS = (typeof legState.enumValues)[number];
type AttendanceS = (typeof attendanceState.enumValues)[number];
type CapabilityS = (typeof capabilityState.enumValues)[number];

/**
 * Which day, and the instant it is read at, are ./day.ts — re-exported here because the board is
 * what every caller asks for them through.
 */
export {
  BOARD_SCENARIO_SECONDS,
  boardInstantMs,
  demoDay,
  requestedServiceDay,
  serviceDayFor,
} from "./day";
export type { DayPhase, ServiceDay } from "./day";

/* ───────────────────────────── groups (COPY-GUIDE §5 SURF-01) ───────────────────────────── */

/**
 * The board groups, in the order they are stacked (DESIGN-DIRECTION §4.1: needs action first,
 * then in progress, then done).
 *
 * Four of the five names are the COPY-GUIDE §5 group headers verbatim. The fifth,
 * `GETTING_READY`, is an addition: the guide's four were written for a mid-morning board where
 * every ride has started, and a ride that is planned but has not left is neither "on the way"
 * nor "not riding today". Saying so plainly beats filing it under a header that is not true of
 * it.
 */
export const BOARD_GROUPS = [
  "NEEDS_ACTION",
  "GETTING_READY",
  "ON_THE_WAY",
  "DONE",
  "NOT_RIDING",
] as const;
export type BoardGroup = (typeof BOARD_GROUPS)[number];

/** Which group one ride's state falls in, before the row's own needs-action reasons. */
export function groupForState(state: LegS): BoardGroup {
  switch (state) {
    case "EXCEPTION":
    case "NO_SHOW":
    case "HELD_NO_RECEIVER":
    case "LEFT_BEHIND_CAPACITY":
      return "NEEDS_ACTION";
    case "EN_ROUTE_PICKUP":
    case "ARRIVED_PICKUP":
    case "BOARDED_REPORTED":
    case "BOARDED_VERIFIED":
    case "IN_TRANSIT":
    case "ARRIVED_DROPOFF":
      return "ON_THE_WAY";
    case "COMPLETED_HANDOFF":
      return "DONE";
    case "CANCELED_TRANSPORT":
    case "CANCELED_ATTENDANCE":
      return "NOT_RIDING";
    default:
      return "GETTING_READY";
  }
}

/* ───────────────────────────── the row ───────────────────────────── */

/** Why this row is in "Needs action". Codes, so the words stay in the copy module. */
export const NEEDS_ACTION_REASONS = [
  /**
   * AT-13 / PRD §6.6 CA-04: the ride ended at the child's stop with nobody on file to receive
   * them. They are waiting with the van, every contact is being called, and **nothing returns
   * them to the centre on its own** — so this outranks every other reason a row can have.
   */
  "CHILD_HELD",
  /** The solver says the riders do not fit the vehicle as it was observed (PRD §7). */
  "DOES_NOT_FIT",
  /** No adult on file is allowed to receive this child at the end of the ride (TRP-02, PRD §6.6). */
  "NO_RECEIVING_ADULT",
  /** The ride's own state is one of the §3 crit states. */
  "RIDE_STATE",
  /** LOC-03: nothing has been heard from the vehicle for ten minutes. */
  "LOCATION_LOST",
] as const;
export type NeedsActionReason = (typeof NEEDS_ACTION_REASONS)[number];

/**
 * The next step on a ride. A thing to do, not a role to pass it to.
 *
 * This used to be the owner — COORDINATOR, FRONT_DESK, PROVIDER — which is a column that tells
 * a coordinator reading their own board the one thing they already know. The codes below are
 * chosen here and become a sentence in src/ui/copy.ts (`board.nextSteps`), where each one opens
 * with a verb and names the child: "Record who receives Noah O.", not "Coordinator".
 */
export const NEXT_STEPS = [
  /** CA-04's own step: call every authorized and emergency contact for a child being held. */
  "CALL_CONTACTS",
  "MOVE_TO_FITTING_VAN",
  "RECORD_RECEIVER",
  "DECIDE_RIDE",
  "FIND_VAN",
  "CONFIRM_BOARDING",
  "CONFIRM_HANDOFF",
  /**
   * Two codes for one question — what can this van carry today? A provider's van is a
   * dispatcher's answer to give, and the dispatcher has a name. The centre's own van has no
   * dispatcher: the people who can answer it are the ones standing at the ramp.
   */
  "ASK_ABOUT_VAN",
  "CHECK_VAN_AT_RAMP",
  /** The only entry that is not an instruction, because it is the only one that is not a step. */
  "NOTHING",
] as const;
export type NextStep = (typeof NEXT_STEPS)[number];

export type RideView = {
  direction: Direction;
  /** PROVIDER / CENTER van / FAMILY drop-off, from the child's plan. */
  mode: DemoChild["amMode"];
  state: LegS;
  /** The edges walked to reach `state`, each one checked against the leg machine. */
  path: readonly LegS[];
  /** "07:10" — the window this ride is planned for, site-local. */
  plannedWindow: string;
  /** The child's own landmark stop, or null when they have none. */
  stop: string | null;
  vehicleLabel: string | null;
  vehicleDescription: string | null;
  providerName: string | null;
  /** The person at the provider who answers for this van, named. Null for the centre's fleet. */
  providerDispatcher: string | null;
  layoutCode: string | null;
  capability: CapabilityS;
  solver: SolveStatus | null;
  /** Why the solver could not answer, in the words src/ui/copy.ts gives it. */
  solverPendingReason: string | null;
  /** The published 10-minute window the family holds, e.g. "7:50–8:00 AM". */
  windowText: string | null;
  /** Current estimate minus the window first published for this ride, seconds. */
  deltaSeconds: number | null;
  /** LOC-03: the GPS is stale, so ETA texts are paused. */
  etaPaused: boolean;
  /** Undefined when this vehicle has sent no displayable position at all (LOC-01). */
  gpsAgeSeconds: number | null;
  gpsFreshness: GpsFreshness | null;
  /** §5.1: "Stopped 3 min" — seconds the vehicle has not moved. */
  stoppedSeconds: number;
  /**
   * Who received the child, when the day recorded a custody event (§6.3). The §3 handoff label
   * is "Handed off to {receiver role}", and this is what fills it: the adult the family has on
   * file, by name, or the centre's own ramp for a morning ride that ended there.
   */
  receivedBy: Receiver | null;
};

export type NeedView = {
  category: Need["category"];
  state: Need["state"];
  /** PRD VEH-01 / DECISION-LEDGER row 1: only an approved need drives seat allocation. */
  usedForAllocation: boolean;
};

/** One child's day. The drawer's unit, and what a board row's two halves belong to. */
export type BoardRow = {
  childKey: string;
  /** "Mia R." — first name plus last initial, the only child label a staff screen shows (D-3). */
  childLabel: string;
  attendance: AttendanceS;
  rides: readonly RideView[];
  /** TRP-02: the adult on file allowed to receive this child, named, or null when there is none. */
  receivingAdult: ReceivingAdult | null;
  /** `direction` is the half of the day the session falls in, so it sits on that ride's row. */
  therapy: { therapist: string; startsAt: string; direction: Direction } | null;
  needs: readonly NeedView[];
  /** The approved transport profile's version (PRD VEH-01; the seed writes v1, APPROVED). */
  profileVersion: number;
  /** NFR-09: every record carries where its data came from. */
  sourceMode: "SIMULATED";
};

/**
 * One child's one ride: the board's own unit, and the thing a row is.
 *
 * It carries the child it belongs to rather than copying the child's facts out, so the row and
 * the drawer cannot drift: the same `BoardRow` object is behind both.
 */
export type LegRow = {
  /** Stable per child and direction, so React keys and focus survive a filter. */
  key: string;
  child: BoardRow;
  ride: RideView;
  group: BoardGroup;
  /** Why *this ride* needs action. An afternoon with nobody to receive never flags the morning. */
  needsActionReasons: readonly NeedsActionReason[];
  nextStep: NextStep;
};

export type BoardGroupView = { group: BoardGroup; legs: readonly LegRow[] };

export type Board = {
  /** The service day these rows are about, and the instant they were read at. */
  day: ServiceDay;
  nowMs: number;
  /** One per child, in fixture order: what the drawer reads. */
  rows: readonly BoardRow[];
  /** One per child and ride, in fixture order then morning before afternoon: what the board is. */
  legs: readonly LegRow[];
  groups: readonly BoardGroupView[];
  /** Rides needing action, which is what the "Only needs action" toggle filters the board to. */
  needsActionCount: number;
};

/* ───────────────────────────── the leg machine, walked ───────────────────────────── */

/**
 * What the day has observed about one ride, which is all the machine is allowed to move on.
 *
 * Two kinds of fact, kept apart on purpose. A **vehicle** fact is something a device or a
 * geofence produced — it departed, it reached a kerb, it reached the drop-off — and a **person**
 * fact is something somebody did and signed: reported the child aboard, verified it, received
 * the child. AT-10 is the rule that the first kind never stands in for the second, and the only
 * place a projection could break it is here, so here is where the two are named differently.
 */
export type RideFacts = {
  assigned: boolean;
  capability: CapabilityS;
  solver: SolveStatus | null;
  /* ── vehicle facts (the replay, LOC-01/ASM-18) ── */
  departed: boolean;
  pickupArrived: boolean;
  dropoffArrived: boolean;
  /* ── person facts (what the day recorded) ── */
  /** §6.3: a guardian or the provider reported the child aboard. */
  boardingReported: boolean;
  /** §6.3: staff verified that boarding. Never the agent (§11.2). */
  boardingVerified: boolean;
  /** §6.3: a custody event naming the adult who received the child. */
  custodyEvent: boolean;
  /** TRP-02: is there an adult on file allowed to receive this child at all? */
  receivingAdultOnFile: boolean;
  /** §6.3: staff cancelled the ride before anyone boarded. */
  canceledByStaff: boolean;
};

/** A ride nobody has reported anything about yet: every person fact is absent. */
export const NOTHING_REPORTED = {
  boardingReported: false,
  boardingVerified: false,
  custodyEvent: false,
  canceledByStaff: false,
} as const;

/**
 * The ride's state, reached one legal edge at a time.
 *
 * Every step asks `canTransition` with the actor PRD §6.3 names for that edge — the provider
 * reports a capability, staff verify it, the system locks the manifest — and refuses to take a
 * step the machine does not allow. That refusal is the point: it is what stops this projection
 * from quietly inventing a state (an "arrived" that skipped boarding, a "handed off" that no
 * custody event backs) that the rest of the system would never produce.
 */
export function rideStateFrom(facts: RideFacts): { state: LegS; path: LegS[] } {
  const path: LegS[] = ["SCHEDULED"];
  let state: LegS = "SCHEDULED";
  const step = (to: LegS, actor: Actor) => {
    if (!canTransition(LEG, state, to, actor)) {
      throw new Error(`the leg machine has no ${state} → ${to} by ${actor}`);
    }
    state = to;
    path.push(to);
  };

  // A child with no run of their own is not riding with us: the family brings them, and the
  // ride stays where the seed left it (standard.ts `amMode`/`pmMode` FAMILY).
  if (!facts.assigned) return { state, path };

  step("PROVISIONAL_ASSIGNED", "Y");
  step("CAPABILITY_PENDING", "Y");
  if (facts.capability === "UNKNOWN" || facts.capability === "REQUESTED") return { state, path };

  step("CAPABILITY_REPORTED", "P");
  if (facts.capability !== "VERIFIED") return { state, path };

  // PRD §6.3: only staff may verify, and only a FEASIBLE solve may lock a manifest.
  step("CAPABILITY_VERIFIED", "S");
  /*
   * Staff called it off before anyone boarded — which on this scenario's finished day is what
   * happened to the run whose van the solver says does not fit its riders: the check was done,
   * the van was short a tethered seat, and the families drove (AT-12: a family is told only
   * after staff have chosen). A cancellation is a decision, so it is a person's fact too.
   */
  if (facts.canceledByStaff) {
    step("CANCELED_TRANSPORT", "S");
    return { state, path };
  }
  if (facts.solver !== "FEASIBLE") return { state, path };
  step("MANIFEST_LOCKED", "Y");

  if (!facts.departed) return { state, path };
  step("EN_ROUTE_PICKUP", "P");
  if (!facts.pickupArrived) return { state, path };
  step("ARRIVED_PICKUP", "Y");

  /*
   * AT-10 lives on this line. Boarding is a person's act, reported at the vehicle and verified
   * by staff (PRD §6.3 ARRIVED_PICKUP → BOARDED_REPORTED by a guardian or the provider), and a
   * geofence is not a person: a vehicle reaching a place may never be read as a child changing
   * hands. A day the replay can see and nobody has reported on stops here — the board shows the
   * arrival and says no more than that — and no amount of further *vehicle* facts moves it,
   * because the next edge needs a name on a report.
   */
  if (!facts.boardingReported) return { state, path };
  step("BOARDED_REPORTED", "P");
  if (!facts.boardingVerified) return { state, path };
  step("BOARDED_VERIFIED", "S");
  step("IN_TRANSIT", "Y");

  // ASM-18: the geofence may say the van is at the drop-off, and that is all it may say.
  if (!facts.dropoffArrived) return { state, path };
  step("ARRIVED_DROPOFF", "Y");

  /*
   * The two ways a ride that got there ends, and the difference between them is a person.
   *
   * With a custody event naming the adult who received the child, the ride is done (§6.3
   * ARRIVED_DROPOFF → COMPLETED_HANDOFF, by staff or the guardian — never by Y, which is why a
   * geofence cannot reach it even here). Without one, and with nobody on file who may receive
   * the child, the only edge left is the one AT-13 is about: HELD_NO_RECEIVER by the system —
   * the child waits with the van, every contact is called, a staff task is raised, and there is
   * **no automatic return to the centre** (PRD §6.6 CA-04, DECISION-LEDGER row 47). The machine
   * holds that last part for us: HELD_NO_RECEIVER is in `noWildcardFrom` and its only exit is
   * by staff, so a ride that ends there stays there however long the board is left open.
   *
   * And if a custody event is simply missing while an adult *is* on file, the ride stays at the
   * arrival and asks for the handoff. That is the ordinary case, and it is the one that proves
   * the rule: the van is there, the board says so, and nothing says the child was received.
   */
  if (facts.custodyEvent) {
    step("COMPLETED_HANDOFF", "S");
    return { state, path };
  }
  if (!facts.receivingAdultOnFile) step("HELD_NO_RECEIVER", "Y");
  return { state, path };
}

/* ───────────────────────────── building the board ───────────────────────────── */

type RunSolve = { solve: SolveResult; capability: CapabilityS; departed: boolean };

/**
 * A ride's vehicle has a displayable position when its committed run has accepted at least one
 * point at or before now. An unbound device produces none, ever (LOC-01: ingested, stored
 * `bound=false`, displayed nowhere), which is why "departed" is read off the accepted points
 * and not off the clock.
 */
function frameFor(run: DemoRun, nowMs: number): ReplayFrame | null {
  const replay = replayForVehicle(run.vehicleKey);
  if (!replay) return null;
  const frame = frameAt(replay, nowMs, false);
  return frame.hidden ? null : frame;
}

/** The window first published for a stop, which is what a shift on the board is measured against. */
function plannedEtaMs(run: DemoRun, stopId: string): number | null {
  const replay = replayForVehicle(run.vehicleKey);
  if (!replay) return null;
  const first = frameAt(replay, replay.spec.startAtMs, false);
  return first.stops.find((s) => s.stopId === stopId)?.etaMs ?? null;
}

/**
 * The vehicle half of one ride: has it left, and has anybody checked the van today.
 *
 * Only the demo day has a replayed run, and only its morning: a van is "on the road" because the
 * committed geometry says where it is at this instant, not because the clock says it ought to be.
 * A day that has ended put every van through the ramp gate — a manifest cannot be locked and a
 * van cannot be released on an unchecked vehicle (PRD §6.3) — which is how the one run whose
 * riders do not fit got as far as being cancelled rather than quietly staying "pending".
 *
 * `recorded` is that same gate for a single ride: a ride the day has acts for was driven, and a
 * van that was driven was checked first. It is what lets the demo day's one recorded ride (the
 * AT-13 hold) walk past the capability edge while the afternoon rides around it, which nobody
 * has reported on, stay honestly pending.
 */
function solveRun(
  run: DemoRun,
  direction: Direction,
  day: ServiceDay,
  recorded: boolean,
): RunSolve {
  const departed =
    day.phase === "LIVE" && direction === "AM" && frameFor(run, day.instantMs) !== null;
  const checked = day.phase === "ENDED" || departed || recorded;
  const capability = capabilityFor(run, serviceDateIso(new Date(day.instantMs)), checked);
  const solve = feasible(solverVehicle(vehicleOf(run)), solverLeg(run, direction), capability);
  return { solve, capability: capability.state, departed };
}

/**
 * The arrival the board shows.
 *
 * Two answers, and the row can tell them apart. While a van is actually on the road the window
 * is the *published* one — recalculated against its real position, damped by the §8 hysteresis,
 * and shown with the shift today has put on it. Otherwise the window is the one the **plan**
 * gives this child's own stop, from the committed geometry of the run their van will drive
 * (`plannedWindowFor`), and it comes with no shift because nothing has moved it yet.
 *
 * That second answer is the afternoon's. It used to be "Window pending" on every PM row of the
 * board, which told a coordinator the arrival had not been worked out when the route it will be
 * driven on was committed weeks ago.
 */
type EtaView = Pick<
  RideView,
  "windowText" | "deltaSeconds" | "etaPaused" | "gpsAgeSeconds" | "gpsFreshness" | "stoppedSeconds"
>;

/** No window and no position: a ride nobody can say anything about yet. */
const NO_ETA: EtaView = {
  windowText: null,
  deltaSeconds: null,
  etaPaused: false,
  gpsAgeSeconds: null,
  gpsFreshness: null,
  stoppedSeconds: 0,
};

function etaViewFor(
  child: DemoChild,
  run: DemoRun,
  direction: Direction,
  day: ServiceDay,
): EtaView {
  const live = day.phase === "LIVE" && direction === "AM" ? frameFor(run, day.instantMs) : null;
  if (!live) {
    return { ...NO_ETA, windowText: plannedWindowFor(child, run, direction, day) };
  }
  return liveEtaView(run, live);
}

/** The window a van on the road is publishing, and how far today has moved it. */
function liveEtaView(run: DemoRun, frame: ReplayFrame): EtaView {
  const centre = frame.stops.find((s) => s.stopId === CENTER_STOP_ID);
  const planned = plannedEtaMs(run, CENTER_STOP_ID);
  const age = frame.gpsAgeSeconds;
  return {
    windowText: centre?.windowText ?? null,
    deltaSeconds:
      centre?.etaMs !== undefined && planned !== null ? (centre.etaMs - planned) / 1000 : null,
    etaPaused: frame.etaTextSuppressed,
    gpsAgeSeconds: age ?? null,
    gpsFreshness: age === undefined ? null : gpsFreshnessFor(age),
    stoppedSeconds: frame.stoppedSeconds,
  };
}

/**
 * What the day recorded about this ride, in person acts.
 *
 * A day that has ended recorded all of them, which is what makes it the day with outcomes on it.
 * The demo day is read twelve minutes into its morning runs, so it records one — the AT-13 ride
 * (`DEMO_DAY_RIDES`), on the board because a demo walk that cannot reach the hold and the
 * no-auto-return rule does not show them at all (Vera, 2026-10-16). Every other ride on it stops
 * at what the replay can see, which is the state it was already in; a day that has not started
 * has nothing to record at all.
 */
function dayRecordFor(
  child: DemoChild,
  direction: Direction,
  day: ServiceDay,
): RideRecord | undefined {
  if (day.phase === "ENDED") return rideRecordFor(child.key, direction);
  return day.phase === "LIVE" ? demoDayRecordFor(child.key, direction) : undefined;
}

function reportedActs(child: DemoChild, record: RideRecord | undefined) {
  if (!record) return NOTHING_REPORTED;
  /*
   * PRD §6.3: a handoff is "a custody event naming receiving adult **with can_receive_child**".
   * A record claiming the family's adult received a child whose family holds no such scope is
   * not a weaker handoff, it is an impossible one (TRP-02) — so it is refused here rather than
   * rendered. The morning's "the ramp received them" is a different claim and needs no scope:
   * the centre receives every child it is open for.
   */
  if (record.receivedBy === "ADULT_ON_FILE" && receivingAdultOf(child) === null) {
    throw new Error(
      `${child.key}/${record.direction}: a custody event names an adult ${child.familyKey} does not have`,
    );
  }
  return {
    boardingReported: record.boardingReportedBy !== null,
    boardingVerified: record.boardingVerified,
    custodyEvent: record.receivedBy !== null,
    canceledByStaff: record.canceledByStaff === true,
    // ASM-18 again: the arrivals the day logged are geofence facts, and stay that kind of fact.
    departed: record.departed,
    pickupArrived: record.pickupArrived,
    dropoffArrived: record.dropoffArrived,
  };
}

function rideFor(child: DemoChild, direction: Direction, day: ServiceDay): RideView {
  const mode = direction === "AM" ? child.amMode : child.pmMode;
  const run = runOfChild(child.key);
  const base = {
    direction,
    mode,
    plannedWindow: plannedWindow(child, direction),
    stop: stopLabel(child),
  };

  if (!run) {
    const { state, path } = rideStateFrom({
      assigned: false,
      capability: "UNKNOWN",
      solver: null,
      departed: false,
      pickupArrived: false,
      dropoffArrived: false,
      receivingAdultOnFile: receivingAdultOf(child) !== null,
      ...NOTHING_REPORTED,
    });
    return {
      ...base,
      state,
      path,
      vehicleLabel: null,
      vehicleDescription: null,
      providerName: null,
      providerDispatcher: null,
      layoutCode: null,
      capability: "UNKNOWN",
      solver: null,
      solverPendingReason: null,
      receivedBy: null,
      ...NO_ETA,
    };
  }

  const vehicle = solverVehicle(vehicleOf(run));
  const dispatcher = dispatcherOf(vehicleOf(run));
  const record = dayRecordFor(child, direction, day);
  const { solve, capability, departed } = solveRun(run, direction, day, record !== undefined);
  const frame = departed ? frameFor(run, day.instantMs) : null;
  const ownStop = stopLabel(child);
  const acts = reportedActs(child, record);
  const { state, path } = rideStateFrom({
    assigned: true,
    capability,
    solver: solve.status,
    departed,
    // The child's own stop, only when the committed geometry actually names it.
    pickupArrived:
      frame?.stops.some((s) => s.stopName === ownStop && s.status === "arrived") ?? false,
    dropoffArrived:
      frame?.stops.some((s) => s.stopId === CENTER_STOP_ID && s.status === "arrived") ?? false,
    receivingAdultOnFile: receivingAdultOf(child) !== null,
    // Last, so a day that recorded its own arrival says so rather than the live frame.
    ...acts,
  });

  return {
    ...base,
    state,
    path,
    vehicleLabel: vehicle.label,
    vehicleDescription: vehicle.description,
    providerName: vehicle.providerName,
    providerDispatcher: dispatcher,
    layoutCode: run.layoutCode,
    capability,
    solver: solve.status,
    solverPendingReason: solve.pendingReason,
    receivedBy: record?.receivedBy ?? null,
    ...etaViewFor(child, run, direction, day),
  };
}

function attendanceFor(child: DemoChild): AttendanceS {
  // A child the family brings in themselves is an AM self-drop, which is an attendance fact
  // rather than a ride (PRD ATT-01, §3 "Family drop-off").
  return child.amMode === "FAMILY" ? "AM_SELF_DROP" : "SCHEDULED";
}

/**
 * Why *this ride* needs action, in the order the board ranks them.
 *
 * Per ride, not per child: a morning van on the road and an afternoon with nobody to receive
 * the child are two different facts with two different next steps, and rolling them into one
 * row forced the board to pick which of them to say out loud. The afternoon's missing receiver
 * is still visible in the morning — the receiver column carries it on both of a child's rows
 * (TRP-02 / PRD §6.6: the scenario's F2 family holds every scope except RECEIVE_CHILD, and
 * staff have to know before the van is at the kerb) — but the step belongs to the ride that
 * ends away from the centre, because that is the ride it stops.
 */
function needsActionFor(child: DemoChild, ride: RideView): NeedsActionReason[] {
  /*
   * A ride that is over needs nothing. The seating question a cancelled ride would otherwise
   * raise was answered by cancelling it, and a handed-off child is not waiting on anybody — so
   * the machine's own terminal list is what decides, rather than a second list here that could
   * disagree with it. Note which state is *not* in that list: HELD_NO_RECEIVER is not terminal,
   * because a child waiting with a van is the most open thing on the board (PRD §6.6).
   */
  if (LEG.terminal.includes(ride.state)) return [];

  const reasons: NeedsActionReason[] = [];
  /*
   * A held child is one fact, said once. "Nobody on file may receive them" and "this ride needs
   * a person to decide what happens next" are both true of a ride that ended holding a child,
   * and stacking all three on the row would make the one sentence that matters the third one
   * read. What is *not* folded in is the van going quiet underneath it (below): a child waiting
   * in a van nobody can locate is a different and worse fact.
   */
  const held = ride.state === "HELD_NO_RECEIVER";
  if (held) reasons.push("CHILD_HELD");
  if (ride.solver === "INFEASIBLE" || ride.solver === "VEHICLE_UNAVAILABLE") {
    reasons.push("DOES_NOT_FIT");
  }
  if (
    !held &&
    ride.direction === "PM" &&
    ride.mode !== "FAMILY" &&
    receivingAdultOf(child) === null
  ) {
    reasons.push("NO_RECEIVING_ADULT");
  }
  if (!held && groupForState(ride.state) === "NEEDS_ACTION") reasons.push("RIDE_STATE");
  if (ride.gpsFreshness === "LOST") reasons.push("LOCATION_LOST");
  return reasons;
}

/** The step each needs-action reason asks for, keyed by the reason the board ranks first. */
const STEP_FOR_REASON: Readonly<Record<NeedsActionReason, NextStep>> = {
  CHILD_HELD: "CALL_CONTACTS",
  DOES_NOT_FIT: "MOVE_TO_FITTING_VAN",
  NO_RECEIVING_ADULT: "RECORD_RECEIVER",
  RIDE_STATE: "DECIDE_RIDE",
  LOCATION_LOST: "FIND_VAN",
};

/**
 * The one thing to do next on this ride.
 *
 * A ride that needs action takes the step its first-ranked reason asks for. Otherwise the step
 * is whatever the ride's own state is waiting on, and "nothing" is a real answer: a van in
 * transit, a family driving their own child and a locked manifest are all waiting on nobody,
 * and a column that invented work for them would bury the rides that have some.
 */
function nextStepFor(
  ride: RideView,
  reasons: readonly NeedsActionReason[],
  phase: DayPhase,
): NextStep {
  if (reasons.length > 0) return STEP_FOR_REASON[reasons[0]];
  if (ride.mode === "FAMILY") return "NOTHING";
  if (ride.state === "ARRIVED_PICKUP") return "CONFIRM_BOARDING";
  if (ride.state === "ARRIVED_DROPOFF") return "CONFIRM_HANDOFF";
  if (ride.capability === "UNKNOWN" || ride.capability === "REQUESTED") {
    // The capability request goes out ninety minutes before the run (PRD §18.2 step 5), so a day
    // that has not started is not waiting on a dispatcher yet and must not say it is.
    if (phase === "PLANNED") return "NOTHING";
    return ride.providerDispatcher === null ? "CHECK_VAN_AT_RAMP" : "ASK_ABOUT_VAN";
  }
  return "NOTHING";
}

function rowFor(child: DemoChild, day: ServiceDay, therapy: BoardRow["therapy"]): BoardRow {
  const rides: RideView[] = [rideFor(child, "AM", day), rideFor(child, "PM", day)];
  return {
    childKey: child.key,
    childLabel: child.label,
    attendance: attendanceFor(child),
    rides,
    receivingAdult: receivingAdultOf(child),
    therapy,
    needs: child.needs.map((n) => ({
      category: n.category,
      state: n.state,
      usedForAllocation: n.state === "APPROVED",
    })),
    profileVersion: 1,
    sourceMode: "SIMULATED",
  };
}

/** One row of the board: this child, this ride, and what it is waiting for. */
function legFor(child: DemoChild, row: BoardRow, ride: RideView, phase: DayPhase): LegRow {
  const needsActionReasons = needsActionFor(child, ride);
  return {
    key: `${row.childKey}/${ride.direction}`,
    child: row,
    ride,
    group:
      needsActionReasons.length > 0
        ? "NEEDS_ACTION"
        : ride.mode === "FAMILY"
          ? "NOT_RIDING"
          : groupForState(ride.state),
    needsActionReasons,
    nextStep: nextStepFor(ride, needsActionReasons, phase),
  };
}

/**
 * Today's therapy sessions, by child (PRD §18.1: T1 at 09:30, T2 in the afternoon).
 *
 * The session's half of the day comes from its own start time, so it lands on the row for the
 * ride it could actually affect rather than on both of them.
 */
function therapyByChild(): Map<string, BoardRow["therapy"]> {
  const out = new Map<string, BoardRow["therapy"]>();
  for (const session of THERAPY_SESSIONS) {
    const therapist = THERAPISTS.find((t) => t.key === session.therapistKey);
    if (!therapist) continue;
    out.set(session.childKey, {
      therapist: therapist.label,
      startsAt: session.start,
      direction: Number(session.start.slice(0, 2)) < 12 ? "AM" : "PM",
    });
  }
  return out;
}

/**
 * The board for one service day (defaulting to the demo day).
 *
 * A day the scenario does not run at all — a weekend — has no rows rather than empty ones: PRD
 * §18.1 schedules the runs Mon–Fri, and a board that showed 28 children with nothing against
 * their names would be inventing a day. The screen says which kind of nothing it is
 * (COPY-GUIDE §5 "No rides scheduled for {date}").
 */
export function buildBoard(day: ServiceDay = demoDay()): Board {
  const therapy = therapyByChild();
  const children = day.scheduled ? boardChildren : [];
  const rows = children.map((child) => rowFor(child, day, therapy.get(child.key) ?? null));
  const legs = children.flatMap((child, i) =>
    rows[i].rides.map((ride) => legFor(child, rows[i], ride, day.phase)),
  );
  const groups = BOARD_GROUPS.map((group) => ({
    group,
    legs: legs.filter((l) => l.group === group),
  })).filter((g) => g.legs.length > 0);
  return {
    day,
    nowMs: day.instantMs,
    rows,
    legs,
    groups,
    needsActionCount: legs.filter((l) => l.group === "NEEDS_ACTION").length,
  };
}

/**
 * The §2 global search, applied to the board: a child, a vehicle or a provider. The shell's
 * search box already submits `?q=` to this page; this is the half that was waiting for a board
 * to search.
 *
 * Asked of a row, which is one ride — so searching a van brings back the rides that van is
 * driving today and not the other half of those children's days, which is on a different van.
 */
export function matchesQuery(leg: LegRow, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return true;
  const { ride } = leg;
  const haystack = [
    leg.child.childLabel,
    ride.vehicleLabel,
    ride.vehicleDescription,
    ride.providerName,
    ride.stop,
  ];
  return haystack.some((value) => value !== null && value.toLowerCase().includes(q));
}

/** Child by key, for the drawer. Throws on an unknown key rather than rendering an empty panel. */
export function childOf(key: string): DemoChild {
  return childByKey(key);
}
