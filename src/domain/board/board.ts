/**
 * The Today board, computed (PRD §14 SURF-01, DESIGN-DIRECTION §4.1).
 *
 * One row per child, and every fact on it is an answer from a module that already owns the
 * question:
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
import { SCENARIO_START_MS } from "@/fixtures/replays";
import type { attendanceState, capabilityState, legState } from "@/db/schema";
import {
  childByKey,
  THERAPISTS,
  THERAPY_SESSIONS,
  type Child as DemoChild,
  type Need,
  type Run as DemoRun,
} from "@/modules/demo/fixtures/standard";
import {
  boardChildren,
  capabilityFor,
  CENTER_STOP_ID,
  plannedWindow,
  replayForVehicle,
  runOfChild,
  solverLeg,
  solverVehicle,
  stopLabel,
  vehicleOf,
  type Direction,
} from "./scenario";

type LegS = (typeof legState.enumValues)[number];
type AttendanceS = (typeof attendanceState.enumValues)[number];
type CapabilityS = (typeof capabilityState.enumValues)[number];

/**
 * How far into the committed demo runs the board is read.
 *
 * The replays start at 07:30 ET (`SCENARIO_START_MS`) and 12 minutes in is the instant where
 * the day has something to say in each of the three shapes the modules can produce: one run is
 * standing in the PRD §18.2 step 7 stall and its window has moved, one is inside the step 8 GPS
 * gap and so its texts are paused (LOC-03), and one has no displayable position at all because
 * its device is not bound to it (LOC-01, ADR-013). A fixed instant also makes the board a thing
 * a screenshot can be evidence of.
 */
export const BOARD_SCENARIO_SECONDS = 720;

export function boardInstantMs(): number {
  return SCENARIO_START_MS + BOARD_SCENARIO_SECONDS * 1000;
}

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

/**
 * Which of a child's two rides decides the row's group.
 *
 * Not the earliest and not the worst: the one that is *happening*. A child whose morning van
 * is on the road and whose afternoon van has not been checked yet belongs under "On the way" —
 * filing them under "Getting ready" because of a ride six hours away would hide the van that
 * is moving now. Needs-action is handled before this, because it outranks everything.
 */
const GROUP_BY_ACTIVITY: readonly BoardGroup[] = [
  "NEEDS_ACTION",
  "ON_THE_WAY",
  "GETTING_READY",
  "DONE",
  "NOT_RIDING",
];

/* ───────────────────────────── the row ───────────────────────────── */

/** Why this row is in "Needs action". Codes, so the words stay in the copy module. */
export const NEEDS_ACTION_REASONS = [
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

/** Who the next step belongs to. Roles, never invented people (COPY-GUIDE §1 "name the person"). */
export type NextStepOwner = "COORDINATOR" | "FRONT_DESK" | "PROVIDER" | "FAMILY" | "NOBODY";

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
};

export type NeedView = {
  category: Need["category"];
  state: Need["state"];
  /** PRD VEH-01 / DECISION-LEDGER row 1: only an approved need drives seat allocation. */
  usedForAllocation: boolean;
};

export type BoardRow = {
  childKey: string;
  /** "Mia R." — first name plus last initial, the only child label a staff screen shows (D-3). */
  childLabel: string;
  attendance: AttendanceS;
  rides: readonly RideView[];
  group: BoardGroup;
  needsActionReasons: readonly NeedsActionReason[];
  nextStep: NextStepOwner;
  /** TRP-02: is there an adult on file allowed to receive this child? */
  receivingAdultOnFile: boolean;
  therapy: { therapist: string; startsAt: string } | null;
  needs: readonly NeedView[];
  /** The approved transport profile's version (PRD VEH-01; the seed writes v1, APPROVED). */
  profileVersion: number;
  /** NFR-09: every record carries where its data came from. */
  sourceMode: "SIMULATED";
};

export type BoardGroupView = { group: BoardGroup; rows: readonly BoardRow[] };

export type Board = {
  nowMs: number;
  rows: readonly BoardRow[];
  groups: readonly BoardGroupView[];
  needsActionCount: number;
};

