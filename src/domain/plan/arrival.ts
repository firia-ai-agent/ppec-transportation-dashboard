/**
 * What a ramp check does to the plan (AT-04: equipment found unknown at arrival).
 *
 * The ramp iPad (SURF-04) used to be a surface that recorded onto itself: staff answered the
 * §4.4 checklist, the capacity solver said whether the run in front of them fitted, and that was
 * where it stopped. The run it was about is on two other screens — the plan a coordinator works
 * from (SURF-05) and the Today board (SURF-01) — and neither of them heard about it. This module
 * is the join: one ramp observation, and the day re-planned around it.
 *
 * What it is **not** is an automatic reassignment. Every placement in here is one the solver
 * agreed to, through the one mover the planning screen uses (`tryMove`), and every one of them
 * is a *proposal*: PRD §9 l.865 gives the afternoon's ramp check to centre staff and the choice
 * that follows to a coordinator ("options … coordinator approves; provider confirms"), and AT-04
 * is that sentence as a test — infeasible before boarding, approval required. So nothing here
 * locks a manifest, tells a family, or touches a child who has boarded.
 *
 * Three rules hold the whole thing together:
 *
 *  - **one day**. The vans, the children, the drivers and the runs are the demo scenario's own
 *    (src/modules/demo/fixtures/standard.ts, through src/domain/plan/day.ts), which is the day
 *    the Today board renders. The ramp iPad, the plan and the board name the same children and
 *    the same vans because there is one fixture under all three.
 *  - **one starting point**. A re-plan starts from the vans the day's runs already put each
 *    child in (`plannedAssignment`), not from a fresh search — so what the screens show is the
 *    *change*, and a child nobody had to move does not move.
 *  - **one check**. Riders are placed by `tryMove`, which asks the solver and hands back nothing
 *    at all when the answer is no. A lane that cannot take a child cannot be given one here.
 *
 * Pure: no clock, no database, no network, no I/O of any kind. The same finding always produces
 * the same re-plan, which is what lets a URL carry one between screens and a screenshot of the
 * result be evidence.
 */
import { formatClock } from "@/domain/eta/eta";
import { demoDay, type ServiceDay } from "@/domain/board/day";
import { plannedStops, solverLeg } from "@/domain/board/scenario";
import {
  ridersInOrder,
  routePlan,
  solveLane,
  tryMove,
  type Assignment,
  type DailyCapability,
  type Direction,
  type Layout,
  type Leg,
  type PlanInput,
  type PlanLane,
  type PlanRider,
  type RoutePlan,
  type SolveResult,
  type SolveStatus,
  type Unplaced,
  type UnplacedCause,
  type Vehicle,
} from "@/domain/solver";
import { RUNS, type Run as DemoRun } from "@/modules/demo/fixtures/standard";
import { places, rampIpad } from "@/ui/copy";
import {
  asMeasured,
  checkedAtRamp,
  layoutByCode,
  planLanes,
  planRiders,
  plannedAssignment,
  vehicleByKey,
} from "./day";

/**
 * The ramp checks the afternoon.
 *
 * PRD §9 l.863–865 puts the two halves of a day in two different pairs of hands: a morning ride
 * is confirmed at the kerb by the provider's driver, and an afternoon ride is checked at the
 * centre's own ramp before the van is released. So the run a ramp check is about is always the
 * afternoon one, and this is the only direction this module plans.
 */
export const RAMP_DIRECTION: Direction = "PM";

/* ───────────────────────────── the vans at the ramp ───────────────────────────── */

