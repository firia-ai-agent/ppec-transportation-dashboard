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
 *    over today's capability observation and the manifest of whoever is actually on that van —
 *    the saved plan's riders where there is one, the scenario's where there is not (`ridersOf`);
 *  - the arrival window, its shift and the GPS age are the **ETA / replay engine**
 *    (src/domain/eta) over the committed ADR-007 routes.
 *
 * The data under all of it is the demo scenario — the same synthetic day `demo reset` seeds
 * (src/modules/demo/fixtures/standard.ts) — with **one** exception, which is the one fact on a
 * row that a person decides rather than a module computes: *which van a child rides this leg*.
 * When a coordinator has saved a plan for this date and this leg, that comes from the saved
 * plan (`saved`, below) and the scenario's own run is not consulted for it; the leg with nothing
 * saved for it is still the scenario's, entirely. Every other fact — the state, the seating
 * verdict, the window, the position — is then computed about **the van the plan put the child
 * on**, and a fact that can only come from the seeded run of some other van is left pending
 * rather than borrowed from it.
 *
 * Nothing on a row is written down as a state: there is no table of "C2 is en route" anywhere in
 * this slice, because a board that can be edited into saying anything proves nothing.
 *
 * Pure and deterministic: no clock, no database, no network. The instant is an argument, and so
 * is the saved plan — the read that fetches it is the plan board's own `loadBoard`, called on the
 * server in src/app/(app)/today/page.tsx (`savedPlacementsForBoard`, src/modules/plan/store.ts).
 */

import {
  canTransition,
  LEG,
  type Actor,
} from "@/domain/machines";
import { frameAt, type ReplayFrame } from "@/domain/eta/replay";
import { driverFor } from "@/domain/plan/day";
import { vanConfigOf } from "@/config/vans";
import { shortName } from "@/ui/display-name";
import type { SolveStatus } from "@/domain/solver";
import { fits, type FitRider } from "@/domain/plan/fit";
import { setupFor, type VanSetups } from "@/domain/plan/setup";
import { needsOfDemoChild } from "@/modules/demo/day-source";
import { solver as solverCopy } from "@/ui/copy";
import { gpsFreshnessFor, type GpsFreshness } from "@/ui/states";
import { clockLabel, serviceDateIso } from "@/ui/service-date";
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
import type { Bucket } from "@/domain/day/source";
import { demoDay, type DayPhase, type ServiceDay } from "./day";
import {
  boardChildren,
  capabilityFor,
  CENTER_STOP_ID,
  dispatcherOf,
  legModeOf,
  guardianAdultOf,
  plannedWindow,
  plannedWindowFor,
  receivingAdultOf,
  replayForVehicle,
  runOfChild,
  runOfVehicle,
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
  BOARD_SCENARIO_TICK,
  CLOCK_PARAM,
  boardInstantMs,
  demoDay,
  demoDayAtTick,
  demoDayTickAt,
  requestedBoardDay,
  requestedServiceDay,
  serviceDayFor,
} from "./day";
export type { DayPhase, ServiceDay } from "./day";

/* ───────────────────────────── the saved plan (REDESIGN-SPEC §9.1) ───────────────────────────── */

/**
 * WHERE THE SAVED PLAN PUTS ONE CHILD ON ONE LEG — the board's half of `ops.plan_assignment`.
 *
 * Firia's signed rule of 2026-10-17 6:02 PM ET: Today, the Live map and Health read the **saved
 * plan**. A plan is per date *and* per leg, so a saved morning says nothing about the afternoon
 * and each leg is handed in on its own.
 *
 * It arrives in this scenario's own vocabulary — a fixture vehicle key, keyed by fixture child
 * key — because that is the only vocabulary a pure projection over the fixtures can use. The
 * translation from the ids the rows actually hold (`ops.child_profile.child_token`,
 * `ops.vehicle.id`) happens once, where the read happens, through the fixtures' own
 * `childKeyOfToken` / `vehicleKeyOfId` (src/modules/plan/store.ts). One formula and its
 * one inverse: a second, home-made one is what showed every van the next van's children (Veri
 * S1, 2026-10-18 3:03 AM ET).
 */
