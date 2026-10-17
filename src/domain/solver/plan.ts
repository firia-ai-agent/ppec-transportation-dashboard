/**
 * Planning the day's vans over the capacity solver (PRD §7, §9; VEH-01…05; B-09).
 *
 * `feasible()` answers one question: does *this* run fit *this* vehicle today. A coordinator
 * planning the morning asks a different one — which van does each child ride in, and who is
 * left without one — and nothing in this repo answered it before. This module is that answer,
 * and it is the solver's answer: every placement here is one the solver called FEASIBLE, and
 * every refusal is a deficit the solver reported. Nothing is assigned by a rule of thumb that
 * the four constraints did not agree with.
 *
 * What it adds, in PRD terms:
 *  - VEH-03 over a *fleet* rather than one vehicle: a lane per van, riders placed into it only
 *    when the per-stop constraints hold with them aboard;
 *  - VEH-04, unknown until arrival: a van nobody has reported on takes nobody, and a rider who
 *    only fits that van is unplaced *for that reason* rather than quietly dropped — unknown is
 *    never read as a yes, here either;
 *  - VEH-05, substitution: the screen swaps the vehicle on a lane and hands this module the new
 *    vehicle with an UNKNOWN observation; re-solving is just calling it again;
 *  - AT-12, no feasible vehicle: the rider lands in `unplaced` with the missing equipment named
 *    and the §9 option set attached, every option marked as needing a human. This module
 *    assigns nothing on its own authority and never proposes moving a boarded child.
 *
 * Pure and deterministic: no database, no clock, no network, no LLM. The same inputs always
 * give the same plan, which is what makes a screenshot of the screen evidence rather than a
 * moment (and what lets the e2e checks assert on it at all).
 */
import { fill, layoutName, solver as solverCopy, vanName } from "@/ui/copy";
import { OPTION_RANK, feasible, onboardByStop } from "./feasible";
import type { AlternateCandidate } from "./feasible";
import type {
  AmbSeat, Child, DailyCapability, Deficit, DeficitType, Layout, Leg, ManifestStop,
  ResolutionOption, SolveResult, Vehicle, WcPosition,
} from "./types";

/* ───────────────────────────── inputs ───────────────────────────── */

/**
 * One van the day is planned with: the vehicle, what today's observation says it can carry, and
 * the driver on it.
 *
 * `id` is the lane's own identity and not the vehicle's, because the whole point of AT-05 is
 * that the vehicle on a lane changes: the provider sends a different van, and the children
 * planned into that lane are still the same children with the same stops. Keying on the vehicle
 * would lose the lane the moment it was substituted.
 */
export type PlanLane = {
  id: string;
  vehicle: Vehicle;
  capability: DailyCapability;
  /** First name + last initial, like every other person on a screen in this app. */
  driverName: string;
};

/** A child to place, with the stop the day gives them and the window it is planned for. */
export type PlanRider = {
  child: Child;
  /** The landmark where this child is picked up (AM) or set down (PM), in words. */
  stopLabel: string;
  /** "07:10", site-local. The order a lane's stops are driven in. */
  window: string;
};

export type Direction = "AM" | "PM";

export type PlanInput = {
  direction: Direction;
  /** Where a morning run ends and an afternoon run starts, in words (never an address). */
  centerLabel: string;
  lanes: readonly PlanLane[];
  riders: readonly PlanRider[];
};

/** Lane id → the child tokens in it. A token in no list is a rider in no van. */
export type Assignment = Readonly<Record<string, readonly string[]>>;

/* ───────────────────────────── outputs ───────────────────────────── */

/** Places at the busiest stop of a lane: how many are taken, how many today's van has. */
export type LaneSeats = {
  wcUsed: number;
  wcAvailable: number;
  ambUsed: number;
  ambAvailable: number;
  tetherUsed: number;
  tetherAvailable: number;
};

export type LanePlan = {
  lane: PlanLane;
  /** Riders in the order their stops are driven. */
  riders: readonly PlanRider[];
  leg: Leg;
  verdict: SolveResult;
  seats: LaneSeats;
  /** The configuration the counts above are measured against. */
  layout: Layout;
};

/**
 * Why a child is in no van. Every one of these becomes a plain sentence that names the child
 * and the thing that is missing (src/ui/copy.ts `planRoutes.reason`) — never a deficit code.
 */