/** One van at the ramp, with the afternoon run the check is about. */
export type RampArrival = {
  /** The lane the van is on, which is the van's own key in the day's runs. */
  laneId: string;
  vehicle: Vehicle;
  /** The run's riders, in the order the van drives them. */
  riders: readonly PlanRider[];
  /**
   * The run itself, as the solver reads a manifest: the riders and the stops they board and
   * alight at, in order.
   *
   * The ramp iPad asks `feasible()` about the van in front of it, which is a question about a
   * *run* and not about a list of children — the four constraints are checked per stop, so the
   * order of the stops is part of the question. It comes from the scenario's own run
   * (src/domain/board/scenario.ts `solverLeg`), which is the manifest the board renders, so the
   * iPad cannot be asking about a different afternoon than the one it links to.
   */
  leg: Leg;
  /** The configuration the manifest planned (ASM-17), which is what the checklist opens on. */
  plannedLayoutId: string;
  /** When this van is due to pull away from the centre, epoch ms. */
  leavesMs: number;
  /** The same instant in words, "3:05 PM" — the ramp's own clock, never an arrival window. */
  leavesAt: string;
};

function runOf(laneId: string): DemoRun {
  const run = RUNS.find((r) => r.vehicleKey === laneId);
  if (!run) throw new Error(`no run on the day is driven by ${laneId}`);
  return run;
}

/**
 * The vans at the ramp this afternoon, in the day's own run order.
 *
 * The time on a tile is the plan's, not a fixture's: the committed geometry of the run says when
 * the van leaves the centre (src/fixtures/run-routes.ts, through `plannedStops`), and that is
 * the deadline a ramp check is against. It used to be three hand-written strings in a fixture
 * beside the screen, which could — and did — disagree with the plan every other screen reads.
 */
export function rampArrivals(
  day: ServiceDay = demoDay(),
  direction: Direction = RAMP_DIRECTION,
): RampArrival[] {
  const riders = planRiders(direction);
  return planLanes().map((lane) => {
    const run = runOf(lane.id);
    const leavesMs = plannedStops(run, direction, day)[0]?.etaMs ?? day.instantMs;
    return {
      laneId: lane.id,
      vehicle: lane.vehicle,
      riders: ridersInOrder(riders.filter((rider) => run.childKeys.includes(rider.child.token))),
      leg: solverLeg(run, direction),
      plannedLayoutId: layoutByCode(lane.vehicle, run.layoutCode).id,
      leavesMs,
      leavesAt: formatClock(leavesMs),
    };
  });
}

/* ───────────────────────────── what the ramp found ───────────────────────────── */

/**
 * One ramp check, as a fact about a van rather than as a screen's state.
 *
 * Places are named by their 1-based position in the configuration that arrived — "the second
 * walking seat" — rather than by the solver's position ids. Two reasons: the ids belong to a
 * projection (src/domain/board/scenario.ts mints them per van and layout) and would pin this
 * type to it, and a finding has to survive a trip through a URL, where `V1/1WC/3A·A2` is a
 * paragraph and `2` is a character.
 */
export type RampFinding = {
  /** The van that was checked, by the lane it is on. */
  laneId: string;
  /** The configuration it arrived in, by the code the checklist buttons are built from. */
  layoutCode: string;
  /** Places the ramp found out of service. */
  outOfService: readonly number[];
  /** Places nobody could answer for. Never counted as free (PRD §7 l.797). */
  unanswered: readonly number[];
  /** False when the lift will not work today; null when nobody could say. */
  liftOk: boolean | null;
  /** False when the anchors are unusable; null when nobody could say. */
  latchOk: boolean | null;
  /** Children whose chair the ramp measured, by child key — AT-04's own lever. */
  measured: readonly string[];
};

/** The finding a van that arrived exactly as planned produces: nothing to say. */
export function arrivedAsPlanned(arrival: RampArrival): RampFinding {
  return {
    laneId: arrival.laneId,
    layoutCode: layoutOfId(arrival.vehicle, arrival.plannedLayoutId).code,
    outOfService: [],
    unanswered: [],
    liftOk: true,
    latchOk: true,
    measured: [],
  };
}

function layoutOfId(vehicle: Vehicle, layoutId: string): Layout {
  const layout = vehicle.layouts.find((l) => l.id === layoutId);
  if (!layout) throw new Error(`vehicle ${vehicle.id} has no configuration ${layoutId}`);
  return layout;
}