/* ───────────────────────────── the leg machine, walked ───────────────────────────── */

/** What today has observed about one ride, which is all the machine is allowed to move on. */
export type RideFacts = {
  assigned: boolean;
  capability: CapabilityS;
  solver: SolveStatus | null;
  departed: boolean;
  pickupArrived: boolean;
  dropoffArrived: boolean;
};

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
  if (facts.solver !== "FEASIBLE") return { state, path };
  step("MANIFEST_LOCKED", "Y");

  if (!facts.departed) return { state, path };
  step("EN_ROUTE_PICKUP", "P");
  if (!facts.pickupArrived) return { state, path };
  step("ARRIVED_PICKUP", "Y");

  /*
   * And it stops here. Boarding is a person's act, reported at the vehicle and verified at the
   * ramp (PRD §6.3 ARRIVED_PICKUP → BOARDED_REPORTED by a guardian or the provider), and a
   * geofence is not a person: AT-10 is exactly the rule that a vehicle reaching a place may
   * never be read as a child changing hands. The replay can see a vehicle arrive and nothing
   * else, so the board shows the arrival and says no more than that.
   */
  void facts.dropoffArrived;
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

function solveRun(run: DemoRun, direction: Direction, nowMs: number): RunSolve {
  const departed = direction === "AM" && frameFor(run, nowMs) !== null;
  const capability = capabilityFor(run, serviceDateIso(new Date(nowMs)), departed);
  const solve = feasible(solverVehicle(vehicleOf(run)), solverLeg(run, direction), capability);
  return { solve, capability: capability.state, departed };
}

/**
 * The arrival the board shows for an AM ride: the vehicle reaching the centre, which is where
 * every morning run ends and the one stop every committed route has in common. A PM ride has no
 * committed geometry in this slice, so its window is honestly pending rather than borrowed.
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

function etaViewFor(run: DemoRun, direction: Direction, nowMs: number): EtaView {
  if (direction !== "AM") return NO_ETA;
  const frame = frameFor(run, nowMs);
  if (!frame) return NO_ETA;

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

function rideFor(child: DemoChild, direction: Direction, nowMs: number): RideView {
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
    });
    return {
      ...base,
      state,
      path,
      vehicleLabel: null,
      vehicleDescription: null,
      providerName: null,
      layoutCode: null,
      capability: "UNKNOWN",
      solver: null,
      solverPendingReason: null,
      ...NO_ETA,
    };
  }

  const vehicle = solverVehicle(vehicleOf(run));
  const { solve, capability, departed } = solveRun(run, direction, nowMs);
  const frame = direction === "AM" ? frameFor(run, nowMs) : null;
  const ownStop = stopLabel(child);
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
  });

  return {
    ...base,
    state,
    path,
    vehicleLabel: vehicle.label,
    vehicleDescription: vehicle.description,
    providerName: vehicle.providerName,
    layoutCode: run.layoutCode,
    capability,
    solver: solve.status,
    solverPendingReason: solve.pendingReason,
    ...etaViewFor(run, direction, nowMs),
  };
}

/**
 * TRP-02 / PRD §6.6: a child may only be handed to an adult the family has authorized, and the
 * scenario deliberately contains one family with nobody on file (standard.ts: F2 holds every
 * scope except RECEIVE_CHILD). Staff have to know that before the van is at the kerb, not when
 * it gets there, so it is a row on the board from the first screen of the day.
 */
function hasReceivingAdult(child: DemoChild): boolean {
  return child.scopes.includes("RECEIVE_CHILD");
}

function attendanceFor(child: DemoChild): AttendanceS {
  // A child the family brings in themselves is an AM self-drop, which is an attendance fact
  // rather than a ride (PRD ATT-01, §3 "Family drop-off").
  return child.amMode === "FAMILY" ? "AM_SELF_DROP" : "SCHEDULED";
}