export type UnplacedCause =
  /** No van has a wheelchair place that is usable today. */
  | "NO_WC_PLACE"
  /** Places exist, none with this chair's securement hardware. */
  | "NO_SECUREMENT"
  /** Right hardware, and the chair is larger than the place accepts. */
  | "CHAIR_TOO_LARGE"
  /** A wheelchair rider boards by lift and no van has a working one. */
  | "NO_LIFT"
  /** No van has a free seat with a tether / LATCH anchor. */
  | "NO_ANCHORED_SEAT"
  /** No van has a free seat at all. */
  | "NO_SEAT"
  /** Some van fits this child, and every one of them is full. */
  | "VANS_FULL"
  /** The only van that fits them has not been reported on yet (PRD §9, VEH-04). */
  | "UNKNOWN_UNTIL_ARRIVAL"
  /** There is no van on the day to ask about. */
  | "NO_VEHICLE"
  /** Nobody has put them in a van yet: a plan has not been run, or staff took them out of one. */
  | "NOT_IN_A_VAN";

export type Unplaced = {
  rider: PlanRider;
  cause: UnplacedCause;
  /** The lane the cause is about, when exactly one van is: the only fit, or the unchecked one. */
  laneId: string | null;
  /** Ranked §9 options, each one needing a named human (AT-12). Empty for NOT_IN_A_VAN. */
  options: readonly ResolutionOption[];
};

export type RoutePlan = {
  direction: Direction;
  lanes: readonly LanePlan[];
  /** Children in no van, in the day's own rider order. */
  unplaced: readonly Unplaced[];
};

/** The answer to "can this lane take this child": yes, or the one thing that is missing. */
export type MoveCheck =
  | { ok: true }
  | { ok: false; cause: UnplacedCause };

/* ───────────────────────────── the manifest ───────────────────────────── */

/**
 * The riders of one lane in the order the van drives them: earliest window first.
 *
 * Stable, so two children with the same window (a pair of siblings sharing a stop) keep the
 * order the day hands them in rather than swapping between renders.
 */
export function ridersInOrder(riders: readonly PlanRider[]): PlanRider[] {
  return [...riders].sort((a, b) => a.window.localeCompare(b.window));
}

/**
 * One lane's manifest for one direction.
 *
 * AM picks the children up at their own stops, earliest window first, and sets everyone down at
 * the centre; PM is the reverse — everyone boards at the centre and is set down in window
 * order. The order of the stops *is* the question the solver is asked: its constraints are
 * checked per stop over On_k, so a van that fits three children one at a time can still fail at
 * the stop where all three are aboard.
 */
export function buildManifest(
  direction: Direction,
  riders: readonly PlanRider[],
  centerLabel: string,
): ManifestStop[] {
  const ordered = ridersInOrder(riders);
  const centre = { label: centerLabel };
  if (direction === "AM") {
    return [
      ...ordered.map((rider, i) => ({
        k: i + 1,
        label: rider.stopLabel,
        boarding: [rider.child.token],
        staffEscorts: 0,
      })),
      {
        k: ordered.length + 1,
        ...centre,
        alighting: ordered.map((r) => r.child.token),
        staffEscorts: 0,
      },
    ];
  }
  return [
    { k: 1, ...centre, boarding: ordered.map((r) => r.child.token), staffEscorts: 0 },
    ...ordered.map((rider, i) => ({
      k: i + 2,
      label: rider.stopLabel,
      alighting: [rider.child.token],
      staffEscorts: 0,
    })),
  ];
}

export function buildLeg(
  id: string,
  direction: Direction,
  riders: readonly PlanRider[],
  centerLabel: string,
): Leg {
  const ordered = ridersInOrder(riders);
  return {
    id,
    direction,
    manifestId: id,
    // Null on purpose: before the van arrives nobody has fixed its configuration, so the solver
    // searches L(v). A reported or verified observation pins it (DailyCapability.observedLayoutId)
    // and takes precedence, which is ASM-17 arriving at the moment it is actually true.
    layoutId: null,
    children: ordered.map((r) => r.child),
    stops: buildManifest(direction, ordered, centerLabel),
  };
}

/* ───────────────────────────── places and needs ───────────────────────────── */