/** The ids of the places a finding names, in the configuration that arrived. */
function positionIds(layout: Layout, ordinals: readonly number[]): string[] {
  return ordinals.flatMap((n) => {
    const position = layout.positions[n - 1];
    return position ? [position.id] : [];
  });
}

/**
 * The finding as the capability observation for that vehicle-day.
 *
 * Ramp staff checked the van themselves, so the observation is a verified one (PRD §6.3: at the
 * centre it is centre staff who verify) — and it is verified about *what arrived*, which is why
 * the configuration is pinned on it and not searched for.
 */
export function observedCapability(finding: RampFinding): DailyCapability {
  const vehicle = vehicleByKey(finding.laneId);
  const layout = layoutByCode(vehicle, finding.layoutCode);
  return checkedAtRamp(vehicle.id, layout.id, rampIpad.observedBy, {
    liftOk: finding.liftOk,
    latchOk: finding.latchOk,
    unavailablePositionIds: positionIds(layout, finding.outOfService),
    unknownPositionIds: positionIds(layout, finding.unanswered),
  });
}

/**
 * The day as it stands after this check: every van on its lane, the checked one as the ramp
 * found it, and the chairs the ramp measured measured.
 *
 * The other lanes keep the provider's report for the day, which is the honest basis for a
 * proposal: PRD §9 calls a reported van "provisionally feasible", and a coordinator approving a
 * move is approving exactly that. A van nobody has reported on takes nobody, here as everywhere
 * (VEH-04) — unknown is never read as a yes.
 */
export function arrivalInput(
  finding: RampFinding,
  direction: Direction = RAMP_DIRECTION,
): PlanInput {
  const observed = observedCapability(finding);
  const lanes: PlanLane[] = planLanes().map((lane) =>
    lane.id === finding.laneId ? { ...lane, capability: observed } : lane,
  );
  const riders = planRiders(direction).map((rider) =>
    finding.measured.includes(rider.child.token) ? asMeasured(rider) : rider,
  );
  return { direction, centerLabel: places.center, lanes, riders };
}

/* ───────────────────────────── the re-plan ───────────────────────────── */

/** A child the solver moved to another van, and the van it agreed to. */
export type ArrivalMove = {
  childToken: string;
  childLabel: string;
  fromLaneId: string;
  toLaneId: string;
};

/** A child no van on the day can take, and the one thing that is missing. */
export type ArrivalHold = {
  childToken: string;
  childLabel: string;
  fromLaneId: string;
  cause: UnplacedCause;
  /** The §9 options a coordinator can choose from, ranked, each needing their approval. */
  unplaced: Unplaced;
};

export type ArrivalReplan = {
  finding: RampFinding;
  direction: Direction;
  /** The day the moves were checked against. */
  input: PlanInput;
  /** The vans the day's runs had everyone in, before this van arrived. */
  before: Assignment;
  /** The same day with the checked van's riders re-placed by the solver. */
  after: Assignment;
  /** Every lane as the solver sees it now, and every child in no van, with reasons. */
  plan: RoutePlan;
  moves: readonly ArrivalMove[];
  holds: readonly ArrivalHold[];
  /** Riders of the checked van the van still fits, in drive order. */
  stays: readonly string[];
  /** Did this check change anything at all? */
  changed: boolean;
};

/**
 * How hard a rider is to place, hardest first: a chair, then a child who needs an anchored seat,
 * then a plain seat.
 *
 * The same order the planner uses (src/domain/solver/plan.ts), for the same reason: filling a
 * van with walking riders first leaves its wheelchair place intact and the seats the chair's
 * attendant needed gone. Here it decides who *keeps* their van — the children with the fewest
 * vans to go to are asked about first.
 */
function hardestFirst(riders: readonly PlanRider[]): PlanRider[] {
  const weight = (rider: PlanRider) =>
    rider.child.mobility === "WC" ? 3 : rider.child.tether ? 2 : 1;
  return [...riders]
    .map((rider, index) => ({ rider, index }))
    .sort(
      (a, b) =>
        weight(b.rider) - weight(a.rider) ||
        a.rider.window.localeCompare(b.rider.window) ||
        a.index - b.index,
    )
    .map(({ rider }) => rider);
}