export type SavedSpot =
  | { bucket: Extract<Bucket, "VAN">; vehicleKey: string }
  | { bucket: Exclude<Bucket, "VAN">; vehicleKey?: undefined };

/** One leg of a saved plan: where it puts every child of the day, by fixture child key. */
export type SavedLegPlan = Readonly<Record<string, SavedSpot>>;

/**
 * The saved plan as the board takes it: one entry per leg a plan has been saved for.
 *
 * A leg that is absent here is a leg nothing has been saved for (`loadBoard`'s `version === 0`),
 * or one this request could not read at all — and both mean the same thing to this file: the
 * scenario's own runs, exactly as before.
 */
export type SavedBoardPlan = { readonly [D in Direction]?: SavedLegPlan };

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
  /**
   * AT-10 at the end of a day: the van reached the drop-off, the day is over, and no custody
   * event was ever recorded. The *state* is still the arrival and nothing more — that is the
   * rule, and this reason does not touch it — but on a day whose vans are back in the yard the
   * missing handoff is the last open thing about that ride, and a row that sat under "On the
   * way" said the opposite: that it was still happening and would resolve itself.
   */
  "HANDOFF_UNRECORDED",
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
  /**
   * 1, 2, 3 — the number painted on this van's door (src/config/vans.ts), null when no van
   * drives this ride. It is here so a screen can name the van the one way this app names one,
   * "Van 3 · Nadia P.", without inventing a second rule out of the label.
   */
  vanNumber: number | null;
  /** "Nadia P." — who is driving it today, through the one name helper. Null with no van. */
  driverName: string | null;
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
  /**
   * The day's own plan says this child is not riding this leg — the board's Absent group
   * (`plan_assignment.bucket = 'ABSENT'`, per date and per leg). Optional because it is a fact
   * only a saved plan can produce: a scenario ride has nobody to record it.
   */
  notAttending?: boolean;
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

  /*
   * Somebody marked this child away for this leg, which is a decision and the end of the ride.
   * PRD §6.3 gives the system that edge from any pre-boarding state, and it is the first thing
   * asked: a child who is not here needs no van, no capability report and no window.
   */
  if (facts.notAttending) {
    step("CANCELED_ATTENDANCE", "Y");
    return { state, path };
  }

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

type RunSolve = {
  /** The fit verdict, in the vocabulary a row already speaks. */
  status: SolveStatus;
  /** Why it is unknown rather than a yes or a no. */
  pendingReason: string | null;
  capability: CapabilityS;
  departed: boolean;
};

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
  riders: readonly string[],
  setups: VanSetups,
): RunSolve {
  const departed =
    day.phase === "LIVE" && direction === "AM" && frameFor(run, day.instantMs) !== null;
  const checked = day.phase === "ENDED" || departed || recorded;
  const capability = capabilityFor(run, serviceDateIso(new Date(day.instantMs)), checked);
  /*
   * NOTHING ABOUT THIS VAN IS ASSUMED UNTIL SOMEBODY REPORTS IT — the rung that is unchanged.
   * An unobserved vehicle-day is the normal morning answer and is not a refusal (PRD §9): the
   * row says so in the solver's own words rather than claiming a fit either way.
   */
  if (capability.state === "UNKNOWN" || capability.state === "REQUESTED") {
    return {
      status: "CAPABILITY_PENDING",
      pendingReason: solverCopy.pending.unobserved,
      capability: capability.state,
      departed,
    };
  }
  /*
   * AND THE COUNTS ARE THE ONES SOMEBODY SET AT THE RAMP, ELSE THIS VAN'S DEFAULTS — the one
   * shared resolution (src/domain/plan/setup.ts), handed in by the server page.
   *
   * This used to be `feasible()` over the **seeded seating layouts** of
   * src/modules/demo/fixtures/standard.ts, pinned to the run's own `layoutCode`: Van 1 held
   * "1WC/3A", one chair and three seats, whatever the front desk had counted and whatever the
   * plan board was planning it on. That was the second capacity source in Firia's S1 report,
   * and the one the board could not see. The arithmetic is now the fit rule every other surface
   * uses (src/domain/plan/fit.ts), over the counts the board uses, so a plan the board allowed
   * cannot come back as a warning here. The seat-level solver still orders a van's stops; it
   * decides no capacity question on this screen.
   */
  const { setup } = setupFor(setups, run.vehicleKey);
  return {
    status: fits(setup, fitRiders(riders)) ? "FEASIBLE" : "INFEASIBLE",
    pendingReason: null,
    capability: capability.state,
    departed,
  };
}