function isWcPosition(p: Layout["positions"][number]): p is WcPosition {
  return p.kind === "WC";
}
function isAmbSeat(p: Layout["positions"][number]): p is AmbSeat {
  return p.kind === "AMB";
}

export type Places = { wc: number; amb: number; tether: number };

/**
 * The places one configuration has today. "Not sure" is never counted as free, which is the
 * same rule the solver applies (PRD §7 l.797) and the reason these counts are not just a
 * property of the layout.
 */
export function layoutPlaces(layout: Layout, capability: DailyCapability): Places {
  const unavailable = new Set(capability.unavailablePositionIds);
  const unknown = new Set(capability.unknownPositionIds ?? []);
  const usable = layout.positions.filter((p) => !unavailable.has(p.id) && !unknown.has(p.id));
  return {
    wc: usable.filter(isWcPosition).length,
    amb: usable.filter(isAmbSeat).length,
    // latchOk === false empties T_l; null is "not reported", and an unreported anchor is not a
    // free one, so it counts as zero here too.
    tether: capability.latchOk === true ? usable.filter(isAmbSeat).filter((s) => s.tetherCapable).length : 0,
  };
}

/** Peak places a run needs across its manifest: chairs, seats (riders + escorts + staff), anchors. */
export function peakNeed(leg: Leg): Places {
  const stops = onboardByStop(leg);
  const peak = (pick: (stop: (typeof stops)[number]) => number) => Math.max(0, ...stops.map(pick));
  return {
    wc: peak((s) => s.onboard.filter((c) => c.mobility === "WC").length),
    amb: peak(
      (s) =>
        s.onboard.filter((c) => c.mobility === "AMB").length +
        s.onboard.filter((c) => c.escort).length +
        s.staffEscorts,
    ),
    tether: peak((s) => s.onboard.filter((c) => c.tether).length),
  };
}

function layoutById(vehicle: Vehicle, id: string): Layout {
  const layout = vehicle.layouts.find((l) => l.id === id);
  if (!layout) throw new Error(`vehicle ${vehicle.id} has no layout ${id}`);
  return layout;
}

/**
 * The configuration a lane's seat counts are measured against.
 *
 * In order of how much the day actually knows: the one the solver found room in; the one the
 * provider or the ramp says the van arrived in; the one the manifest fixed; and failing all
 * three, the first configuration that is built with enough wheelchair places for this run — a
 * 0WC configuration says nothing useful about a lane with a chair in it. A van with no
 * configuration at all cannot carry anybody and has no counts to show, so that is a throw
 * rather than a zero.
 */
export function plannedLayout(lane: PlanLane, leg: Leg, verdict: SolveResult): Layout {
  if (verdict.layout) return layoutById(lane.vehicle, verdict.layout.id);
  const pinned = lane.capability.observedLayoutId ?? leg.layoutId ?? null;
  if (pinned !== null) return layoutById(lane.vehicle, pinned);
  if (lane.vehicle.layouts.length === 0) {
    throw new Error(`vehicle ${lane.vehicle.id} has no configuration to plan with`);
  }
  const need = peakNeed(leg);
  return (
    lane.vehicle.layouts.find((l) => l.positions.filter(isWcPosition).length >= need.wc) ??
    lane.vehicle.layouts[0]
  );
}

/** Used against available, for the chips on the lane header. */
export function laneSeats(lane: PlanLane, leg: Leg, verdict: SolveResult): LaneSeats {
  const layout = plannedLayout(lane, leg, verdict);
  const places = layoutPlaces(layout, lane.capability);
  const need = peakNeed(leg);
  return {
    wcUsed: need.wc,
    wcAvailable: places.wc,
    ambUsed: need.amb,
    ambAvailable: places.amb,
    tetherUsed: need.tether,
    tetherAvailable: places.tether,
  };
}

/* ───────────────────────────── solving one lane ───────────────────────────── */

function ridersOf(input: PlanInput, tokens: readonly string[]): PlanRider[] {
  const byToken = new Map(input.riders.map((r) => [r.child.token, r]));
  return tokens.flatMap((token) => {
    const rider = byToken.get(token);
    return rider ? [rider] : [];
  });
}