function ridersOf(input: PlanInput, tokens: readonly string[]): PlanRider[] {
  const byToken = new Map(input.riders.map((rider) => [rider.child.token, rider]));
  return tokens.flatMap((token) => {
    const rider = byToken.get(token);
    return rider ? [rider] : [];
  });
}

/**
 * The day, re-planned around one van as it arrived.
 *
 * Only the checked van's riders are touched. Its lane is emptied and offered back to them
 * hardest-to-place first — each one through `tryMove`, so a seat is only kept if the solver
 * says the van as observed still holds them with the others aboard — and a rider it refuses is
 * offered the day's other vans in the day's own lane order. The first van that accepts them gets
 * them; a rider no van accepts stays in none, and comes back with the reason and the §9 options
 * from `routePlan`, which is the same answer the planning screen reads for a child it could not
 * place.
 *
 * Nobody else's placement changes. A coordinator reading two screens is reading one day, and a
 * ramp check that quietly re-shuffled two other vans would be a diff nobody could follow — the
 * PRD is blunt about the stronger version of this (l.876: a change after boarding gets no
 * automatic re-plan at all, and never an instruction to unload).
 */
export function replanForArrival(
  finding: RampFinding,
  direction: Direction = RAMP_DIRECTION,
): ArrivalReplan {
  const input = arrivalInput(finding, direction);
  const before = plannedAssignment(direction);
  const checked = input.lanes.find((lane) => lane.id === finding.laneId);
  if (!checked) throw new Error(`no lane on the day is ${finding.laneId}`);

  const planned = ridersOf(input, before[finding.laneId] ?? []);
  // The lane as a blank sheet: its own riders are the only ones being asked about, and asking
  // "does this van still hold you" of a van that is already over its places answers about the
  // crowd rather than about the child.
  let after: Assignment = { ...before, [finding.laneId]: [] };

  const stays: string[] = [];
  const movedOrHeld: PlanRider[] = [];
  for (const rider of hardestFirst(planned)) {
    const kept = tryMove(input, after, rider.child.token, finding.laneId);
    if (kept.ok) {
      after = kept.assignment;
      stays.push(rider.child.token);
      continue;
    }
    movedOrHeld.push(rider);
  }

  const moves: ArrivalMove[] = [];
  const unmoved: PlanRider[] = [];
  for (const rider of movedOrHeld) {
    let moved: string | null = null;
    for (const lane of input.lanes) {
      if (lane.id === finding.laneId) continue;
      const result = tryMove(input, after, rider.child.token, lane.id);
      if (!result.ok) continue;
      after = result.assignment;
      moved = lane.id;
      break;
    }
    if (moved === null) {
      unmoved.push(rider);
      continue;
    }
    moves.push({
      childToken: rider.child.token,
      childLabel: rider.child.displayName,
      fromLaneId: finding.laneId,
      toLaneId: moved,
    });
  }

  const plan = routePlan(input, after);
  const holds: ArrivalHold[] = unmoved.flatMap((rider) => {
    const unplaced = plan.unplaced.find((row) => row.rider.child.token === rider.child.token);
    if (!unplaced) return [];
    return [
      {
        childToken: rider.child.token,
        childLabel: rider.child.displayName,
        fromLaneId: finding.laneId,
        cause: unplaced.cause,
        unplaced,
      },
    ];
  });

  return {
    finding,
    direction,
    input,
    before,
    after,
    plan,
    moves,
    holds,
    stays: ridersInOrder(ridersOf(input, stays)).map((rider) => rider.child.token),
    changed: moves.length > 0 || holds.length > 0,
  };
}

/**
 * The verdict for the van as it arrived, with the riders the day planned into it.
 *
 * The question the ramp asks, and the one the re-plan above is the answer to. Kept apart from
 * the re-planned lane so a screen can say both things: this is what arrived and what it means
 * for the run as it was planned, and this is what the solver would do about it.
 */