/**
 * The children on a van as the fit rule reads them — their **approved** needs, through the one
 * function the plan board's own day source reads them with (`needsOfDemoChild`), so a need turned
 * on in the child panel counts the same against a van on both screens.
 */
function fitRiders(riderKeys: readonly string[]): FitRider[] {
  return riderKeys.map((key) => {
    const child = childByKey(key);
    return { token: key, name: child.label, needs: needsOfDemoChild(child) };
  });
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
  agreed: string | null = null,
): EtaView {
  /*
   * A third answer, and it beats both of the two above: the drop-off a coordinator approved. It
   * is not an estimate and not a geometry read — it is the minute the family was promised and the
   * plan was given (`trip_leg.window_start`) — so it is shown as that one time rather than as a
   * published window, and with no shift, because nothing has moved it.
   */
  if (agreed !== null) return { ...NO_ETA, windowText: clockLabel(agreed) };
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

/**
 * THE RUN THIS RIDE IS ON — the saved plan's van, or the scenario's own.
 *
 * With a plan saved for this leg the van is the plan's answer and only the plan's: a child the
 * coordinator moved is on the van they moved them to, and a child the plan puts in Unassigned,
 * with their family or away today is on **no** van at all — which is the same shape as a child
 * the scenario never put on a run, so the ride below takes the one path that already exists for
 * it rather than a second one.
 *
 * A van the fixtures do not have is also no van (`runOfVehicle` returns undefined): a row cannot
 * draw the driver, the layout or the replayed morning of a vehicle this scenario does not run,
 * and showing the seeded van instead would be the old bug with extra steps.
 */
function runFor(child: DemoChild, spot: SavedSpot | undefined): DemoRun | undefined {
  if (spot === undefined) return runOfChild(child.key);
  return spot.bucket === "VAN" ? runOfVehicle(spot.vehicleKey) : undefined;
}

/**
 * Who drives this leg: the van it is actually on.
 *
 * The fixture writes the mode on the child, which is the right answer for the day it describes
 * and the wrong one once a plan has moved somebody: a child on the centre's van rides with the
 * centre, and a child the plan hands back to their family is a family drop-off whatever run
 * they were seeded on. With nothing saved for the leg it is the fixture's own answer, unchanged.
 */
function modeFor(
  child: DemoChild,
  direction: Direction,
  run: DemoRun | undefined,
  spot: SavedSpot | undefined,
): DemoChild["amMode"] {
  const seeded = direction === "AM" ? child.amMode : child.pmMode;
  if (spot === undefined) return seeded;
  if (spot.bucket === "FAMILY_DRIVES") return "FAMILY";
  if (spot.bucket === "VAN" && run) return legModeOf(vehicleOf(run));
  return seeded;
}

/**
 * WHO THIS VAN CARRIES ON THIS LEG — the riders the seating verdict is about.
 *
 * The bug this answers (Firia, 2026-10-18 6:23 AM ET): with the morning saved and every van
 * fit-checked, Today still said "Move Mia R. / Owen C. / Theo V. to a van that fits". The van on
 * the row was the saved plan's, but the solver behind it was still handed the **seeded** run's
 * riders — so Van 3 was being asked whether it holds the three children the scenario put on it,
 * which is a question nobody on that screen had asked since the plan was saved. Three car seats
 * in two tether seats: infeasible, correctly, about a manifest that no longer exists.
 *
 * So the riders are the saved plan's: the children it puts in **this** van on **this** leg, read
 * out of the leg a plan was saved for. One list per (van, leg) — derived from the plan and not
 * from the child whose row it is — so every child on a van gets the one same answer about it,
 * which is what a seating verdict is.
 *
 * The fallback is the seeded run, and only for a ride the saved plan says nothing about: a leg
 * with no plan at all (`plan === undefined`), or a child it does not place, who is on the
 * scenario's own run and must be checked against the scenario's own manifest. Note what is *not*
 * here: nothing is suppressed. A saved van that genuinely does not hold its riders is handed to
 * the same solver and comes back INFEASIBLE, with the same reason and the same step.
 */
function ridersOf(
  run: DemoRun,
  spot: SavedSpot | undefined,
  plan: SavedLegPlan | undefined,
): readonly string[] {
  if (plan === undefined || spot?.bucket !== "VAN") return run.childKeys;
  return boardChildren
    .filter((rider) => {
      const theirs = plan[rider.key];
      return theirs?.bucket === "VAN" && theirs.vehicleKey === spot.vehicleKey;
    })
    .map((rider) => rider.key);
}

function rideFor(
  child: DemoChild,
  direction: Direction,
  day: ServiceDay,
  setups: VanSetups,
  plan?: SavedLegPlan,
  fact?: LegFact,
): RideView {
  const spot = plan?.[child.key];
  const run = runFor(child, spot);
  const mode = modeFor(child, direction, run, spot);
  // The agreed time a decision wrote to this leg, when there is one: it is the planned window
  // now, because a coordinator and a family agreed it and the plan holds it.
  const agreed = agreedDropoffOf(child, direction, fact);
  const onFile = receivingAdultOf(child) !== null || fact?.receiverOnFile === true;
  const base = {
    direction,
    mode,
    plannedWindow: agreed ?? plannedWindow(child, direction),
    stop: stopLabel(child),
  };

  if (!run) {
    const { state, path } = rideStateFrom({
      assigned: false,
      // The one fact a saved plan adds to a ride with no van: away today is not "not planned yet".
      notAttending: spot?.bucket === "ABSENT",
      capability: "UNKNOWN",
      solver: null,
      departed: false,
      pickupArrived: false,
      dropoffArrived: false,
      receivingAdultOnFile: onFile,
      ...NOTHING_REPORTED,
    });
    return {
      ...base,
      state,
      path,
      vehicleLabel: null,
      vanNumber: null,
      driverName: null,
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
  const { status, pendingReason, capability, departed } = solveRun(
    run,
    direction,
    day,
    record !== undefined,
    ridersOf(run, spot, plan),
    setups,
  );
  const frame = departed ? frameFor(run, day.instantMs) : null;
  const ownStop = stopLabel(child);
  const acts = reportedActs(child, record);
  const { state, path } = rideStateFrom({
    assigned: true,
    capability,
    solver: status,
    departed,
    // The child's own stop — which the committed geometry now names, because the replayed track
    // is this run's own morning (src/fixtures/routes.ts). It used to be another run's road, so
    // this could only ever be false and a van's arrival at a kerb was unreadable here.
    pickupArrived:
      frame?.stops.some((s) => s.stopName === ownStop && s.status === "arrived") ?? false,
    dropoffArrived:
      frame?.stops.some((s) => s.stopId === CENTER_STOP_ID && s.status === "arrived") ?? false,
    receivingAdultOnFile: onFile,
    // Last, so a day that recorded its own arrival says so rather than the live frame.
    ...acts,
  });

  return {
    ...base,
    state,
    path,
    vehicleLabel: vehicle.label,
    vanNumber: vanConfigOf(run.vehicleKey)?.slot ?? null,
    driverName: shortName(driverFor(run.vehicleKey)),
    vehicleDescription: vehicle.description,
    providerName: vehicle.providerName,
    providerDispatcher: dispatcher,
    layoutCode: run.layoutCode,
    capability,
    solver: status,
    solverPendingReason: pendingReason,
    receivedBy: record?.receivedBy ?? null,
    ...etaViewFor(child, run, direction, day, agreed),
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
 *
 * The day's own phase is an argument too, for one reason only (`HANDOFF_UNRECORDED`): the same
 * ride state is a handoff about to happen on a board read mid-morning and a handoff nobody
 * recorded on a board read after the last van is in.
 */
function needsActionFor(
  row: BoardRow,
  ride: RideView,
  phase: DayPhase,
): NeedsActionReason[] {
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
    row.receivingAdult === null
  ) {
    reasons.push("NO_RECEIVING_ADULT");
  }
  /*
   * A van that arrived and a day that is over, with no custody event between them (AT-10).
   *
   * The ride's state stays what the machine made of it — ARRIVED_DROPOFF, "Arrived (vehicle)",
   * which is the arrival and not a handoff — and the day is what makes it a thing to do: on the
   * live board an arrival minutes old is a handoff about to be recorded at the kerb, so the row
   * belongs under "On the way" and its step asks for it. Once the vans are in, nobody is going
   * to record it unless this board says so, and a row left under "On the way" on a finished day
   * both reads as still happening and is invisible to "Only needs action" — which is where a
   * coordinator closing out a day looks. The phase is why this is a reason here and not an edge
   * in the machine: nothing about the ride changed, only what is still open about it.
   */
  if (phase === "ENDED" && ride.state === "ARRIVED_DROPOFF") reasons.push("HANDOFF_UNRECORDED");
  if (!held && groupForState(ride.state) === "NEEDS_ACTION") reasons.push("RIDE_STATE");
  if (ride.gpsFreshness === "LOST") reasons.push("LOCATION_LOST");
  return reasons;
}

/** The step each needs-action reason asks for, keyed by the reason the board ranks first. */
const STEP_FOR_REASON: Readonly<Record<NeedsActionReason, NextStep>> = {
  CHILD_HELD: "CALL_CONTACTS",
  DOES_NOT_FIT: "MOVE_TO_FITTING_VAN",
  NO_RECEIVING_ADULT: "RECORD_RECEIVER",
  /** The same step the arrival asks for mid-morning: a person records who received the child. */
  HANDOFF_UNRECORDED: "CONFIRM_HANDOFF",
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
  /*
   * A ride that is over is waiting on nobody — the machine's own terminal list decides, as it
   * does for the needs-action reasons above. On the scenario's own rides this changes nothing
   * (a cancelled or handed-off ride is on a van whose capability was verified, so it fell
   * through to "Nothing to do" anyway); what it answers is the ride a saved plan ends, where a
   * child marked away today would otherwise be told to go and check a van at the ramp.
   */
  if (LEG.terminal.includes(ride.state)) return "NOTHING";
  /*
   * Nobody has given this ride a van: the saved plan leaves the child in Unassigned, and the
   * step is to find them one. Unreachable on the scenario's own day, where every child who
   * rides is on a run and every child who is not rides with their family (above).
   */
  if (ride.vehicleLabel === null) return "FIND_VAN";
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

function rowFor(
  child: DemoChild,
  day: ServiceDay,
  therapy: BoardRow["therapy"],
  saved: SavedBoardPlan,
  setups: VanSetups,
  legFacts: BoardLegFacts = {},
): BoardRow {
  const am = legFacts.AM?.[child.key];
  const pm = legFacts.PM?.[child.key];
  const rides: RideView[] = [
    rideFor(child, "AM", day, setups, saved.AM, am),
    rideFor(child, "PM", day, setups, saved.PM, pm),
  ];
  /*
   * Who may receive this child: the fixture's own file, or the row a decision wrote to it. The
   * receiver is a fact about the child's day and not about one ride (AT-13 is the rule that staff
   * see a missing receiving adult in the morning), so either leg's row answers for both.
   */
  const receiverOnFile = am?.receiverOnFile === true || pm?.receiverOnFile === true;
  return {
    childKey: child.key,
    childLabel: child.label,
    attendance: attendanceFor(child),
    rides,
    receivingAdult: receivingAdultOf(child) ?? (receiverOnFile ? guardianAdultOf(child) : null),
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
  const needsActionReasons = needsActionFor(row, ride, phase);
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
 * The board for one service day (defaulting to the demo day), read against the plan saved for it.
 *
 * `saved` is the coordinator's own decision about who rides where, one entry per leg a plan has
 * been saved for (Firia, 2026-10-17 6:02 PM ET: Today reads the saved plan). Omit it — or hand
 * in a leg nothing was saved for — and that leg is the scenario's own runs, byte for byte what
 * this function returned before there was a plan to read.
 *
 * `setups` is what each van is planned on today — the `CHECKED` row the ramp wrote, else the
 * van's configured default — read on the server through the plan board's own store
 * (`savedSetupsForBoard`) and resolved by the one shared function (src/domain/plan/setup.ts
 * `resolveSetups`), which is what makes this screen's fit check and the board's eligibility one
 * answer rather than two (Firia's S1, 2026-10-18). Omit it and every van is on its default,
 * which is the honest answer for a day nobody has counted a van on — and the answer a session
 * with no centre behind it gets.
 *
 * A day the scenario does not run at all — a weekend — has no rows rather than empty ones: PRD
 * §18.1 schedules the runs Mon–Fri, and a board that showed 28 children with nothing against
 * their names would be inventing a day. The screen says which kind of nothing it is
 * (COPY-GUIDE §5 "No rides scheduled for {date}").
 */
/**
 * WHAT A SAVED LEG SAYS THAT THE SCENARIO CANNOT — one child, one leg, out of `ops.trip_leg`.
 *
 * SOURCE: Firia's 11:11 AM ET ruling of 2026-10-18. An approved drop-off change writes the agreed
 * time to the leg (`modules/plan/leg-write.ts`) and the receiver to the family's file, and this
 * board is computed from a fixture day — so without an overlay the one screen a coordinator
 * checks after pressing Approve would still show the scheduled window and the hold. Same shape
 * and same reason as `SavedBoardPlan` above: the plan a person saved beats the plan the scenario
 * describes, and nothing else about the row changes.
 *
 * `modules/plan/leg-facts.ts` is the read, and it answers `{}` for a session with no centre and a
 * server with no database — which is every browser check, and which is the seeded day exactly as
 * before.
 */
export type LegFact = {
  /** Site-local "HH:MM" from `trip_leg.window_start`, when the leg carries one. */
  readonly dropoffTime?: string | null;
  /** The file has an adult who may receive this child (§6.4 `RECEIVE_CHILD`). */
  readonly receiverOnFile?: boolean;
};

/** The legs of one date, by direction and then by fixture child key. */
export type BoardLegFacts = { readonly [D in Direction]?: Readonly<Record<string, LegFact>> };

/**
 * The time this ride is really planned for: the leg's own, when a decision has moved it off the
 * scheduled window, and otherwise nothing at all.
 *
 * The comparison is what keeps this honest. Every seeded leg carries a `window_start` equal to the
 * child's scheduled window (`demo/seed.ts` writes `clock.at(c.pmWindow)`), so "the leg has a
 * window" is true of all of them and says nothing; what a coordinator needs to see is the one that
 * **somebody changed**. So a leg that still holds its scheduled time is left to the committed
 * geometry, which is the richer answer (a published 10-minute window), and a leg that does not is
 * shown the agreed minute a person approved.
 */
function agreedDropoffOf(
  child: DemoChild,
  direction: Direction,
  fact: LegFact | undefined,
): string | null {
  const time = fact?.dropoffTime ?? null;
  if (time === null || time === plannedWindow(child, direction)) return null;
  return time;
}

export function buildBoard(
  day: ServiceDay = demoDay(),
  saved: SavedBoardPlan = {},
  setups: VanSetups = {},
  legFacts: BoardLegFacts = {},
): Board {
  const therapy = therapyByChild();
  const children = day.scheduled ? boardChildren : [];
  const rows = children.map((child) =>
    rowFor(child, day, therapy.get(child.key) ?? null, saved, setups, legFacts),
  );
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