function legOf(input: PlanInput, lane: PlanLane, riders: readonly PlanRider[]): Leg {
  return buildLeg(`${lane.id}/${input.direction}`, input.direction, riders, input.centerLabel);
}

/**
 * The other lanes as the solver's alternate candidates, so an INFEASIBLE lane comes back with
 * "Move to V2" already checked against V2's own load rather than as a guess.
 */
function alternatesFor(input: PlanInput, assignment: Assignment, exceptLaneId: string): AlternateCandidate[] {
  return input.lanes
    .filter((lane) => lane.id !== exceptLaneId)
    .map((lane) => {
      const riders = ridersOf(input, assignment[lane.id] ?? []);
      return {
        vehicle: lane.vehicle,
        capability: lane.capability,
        leg: legOf(input, lane, riders),
      };
    });
}

/**
 * One lane's verdict. `withOptions` is off while a plan is being searched — the ranked options
 * are for a human to read, and generating them for every candidate placement would solve the
 * whole fleet once per rider per lane for an answer nobody looks at.
 */
export function solveLane(
  input: PlanInput,
  lane: PlanLane,
  riders: readonly PlanRider[],
  opts: { withOptions?: boolean; assignment?: Assignment } = {},
): SolveResult {
  const leg = legOf(input, lane, riders);
  const alternates = opts.withOptions && opts.assignment
    ? alternatesFor(input, opts.assignment, lane.id)
    : [];
  return feasible(lane.vehicle, leg, lane.capability, { alternates });
}

/* ───────────────────────────── why a child has no van ───────────────────────────── */

const CAUSE_BY_DEFICIT: Record<DeficitType, UnplacedCause> = {
  LIFT: "NO_LIFT",
  WC_SECUREMENT: "NO_SECUREMENT",
  WC_FOOTPRINT: "CHAIR_TOO_LARGE",
  TETHER_SEAT: "NO_ANCHORED_SEAT",
  WC_POSITION: "NO_WC_PLACE",
  AMBULATORY_SEAT: "NO_SEAT",
};

/**
 * Which missing thing is *the* reason when the vans disagree about why they cannot take a child.
 *
 * The van that came closest names the reason, which is the reverse of the PRD's constraint
 * order: a sedan asked to carry a wheelchair rider always answers "no wheelchair place", which
 * is true of a sedan and tells a coordinator nothing they can act on, while the van whose
 * position is the right hardware and two centimetres too short is naming the thing to measure
 * or to ask the provider about. A lift failure comes first because reaching it means everything
 * else about that van already matched.
 */
const CAUSE_PREFERENCE: readonly DeficitType[] = [
  "LIFT", "WC_FOOTPRINT", "WC_SECUREMENT", "TETHER_SEAT", "WC_POSITION", "AMBULATORY_SEAT",
];

/** The cause a reported deficit becomes, so a screen never has to read a deficit type. */
export function causeOfDeficit(type: DeficitType): UnplacedCause {
  return CAUSE_BY_DEFICIT[type];
}

function headlineDeficit(deficits: readonly Deficit[]): DeficitType | null {
  for (const type of CAUSE_PREFERENCE) {
    if (deficits.some((d) => d.type === type)) return type;
  }
  return null;
}

/**
 * Can this lane take this child on top of what it already carries? The answer is the solver's,
 * and when it is no, the cause separates "this van is not built for this child" from "this van
 * is full" — two refusals a coordinator does very different things about.
 */
export function canTake(
  input: PlanInput,
  assignment: Assignment,
  laneId: string,
  childToken: string,
): MoveCheck {
  const lane = input.lanes.find((l) => l.id === laneId);
  if (!lane) return { ok: false, cause: "NO_VEHICLE" };
  const rider = input.riders.find((r) => r.child.token === childToken);
  if (!rider) return { ok: false, cause: "NO_VEHICLE" };
  const already = ridersOf(input, (assignment[laneId] ?? []).filter((t) => t !== childToken));
  const loaded = solveLane(input, lane, [...already, rider]);
  if (loaded.status === "FEASIBLE") return { ok: true };
  if (loaded.status === "CAPABILITY_PENDING") return { ok: false, cause: "UNKNOWN_UNTIL_ARRIVAL" };
  if (loaded.status === "VEHICLE_UNAVAILABLE") return { ok: false, cause: "NO_VEHICLE" };

  // INFEASIBLE. Is it this child's equipment, or is the van simply out of places? Asking the
  // same van about this child alone separates the two, and only the second one is fixed by
  // moving somebody else.
  const alone = solveLane(input, lane, [rider]);
  if (alone.status === "FEASIBLE") return { ok: false, cause: "NO_SEAT" };
  if (alone.status === "CAPABILITY_PENDING") return { ok: false, cause: "UNKNOWN_UNTIL_ARRIVAL" };
  const type = headlineDeficit(alone.deficits.length > 0 ? alone.deficits : loaded.deficits);
  return { ok: false, cause: type ? CAUSE_BY_DEFICIT[type] : "NO_VEHICLE" };
}