export function arrivedVerdict(replan: ArrivalReplan): SolveStatus {
  return arrivedResult(replan).status;
}

/**
 * The same verdict in full: the configuration it was reached in, the per-stop plan, the deficit
 * and the §9 options a coordinator could choose from.
 *
 * The ramp iPad's sticky bar needs all of it, and this is why it exists. The bar used to ask
 * `feasible()` a second question of its own — the van in front of it, with the children's
 * *on-file* chair measurements — while the panel below it read the re-plan, which is the same
 * question asked with what the ramp actually measured. So a chair measured bigger than the file
 * said left the bar saying "Fits: 1 wheelchair, 3 walking seats" over a panel saying the child
 * does not fit, and the boarding lock followed the bar: "Confirm boarding & securement" was
 * live for a run the solver had already refused (Veri's review of 53423de, 2026-10-17). One
 * computation now answers all three, so they cannot disagree.
 *
 * `withOptions` is on because the bar lists them behind "Show details", and the alternates are
 * the day's own other lanes as the day has them (`before`) rather than a set assembled by the
 * screen — the same vans the re-plan would move a rider to.
 */
export function arrivedResult(replan: ArrivalReplan): SolveResult {
  const { input, finding, before } = replan;
  const lane = input.lanes.find((l) => l.id === finding.laneId);
  if (!lane) throw new Error(`no lane on the day is ${finding.laneId}`);
  return solveLane(input, lane, ridersOf(input, before[finding.laneId] ?? []), {
    withOptions: true,
    assignment: before,
  });
}

/* ───────────────────────────── the board's half ───────────────────────────── */

/** What a ramp check changed about one child's ride. */
export type RideChange =
  | { kind: "MOVED"; fromLaneId: string; toLaneId: string }
  | { kind: "HELD"; fromLaneId: string; cause: UnplacedCause }
  | { kind: "CHECKED"; laneId: string };

/**
 * One ramp check in the shape the Today board reads: which van was checked, and what happened
 * to each child whose ride it was about.
 *
 * The board does not re-plan — it shows a day — so what reaches it is the *outcome* and not the
 * planner. A ride on the checked van that nobody had to move is `CHECKED`: the one fact that
 * changed about it is that somebody has now seen the van, which is what lets its row stop saying
 * "nobody has checked this van today".
 */
export type BoardArrival = {
  direction: Direction;
  /** The van the ramp checked. */
  laneId: string;
  /** The configuration it arrived in, by code. */
  layoutCode: string;
  /** Per child key: what this check did to their ride. */
  changes: ReadonlyMap<string, RideChange>;
  /** The configuration each lane now carries its riders in, by lane id. */
  layoutCodes: ReadonlyMap<string, string>;
  /** Each lane's verdict after the re-plan, by lane id. */
  verdicts: ReadonlyMap<string, SolveStatus>;
};

export function boardArrival(replan: ArrivalReplan): BoardArrival {
  const changes = new Map<string, RideChange>();
  for (const token of replan.stays) {
    changes.set(token, { kind: "CHECKED", laneId: replan.finding.laneId });
  }
  for (const move of replan.moves) {
    changes.set(move.childToken, {
      kind: "MOVED",
      fromLaneId: move.fromLaneId,
      toLaneId: move.toLaneId,
    });
  }
  for (const hold of replan.holds) {
    changes.set(hold.childToken, {
      kind: "HELD",
      fromLaneId: hold.fromLaneId,
      cause: hold.cause,
    });
  }
  return {
    direction: replan.direction,
    laneId: replan.finding.laneId,
    layoutCode: replan.finding.layoutCode,
    changes,
    layoutCodes: new Map(replan.plan.lanes.map((lane) => [lane.lane.id, lane.layout.code])),
    verdicts: new Map(replan.plan.lanes.map((lane) => [lane.lane.id, lane.verdict.status])),
  };
}