function needsActionFor(child: DemoChild, rides: readonly RideView[]): NeedsActionReason[] {
  const reasons: NeedsActionReason[] = [];
  if (rides.some((r) => r.solver === "INFEASIBLE" || r.solver === "VEHICLE_UNAVAILABLE")) {
    reasons.push("DOES_NOT_FIT");
  }
  // Only a ride that ends away from the centre needs an adult waiting at the other end.
  if (rides.some((r) => r.direction === "PM" && r.mode !== "FAMILY") && !hasReceivingAdult(child)) {
    reasons.push("NO_RECEIVING_ADULT");
  }
  if (rides.some((r) => groupForState(r.state) === "NEEDS_ACTION")) reasons.push("RIDE_STATE");
  if (rides.some((r) => r.gpsFreshness === "LOST")) reasons.push("LOCATION_LOST");
  return reasons;
}

/** The ride the row is about right now (see {@link GROUP_BY_ACTIVITY}). */
export function activeRide(rides: readonly RideView[]): RideView {
  for (const group of GROUP_BY_ACTIVITY) {
    const ride = rides.find((r) => groupForState(r.state) === group);
    if (ride) return ride;
  }
  return rides[0];
}

function nextStepFor(ride: RideView, reasons: readonly NeedsActionReason[]): NextStepOwner {
  if (reasons.length > 0) return "COORDINATOR";
  if (ride.mode === "FAMILY") return "FAMILY";
  if (ride.state === "ARRIVED_PICKUP" || ride.state === "IN_TRANSIT") return "FRONT_DESK";
  if (ride.capability === "UNKNOWN" || ride.capability === "REQUESTED") return "PROVIDER";
  return "NOBODY";
}

function rowFor(child: DemoChild, nowMs: number, therapy: BoardRow["therapy"]): BoardRow {
  const rides: RideView[] = [rideFor(child, "AM", nowMs), rideFor(child, "PM", nowMs)];
  const needsActionReasons = needsActionFor(child, rides);
  const active = activeRide(rides);
  const group: BoardGroup =
    needsActionReasons.length > 0
      ? "NEEDS_ACTION"
      : rides.every((r) => r.mode === "FAMILY")
        ? "NOT_RIDING"
        : groupForState(active.state);

  return {
    childKey: child.key,
    childLabel: child.label,
    attendance: attendanceFor(child),
    rides,
    group,
    needsActionReasons,
    nextStep: nextStepFor(active, needsActionReasons),
    receivingAdultOnFile: hasReceivingAdult(child),
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

/** Today's therapy sessions, by child (PRD §18.1: T1 at 09:30, T2 in the afternoon). */
function therapyByChild(): Map<string, BoardRow["therapy"]> {
  const out = new Map<string, BoardRow["therapy"]>();
  for (const session of THERAPY_SESSIONS) {
    const therapist = THERAPISTS.find((t) => t.key === session.therapistKey);
    if (!therapist) continue;
    out.set(session.childKey, { therapist: therapist.label, startsAt: session.start });
  }
  return out;
}

export function buildBoard(nowMs: number = boardInstantMs()): Board {
  const therapy = therapyByChild();
  const rows = boardChildren.map((child) => rowFor(child, nowMs, therapy.get(child.key) ?? null));
  const groups = BOARD_GROUPS.map((group) => ({
    group,
    rows: rows.filter((r) => r.group === group),
  })).filter((g) => g.rows.length > 0);
  return {
    nowMs,
    rows,
    groups,
    needsActionCount: rows.filter((r) => r.group === "NEEDS_ACTION").length,
  };
}

/**
 * The §2 global search, applied to the board: a child, a vehicle or a provider. The shell's
 * search box already submits `?q=` to this page; this is the half that was waiting for a board
 * to search.
 */
export function matchesQuery(row: BoardRow, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return true;
  const haystack = [
    row.childLabel,
    ...row.rides.flatMap((r) => [r.vehicleLabel, r.vehicleDescription, r.providerName, r.stop]),
  ];
  return haystack.some((value) => value !== null && value.toLowerCase().includes(q));
}

/** Child by key, for the drawer. Throws on an unknown key rather than rendering an empty panel. */
export function childOf(key: string): DemoChild {
  return childByKey(key);
}