/** Why this child is in no van, read across every lane the day has. */
function whyUnplaced(
  input: PlanInput,
  assignment: Assignment,
  rider: PlanRider,
): { cause: UnplacedCause; laneId: string | null } {
  if (input.lanes.length === 0) return { cause: "NO_VEHICLE", laneId: null };

  const perLane = input.lanes.map((lane) => ({
    lane,
    loaded: canTake(input, assignment, lane.id, rider.child.token),
    alone: solveLane(input, lane, [rider]),
  }));

  // Somewhere to go, and nobody has put them there: a plan that has not been run, or a child a
  // coordinator took out of a van on purpose. Not a capacity fact, and not dressed up as one.
  const open = perLane.find((l) => l.loaded.ok);
  if (open) return { cause: "NOT_IN_A_VAN", laneId: open.lane.id };

  const fitsEmpty = perLane.find((l) => l.alone.status === "FEASIBLE");
  if (fitsEmpty) return { cause: "VANS_FULL", laneId: fitsEmpty.lane.id };

  const unchecked = perLane.find((l) => l.alone.status === "CAPABILITY_PENDING");
  if (unchecked) return { cause: "UNKNOWN_UNTIL_ARRIVAL", laneId: unchecked.lane.id };

  const type = headlineDeficit(perLane.flatMap((l) => l.alone.deficits));
  return { cause: type ? CAUSE_BY_DEFICIT[type] : "NO_VEHICLE", laneId: null };
}

/* ───────────────────────────── what a human can choose ───────────────────────────── */

/**
 * The PRD §9 option set for a child with no van (AT-12), ranked in the PRD's own order and each
 * one requiring a named human: the solver proposes, a coordinator decides, and the family hears
 * nothing until then.
 *
 * Two of the six are deliberately absent. SPLIT_RUN needs a run to split and this child is on
 * none; ALTERNATE_PROVIDER needs a provider to ask and a van to name, and the only vans this
 * screen knows about are the day's own lanes — asking another provider is a conversation, and
 * it belongs to the Exceptions surface that owns it. Inventing either here would put a button
 * on screen that does nothing a coordinator can act on.
 */
function unplacedOptions(
  input: PlanInput,
  assignment: Assignment,
  rider: PlanRider,
  cause: UnplacedCause,
): ResolutionOption[] {
  if (cause === "NOT_IN_A_VAN") return [];
  const tokens = [rider.child.token];
  const who = rider.child.displayName;
  const options: ResolutionOption[] = [];
  const add = (
    kind: ResolutionOption["kind"],
    id: string,
    label: string,
    detail: string,
    extra: Partial<ResolutionOption> = {},
  ) => {
    options.push({
      id, kind, rank: OPTION_RANK[kind], label, detail,
      requiresApproval: true, approverRole: "COORDINATOR", affectedChildTokens: tokens, ...extra,
    });
  };

  for (const lane of input.lanes) {
    const check = canTake(input, assignment, lane.id, rider.child.token);
    if (!check.ok) continue;
    const verdict = solveLane(input, lane, [
      ...ridersOf(input, assignment[lane.id] ?? []),
      rider,
    ]);
    add(
      "ALTERNATE_VEHICLE",
      `vehicle:${lane.id}`,
      // The van by name: these options are read on Plan routes, where no vehicle code appears.
      fill(solverCopy.options.ALTERNATE_VEHICLE.label, { vehicle: vanName(lane.vehicle.description) }),
      fill(solverCopy.options.ALTERNATE_VEHICLE.detail, {
        description: lane.vehicle.description,
        provider: lane.vehicle.providerName,
        who,
        // Words, not the provider's shorthand: "1WC/3A" is not a thing anyone says out loud.
        layout: verdict.layout ? layoutName(verdict.layout.code) : "",
      }),
      { candidateVehicleId: lane.vehicle.id, candidateLayoutCode: verdict.layout?.code },
    );
  }
  add("FAMILY_TRANSPORT", `family:${rider.child.token}`, solverCopy.options.FAMILY_TRANSPORT.label,
    fill(solverCopy.options.FAMILY_TRANSPORT.detail, { who }));
  add("DELAY", `delay:${rider.child.token}`, solverCopy.options.DELAY.label,
    fill(solverCopy.options.DELAY.detail, { who }));
  add("CANCEL", `cancel:${rider.child.token}`, solverCopy.options.CANCEL.label,
    fill(solverCopy.options.CANCEL.detail, { who }));

  return options
    .map((option, index) => ({ option, index }))
    .sort((a, b) => a.option.rank - b.option.rank || a.index - b.index)
    .map(({ option }) => option);
}