/* ───────────────────────────── carrying one between screens ───────────────────────────── */

/**
 * A finding as one query parameter, so the ramp iPad can hand its result to the plan and to the
 * board by linking to them.
 *
 * Why a link and not a store: this slice has no database behind these screens (ADR-015 keeps the
 * demo synthetic, and the ramp iPad writes nothing), and a ramp check that only existed in one
 * tab's memory could not be shown on another screen at all. A link is also the honest shape for
 * a proposal — it is a thing a coordinator opens, reads and decides about — and it makes the
 * walk-through reproducible: the same URL always renders the same day.
 *
 * The code is not copy and never reaches a screen: it is a parameter, like `?q=` and `?date=`,
 * and every screen that reads one renders it through `decodeFinding`, which answers `null` for
 * anything it does not recognise rather than guessing (the same rule the board's date override
 * follows: an unreadable parameter is a parameter nothing reads).
 */
const FIELD = "~";
const LIST = ",";

export function encodeFinding(finding: RampFinding): string {
  const parts = [finding.laneId, finding.layoutCode];
  if (finding.outOfService.length > 0) parts.push(`out=${finding.outOfService.join(LIST)}`);
  if (finding.unanswered.length > 0) parts.push(`unsure=${finding.unanswered.join(LIST)}`);
  if (finding.measured.length > 0) parts.push(`measured=${finding.measured.join(LIST)}`);
  if (finding.liftOk !== true) parts.push(`lift=${finding.liftOk === false ? "no" : "unsure"}`);
  if (finding.latchOk !== true) parts.push(`latch=${finding.latchOk === false ? "no" : "unsure"}`);
  return parts.join(FIELD);
}

function ordinals(value: string, layout: Layout): number[] | null {
  const out: number[] = [];
  for (const piece of value.split(LIST)) {
    const n = Number(piece);
    if (!Number.isInteger(n) || n < 1 || n > layout.positions.length) return null;
    if (!out.includes(n)) out.push(n);
  }
  return out;
}

function answer(value: string): boolean | null | undefined {
  if (value === "no") return false;
  if (value === "unsure") return null;
  return undefined;
}

/**
 * A finding back from a URL, or `null` for anything this day cannot be about: a van that is on
 * no lane, a configuration that van is not built with, a place it does not have, a child who is
 * not riding it.
 */
export function decodeFinding(
  code: string | undefined | null,
  direction: Direction = RAMP_DIRECTION,
): RampFinding | null {
  if (!code) return null;
  const [laneId, layoutCode, ...rest] = code.split(FIELD);
  const lane = planLanes().find((l) => l.id === laneId);
  if (!lane || !layoutCode) return null;
  const layout = lane.vehicle.layouts.find((l) => l.code === layoutCode);
  if (!layout) return null;

  const finding: RampFinding = {
    laneId,
    layoutCode,
    outOfService: [],
    unanswered: [],
    liftOk: true,
    latchOk: true,
    measured: [],
  };
  const onThisVan = new Set(plannedAssignment(direction)[laneId] ?? []);
  for (const field of rest) {
    const at = field.indexOf("=");
    if (at < 0) return null;
    const key = field.slice(0, at);
    const value = field.slice(at + 1);
    if (key === "out" || key === "unsure") {
      const list = ordinals(value, layout);
      if (!list) return null;
      if (key === "out") finding.outOfService = list;
      else finding.unanswered = list;
      continue;
    }
    if (key === "measured") {
      const tokens = value.split(LIST);
      if (tokens.some((token) => !onThisVan.has(token))) return null;
      finding.measured = tokens;
      continue;
    }
    if (key === "lift" || key === "latch") {
      const ok = answer(value);
      if (ok === undefined) return null;
      if (key === "lift") finding.liftOk = ok;
      else finding.latchOk = ok;
      continue;
    }
    return null;
  }
  return finding;
}

/** The query parameter the three screens carry a ramp check in. */
export const ARRIVAL_PARAM = "arrival";