/* ───────────────────────────── the plan ───────────────────────────── */

/**
 * The whole plan for one assignment: every lane solved with the riders it carries, and every
 * rider who is in no lane, with the reason and the options.
 *
 * This is the only function the screen renders from, so what is on screen is always a solver
 * verdict over the current assignment — including after a drag, a substitution or an arrival
 * report. There is no cached plan to go stale.
 */
export function routePlan(input: PlanInput, assignment: Assignment): RoutePlan {
  const lanes: LanePlan[] = input.lanes.map((lane) => {
    const riders = ridersInOrder(ridersOf(input, assignment[lane.id] ?? []));
    const leg = legOf(input, lane, riders);
    const verdict = solveLane(input, lane, riders, { withOptions: true, assignment });
    return { lane, riders, leg, verdict, seats: laneSeats(lane, leg, verdict), layout: plannedLayout(lane, leg, verdict) };
  });

  const placed = new Set(Object.values(assignment).flatMap((tokens) => [...tokens]));
  const unplaced: Unplaced[] = input.riders
    .filter((rider) => !placed.has(rider.child.token))
    .map((rider) => {
      const { cause, laneId } = whyUnplaced(input, assignment, rider);
      return { rider, cause, laneId, options: unplacedOptions(input, assignment, rider, cause) };
    });

  return { direction: input.direction, lanes, unplaced };
}

/**
 * How hard a child is to place: a chair before an anchored seat before a plain seat, and
 * earliest window first inside each group.
 *
 * Hardest first, because the reverse strands the children with the fewest options: fill a van
 * with walking riders and the one wheelchair place it had is still there, but the seats the
 * chair's attendant needed are gone.
 */
function placementWeight(rider: PlanRider): number {
  if (rider.child.mobility === "WC") return 3;
  if (rider.child.tether) return 2;
  return 1;
}

/** Free places left over at the busiest stop, which is what "this van is roomier" means. */
function spareAfter(seats: LaneSeats): number {
  // Anchored seats are a subset of the walking seats, so they are not counted again here: a
  // van would otherwise look twice as roomy for having anchors it is not using.
  return seats.wcAvailable - seats.wcUsed + (seats.ambAvailable - seats.ambUsed);
}

/**
 * Where a coordinator has put a child by hand: the lane they dropped them on, or `null` for out
 * of every van. Keyed by child token, the same shape `withMove` moves one child with.
 */
export type ManualPlacements = Readonly<Record<string, string | null>>;

/**
 * A plan, searched greedily and checked by the solver at every step.
 *
 * Hardest rider first; among the vans that can take them, the roomiest, then the emptiest, then
 * the day's own lane order. Greedy and not optimal — a plan it cannot complete is reported as
 * unplaced children with reasons, never as a placement the constraints did not allow — and the
 * reason it is greedy rather than exhaustive is that a coordinator has to be able to read why
 * each child is where they are, and "the search put them there" is not a reason. Staff move
 * anyone they disagree with, and the solver checks that move the same way.
 *
 * `manual` is the part of the plan that is not the search's to make (Vera's review, 2026-10-17):
 * a child a coordinator has already placed stays where they were put, and the day is planned
 * around them. Planning used to start from nothing every time, so pressing the one button on the
 * screen silently undid every drag — the fix is here rather than in the screen because "keep
 * what a person decided and fill in the rest" is a property of the plan, not of a click. A
 * manual placement is checked like any other: the lane is solved with that rider aboard, so an
 * assignment this returns is still only placements the four constraints agreed with.
 */
export function planAssignment(input: PlanInput, manual: ManualPlacements = {}): Assignment {
  const load = new Map<string, PlanRider[]>(input.lanes.map((lane) => [lane.id, []]));
  // Held back from the search: a child a person has placed, in the lane they placed them in, or
  // out of every lane. A placement naming a lane this plan does not have is not one of theirs —
  // the scenario or the run changed under it — so that child is planned like anybody else.
  const held = new Set<string>();
  for (const rider of input.riders) {
    const laneId = manual[rider.child.token];
    if (laneId === undefined) continue;
    if (laneId === null) {
      held.add(rider.child.token);
      continue;
    }
    const lane = load.get(laneId);
    if (!lane) continue;
    lane.push(rider);
    held.add(rider.child.token);
  }

  const order = [...input.riders]
    .filter((rider) => !held.has(rider.child.token))
    .map((rider, index) => ({ rider, index }))
    .sort(
      (a, b) =>
        placementWeight(b.rider) - placementWeight(a.rider) ||
        a.rider.window.localeCompare(b.rider.window) ||
        a.index - b.index,
    )
    .map(({ rider }) => rider);

  for (const rider of order) {
    const choices = input.lanes
      .map((lane, index) => {
        const riders = [...(load.get(lane.id) ?? []), rider];
        const verdict = solveLane(input, lane, riders);
        const leg = legOf(input, lane, riders);
        return { lane, index, verdict, spare: spareAfter(laneSeats(lane, leg, verdict)) };
      })
      .filter((choice) => choice.verdict.status === "FEASIBLE")
      .sort(
        (a, b) =>
          b.spare - a.spare ||
          (load.get(a.lane.id)?.length ?? 0) - (load.get(b.lane.id)?.length ?? 0) ||
          a.index - b.index,
      );
    const best = choices[0];
    if (best) load.get(best.lane.id)?.push(rider);
  }

  return Object.fromEntries(
    input.lanes.map((lane) => [
      lane.id,
      ridersInOrder(load.get(lane.id) ?? []).map((rider) => rider.child.token),
    ]),
  );
}

/** Plan the day: search an assignment, then report it as the solver sees it. */
export function planRoutes(input: PlanInput): RoutePlan {
  return routePlan(input, planAssignment(input));
}

/**
 * The assignment with one child moved into one lane, or out of every lane when `laneId` is null.
 *
 * Pure: the caller decides whether the move is allowed (`canTake`) and keeps the old assignment
 * if it is not, so a refused drag changes nothing at all.
 */
export function withMove(assignment: Assignment, childToken: string, laneId: string | null): Assignment {
  const next: Record<string, readonly string[]> = Object.fromEntries(
    Object.entries(assignment).map(([id, tokens]) => [id, tokens.filter((t) => t !== childToken)]),
  );
  if (laneId !== null) next[laneId] = [...(next[laneId] ?? []), childToken];
  return next;
}

/** Every rider in the plan, placed or not — the roster the screen counts against. */
export function placedTokens(plan: RoutePlan): string[] {
  return plan.lanes.flatMap((lane) => lane.riders.map((rider) => rider.child.token));
}

/**
 * Does every child in a lane have a drop-off on that lane's manifest?
 *
 * The question a plan has to answer besides "does it fit": a van that picks a child up and has
 * no stop to set them down at is a plan nobody noticed was broken. Checked over the manifest the
 * solver was given, not over the screen's rendering of it.
 */
export function dropOffsCovered(plan: RoutePlan): boolean {
  return plan.lanes.every((lanePlan) => {
    const setDown = new Set(lanePlan.leg.stops.flatMap((stop) => stop.alighting ?? []));
    return lanePlan.riders.every((rider) => setDown.has(rider.child.token));
  });
}

/** A child by token, across the whole day's roster. Used by the screen's move handlers. */
export function riderOf(input: PlanInput, childToken: string): PlanRider | undefined {
  return input.riders.find((rider) => rider.child.token === childToken);
}
