/**
 * Capacity solver (PRD §7 l.784-800). Deterministic, pure, no LLM and no DB.
 *
 * Feasible(v, leg) holds iff some layout l in L(v) satisfies, for every manifest stop k:
 *  1. an injective f: WC(On_k) -> W_l \ unavail with sec(f(c)) = sec(c), len_c <= len_f(c), wid_c <= wid_f(c);
 *  2. #AMB(On_k) + sum escort(c) + staff_escort_k <= |A_l \ unavail|;
 *  3. #tether(On_k) <= |T_l \ unavail|;
 *  4. (WC(On_k) != {} and lift_required(l)) => lift_ok(v).
 *
 * Unknown capability never counts as available and never yields FEASIBLE (CAPABILITY_PENDING).
 * The output is a feasible layout, or a deficit {k, type, count} with ranked options that a human
 * approves. The solver assigns nothing, locks nothing, and never proposes removing a boarded child.
 */
import { fill, layoutName, solver as copy } from "@/ui/copy";
import { maxMatching } from "./matching";
import type {
  AmbSeat, Child, DailyCapability, Deficit, DeficitType, Layout, LayoutAttempt, Leg,
  OptionKind, ResolutionOption, SolveResult, StopPlan, Vehicle, WcAssignment, WcPosition,
} from "./types";

/** Report order inside one stop: PRD constraint order 1..4. */
const DEFICIT_ORDER: DeficitType[] = [
  "WC_POSITION", "WC_SECUREMENT", "WC_FOOTPRINT", "AMBULATORY_SEAT", "TETHER_SEAT", "LIFT",
];
/**
 * PRD §7 l.799 / §9 l.880 offer order. Exported because the planner (./plan.ts) offers the same
 * set to a rider who has no van at all, and two orders for one option set would be one too many.
 */
export const OPTION_RANK: Record<OptionKind, number> = {
  SPLIT_RUN: 1, ALTERNATE_VEHICLE: 2, ALTERNATE_PROVIDER: 3, FAMILY_TRANSPORT: 4, DELAY: 5, CANCEL: 6,
};
/** No observation exists yet for these capability states, so nothing can be solved. */
const UNOBSERVED: DailyCapability["state"][] = ["UNKNOWN", "REQUESTED", "CHANGED"];
/**
 * States that put the vehicle out of today's reach before any layout is considered, each with
 * the sentence that says why.
 *
 * VERIFIED_INFEASIBLE belongs here with the other two: it records that this vehicle was
 * already checked against this run and already found not to fit. Leaving it out meant the
 * solver re-ran the constraints against the *reported* positions and could answer FEASIBLE,
 * contradicting a verified observation — the one answer a verified row must never produce.
 */
const NOT_USABLE: Partial<Record<DailyCapability["state"], string>> = {
  REJECTED: copy.unusable.REJECTED,
  UNAVAILABLE: copy.unusable.UNAVAILABLE,
  VERIFIED_INFEASIBLE: copy.unusable.VERIFIED_INFEASIBLE,
};

export type AlternateCandidate = {
  vehicle: Vehicle;
  capability: DailyCapability;
  /**
   * The run this vehicle is already committed to today, if any. Moved riders are added to it for
   * the whole run (a conservative check: if they fit end to end, they fit for part of it).
   * Omitted means the vehicle is free.
   */
  leg?: Leg;
};
export type FeasibleOptions = {
  /** Other vehicles to offer, each with its own capability observation for the day. */
  alternates?: AlternateCandidate[];
};

/** On_k, with the staff escorts riding after stop k. */
export type StopOccupancy = { k: number; label: string; onboard: Child[]; staffEscorts: number };

/** Builds On_k for every stop in sequence. Throws on a manifest that contradicts itself. */
export function onboardByStop(leg: Leg): StopOccupancy[] {
  const roster = new Map(leg.children.map((c) => [c.token, c]));
  const stops = [...leg.stops].sort((a, b) => a.k - b.k);
  const onboard: Child[] = [];
  let staffEscorts = 0;
  return stops.map((stop) => {
    for (const token of stop.boarding ?? []) {
      const child = roster.get(token);
      if (!child) throw new Error(`leg ${leg.id}: stop ${stop.k} boards ${token}, who is not on the roster`);
      if (onboard.some((c) => c.token === token)) throw new Error(`leg ${leg.id}: ${token} boards twice`);
      onboard.push(child);
    }
    for (const token of stop.alighting ?? []) {
      const at = onboard.findIndex((c) => c.token === token);
      if (at < 0) throw new Error(`leg ${leg.id}: stop ${stop.k} drops off ${token}, who is not onboard`);
      onboard.splice(at, 1);
    }
    if (stop.staffEscorts !== undefined) {
      // staff_escort_k is a count of seats. A negative value would *free* seats the vehicle
      // does not have and could turn an infeasible run feasible, so it is a contradiction in
      // the manifest, not an input to clamp.
      if (!Number.isInteger(stop.staffEscorts) || stop.staffEscorts < 0) {
        throw new Error(
          `leg ${leg.id}: stop ${stop.k} rides ${stop.staffEscorts} staff escorts, which is not a whole number of seats, zero or more`,
        );
      }
      staffEscorts = stop.staffEscorts;
    }
    return { k: stop.k, label: stop.label, onboard: [...onboard], staffEscorts };
  });
}

function isWcPosition(p: Layout["positions"][number]): p is WcPosition { return p.kind === "WC"; }
function isAmbSeat(p: Layout["positions"][number]): p is AmbSeat { return p.kind === "AMB"; }

/** sec(f(c)) = sec(c) and the chair inside the position footprint (constraint 1). */
export function chairFitsPosition(child: Child, position: WcPosition): boolean {
  if (child.securement === undefined || child.wcLengthCm === undefined || child.wcWidthCm === undefined) return false;
  return child.securement === position.securement
    && child.wcLengthCm <= position.maxLengthCm
    && child.wcWidthCm <= position.maxWidthCm;
}

type ScoredDeficit = Deficit & { relievableByUnknown: boolean };

function layoutsFor(vehicle: Vehicle, leg: Leg, capability: DailyCapability): Layout[] {
  const pinned = capability.observedLayoutId ?? leg.layoutId ?? null;
  if (pinned === null) return vehicle.layouts;
  const layout = vehicle.layouts.find((l) => l.id === pinned);
  if (!layout) throw new Error(`vehicle ${vehicle.id} has no layout ${pinned}`);
  return [layout];
}

function evaluateLayout(
  vehicle: Vehicle, layout: Layout, occupancy: StopOccupancy[], capability: DailyCapability,
): LayoutAttempt {
  const unavailable = new Set(capability.unavailablePositionIds);
  const unknown = new Set(capability.unknownPositionIds ?? []);
  const usable = (id: string) => !unavailable.has(id) && !unknown.has(id);

  const wcPositions = layout.positions.filter(isWcPosition).filter((p) => usable(p.id));
  const ambSeats = layout.positions.filter(isAmbSeat).filter((p) => usable(p.id));
  const unknownWc = layout.positions.filter(isWcPosition).filter((p) => unknown.has(p.id)).length;
  const unknownAmb = layout.positions.filter(isAmbSeat).filter((p) => unknown.has(p.id)).length;
  const unknownTether = layout.positions.filter(isAmbSeat).filter((p) => p.tetherCapable && unknown.has(p.id)).length;
  const latchUnknown = capability.latchOk === null || capability.latchOk === undefined;
  const tetherSeats = capability.latchOk === false ? 0 : ambSeats.filter((s) => s.tetherCapable).length;

  type Failure = { k: number; deficits: Deficit[]; reasons: string[]; hard: boolean };
  const failures: Failure[] = [];
  const plan: StopPlan[] = [];

  for (const stop of occupancy) {
    const deficits: ScoredDeficit[] = [];
    const pending: string[] = [];
    const wcChildren = stop.onboard.filter((c) => c.mobility === "WC");

    // 1. injective chair -> position matching
    const match = maxMatching(wcChildren.length, wcPositions.length, (ci, pi) => chairFitsPosition(wcChildren[ci], wcPositions[pi]));
    const byType = new Map<DeficitType, number>();
    for (const ci of match.unmatched) {
      const child = wcChildren[ci];
      const sameSecurement = wcPositions.filter((p) => p.securement === child.securement);
      const type: DeficitType = wcPositions.length === 0 ? "WC_POSITION"
        : sameSecurement.length === 0 ? "WC_SECUREMENT"
        : sameSecurement.some((p) => chairFitsPosition(child, p)) ? "WC_POSITION" : "WC_FOOTPRINT";
      byType.set(type, (byType.get(type) ?? 0) + 1);
    }
    for (const [type, count] of byType) {
      deficits.push({ k: stop.k, type, count, relievableByUnknown: unknownWc >= count });
    }

    // 2. ambulatory seats: riders + their escorts + staff riding this stop
    const ambNeed = stop.onboard.filter((c) => c.mobility === "AMB").length
      + stop.onboard.filter((c) => c.escort).length + stop.staffEscorts;
    if (ambNeed > ambSeats.length) {
      const count = ambNeed - ambSeats.length;
      deficits.push({ k: stop.k, type: "AMBULATORY_SEAT", count, relievableByUnknown: unknownAmb >= count });
    }

    // 3. tether / LATCH capable seats
    const tetherNeed = stop.onboard.filter((c) => c.tether).length;
    if (tetherNeed > 0 && latchUnknown) {
      pending.push(copy.pending.latchUnknown);
    } else if (tetherNeed > tetherSeats) {
      const count = tetherNeed - tetherSeats;
      deficits.push({ k: stop.k, type: "TETHER_SEAT", count, relievableByUnknown: unknownTether >= count });
    }

    // 4. lift needed for a wheelchair rider in this configuration
    if (wcChildren.length > 0 && layout.liftRequired) {
      if (!vehicle.liftEquipped || capability.liftOk === false) {
        deficits.push({ k: stop.k, type: "LIFT", count: 1, relievableByUnknown: false });
      } else if (capability.liftOk === null) {
        pending.push(copy.pending.liftUnknown);
      }
    }

    if (deficits.length > 0 || pending.length > 0) {
      const ranked = [...deficits].sort((a, b) => DEFICIT_ORDER.indexOf(a.type) - DEFICIT_ORDER.indexOf(b.type));
      const hard = ranked.some((d) => !d.relievableByUnknown);
      const reasons = [...pending];
      if (!hard && ranked.length > 0) reasons.push(copy.pending.unsurePositions);
      failures.push({ k: stop.k, deficits: ranked.map(({ k, type, count }) => ({ k, type, count })), reasons, hard });
      continue; // keep scanning: a later stop may fail in a way no answer can relieve
    }

    const wcAssignments: WcAssignment[] = [...match.pairs.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([ci, pi]) => ({ childToken: wcChildren[ci].token, positionId: wcPositions[pi].id }));
    plan.push({
      k: stop.k, label: stop.label, onboard: stop.onboard.map((c) => c.token), wcAssignments,
      ambulatorySeatsUsed: ambNeed, ambulatorySeatsAvailable: ambSeats.length,
      tetherSeatsUsed: tetherNeed, tetherSeatsAvailable: tetherSeats,
    });
  }

  const identity = { layoutId: layout.id, layoutCode: layout.code, wcPositionsBuilt: layout.positions.filter(isWcPosition).length };
  const hardFailure = failures.find((f) => f.hard);
  if (hardFailure) {
    return { ...identity, verdict: "INFEASIBLE", firstFailureK: hardFailure.k, deficits: hardFailure.deficits, pendingReason: null, plan: [] };
  }
  if (failures.length > 0) {
    return {
      ...identity, verdict: "CAPABILITY_PENDING", firstFailureK: failures[0].k, deficits: failures[0].deficits,
      pendingReason: [...new Set(failures.flatMap((f) => f.reasons))].join(" "), plan: [],
    };
  }
  return { ...identity, verdict: "FEASIBLE", firstFailureK: null, deficits: [], pendingReason: null, plan };
}

/** Total deficit units, used only to rank one failed layout against another. */
function deficitUnits(attempt: LayoutAttempt): number {
  return attempt.deficits.reduce((sum, d) => sum + d.count, 0);
}

/**
 * Children the coordinator could move off this run: never boarded, matching the deficit, taken from
 * the latest boarding stop backwards so earlier stops keep the seats they were promised.
 */
function reallocationCandidates(leg: Leg, occupancy: StopOccupancy[], deficit: Deficit | null): Child[] {
  if (!deficit) return [];
  const boardStop = new Map<string, number>();
  for (const stop of [...leg.stops].sort((a, b) => a.k - b.k)) {
    for (const token of stop.boarding ?? []) if (!boardStop.has(token)) boardStop.set(token, stop.k);
  }
  const onboardAtFailure = occupancy.find((o) => o.k === deficit.k)?.onboard ?? [];
  const matchesDeficit = (c: Child): boolean => {
    switch (deficit.type) {
      case "AMBULATORY_SEAT": return c.mobility === "AMB" || c.escort;
      case "TETHER_SEAT": return c.tether;
      default: return c.mobility === "WC";
    }
  };
  return onboardAtFailure
    .filter((c) => c.boarded !== true && matchesDeficit(c))
    .sort((a, b) => (boardStop.get(b.token) ?? 0) - (boardStop.get(a.token) ?? 0))
    .slice(0, deficit.count);
}

function names(children: Child[]): string {
  return children.map((c) => c.displayName).join(", ");
}

/**
 * The leg restricted to the riders a coordinator could move, used to ask whether another vehicle
 * could take just those stops. Staff escorts are left at 0: staffing a relief run is the
 * coordinator's call, while each moved child keeps their own escort(c).
 */
function reliefLeg(leg: Leg, riders: Child[]): Leg {
  const keep = new Set(riders.map((c) => c.token));
  const stops = leg.stops
    .map((stop) => ({
      ...stop,
      boarding: (stop.boarding ?? []).filter((t) => keep.has(t)),
      alighting: (stop.alighting ?? []).filter((t) => keep.has(t)),
      staffEscorts: 0,
    }))
    .filter((stop) => stop.boarding.length > 0 || stop.alighting.length > 0);
  return { ...leg, id: `${leg.id}:relief`, layoutId: null, children: riders, stops };
}

/**
 * The alternate's own run with the moved riders aboard from its first stop to its last. Conservative
 * on purpose: fitting them for the whole run implies fitting them over any part of it.
 */
function mergedLeg(ownLeg: Leg, riders: Child[]): Leg {
  const already = new Set(ownLeg.children.map((c) => c.token));
  const extra = riders.filter((c) => !already.has(c.token));
  if (extra.length === 0) return ownLeg;
  const tokens = extra.map((c) => c.token);
  const stops = [...ownLeg.stops].sort((a, b) => a.k - b.k);
  const last = stops.length - 1;
  return {
    ...ownLeg, id: `${ownLeg.id}+relief`, children: [...ownLeg.children, ...extra],
    stops: stops.map((stop, index) => ({
      ...stop,
      boarding: index === 0 ? [...(stop.boarding ?? []), ...tokens] : stop.boarding,
      alighting: index === last ? [...(stop.alighting ?? []), ...tokens] : stop.alighting,
    })),
  };
}

function buildOptions(
  leg: Leg, occupancy: StopOccupancy[], deficit: Deficit | null, alternates: AlternateCandidate[], vehicle: Vehicle,
): ResolutionOption[] {
  const notBoarded = leg.children.filter((c) => c.boarded !== true);
  const movable = reallocationCandidates(leg, occupancy, deficit);
  // Riders another vehicle could take: the overflow if we know it, otherwise everyone not yet aboard.
  const riders = movable.length > 0 ? movable : notBoarded;
  const tokens = riders.map((c) => c.token);
  const who = riders.length > 0 ? names(riders) : copy.unnamedRiders;
  const options: ResolutionOption[] = [];
  const add = (
    kind: OptionKind, id: string, label: string, detail: string, extra: Partial<ResolutionOption> = {},
  ) => {
    options.push({
      id, kind, rank: OPTION_RANK[kind], label, detail,
      requiresApproval: true, approverRole: "COORDINATOR", affectedChildTokens: tokens, ...extra,
    });
  };

  if (movable.length > 0) {
    add("SPLIT_RUN", `split:${tokens.join("+")}`, copy.options.SPLIT_RUN.label,
      fill(copy.options.SPLIT_RUN.detail, { who, vehicle: vehicle.label }));
  }
  if (riders.length > 0) {
    for (const candidate of alternates) {
      if (candidate.vehicle.id === vehicle.id) continue;
      const candidateLeg = candidate.leg
        ? mergedLeg(candidate.leg, riders)
        : reliefLeg(leg, riders);
      const verdict = solve(candidate.vehicle, candidateLeg, candidate.capability);
      if (verdict.status !== "FEASIBLE") continue;
      const sameProvider = candidate.vehicle.providerId === vehicle.providerId;
      const kind: OptionKind = sameProvider ? "ALTERNATE_VEHICLE" : "ALTERNATE_PROVIDER";
      add(kind, `${sameProvider ? "vehicle" : "provider"}:${candidate.vehicle.id}`,
        fill(copy.options[kind].label, { vehicle: candidate.vehicle.label }),
        fill(copy.options[kind].detail, {
          description: candidate.vehicle.description,
          provider: candidate.vehicle.providerName,
          who,
          // Words, not the provider's shorthand: a coordinator reads this option
          // on a board, and "1WC/3A" is not a thing anyone says out loud.
          layout: verdict.layout ? layoutName(verdict.layout.code) : "",
        }),
        { candidateVehicleId: candidate.vehicle.id, candidateLayoutCode: verdict.layout?.code });
    }
  }
  if (riders.length > 0) {
    add("FAMILY_TRANSPORT", `family:${tokens.join("+")}`, copy.options.FAMILY_TRANSPORT.label,
      fill(copy.options.FAMILY_TRANSPORT.detail, { who }));
  }
  add("DELAY", "delay", copy.options.DELAY.label,
    riders.length > 0 ? fill(copy.options.DELAY.detail, { who }) : copy.delayAnyone);
  add("CANCEL", `cancel:${tokens.join("+")}`, copy.options.CANCEL.label,
    fill(copy.options.CANCEL.detail, { who }));

  return options
    .map((option, index) => ({ option, index }))
    .sort((a, b) => a.option.rank - b.option.rank || a.index - b.index)
    .map(({ option }) => option);
}

/** Core solve without option generation (used for alternates, so options never recurse). */
function solve(vehicle: Vehicle, leg: Leg, capability: DailyCapability): SolveResult {
  const boardedChildTokens = leg.children.filter((c) => c.boarded === true).map((c) => c.token);
  const base = {
    vehicleId: vehicle.id, layout: null, plan: [], deficit: null, deficits: [], attempts: [],
    options: [], pendingReason: null, autoAssigned: false as const, boardedChildTokens,
  };

  if (UNOBSERVED.includes(capability.state)) {
    const reason = capability.state === "CHANGED" ? copy.pending.substituted : copy.pending.unobserved;
    return { ...base, status: "CAPABILITY_PENDING", pendingReason: reason, severity: "AMBER" };
  }
  const unusable = NOT_USABLE[capability.state];
  if (unusable !== undefined) {
    return { ...base, status: "VEHICLE_UNAVAILABLE", severity: "RED", pendingReason: unusable };
  }

  const occupancy = onboardByStop(leg);
  const attempts = layoutsFor(vehicle, leg, capability).map((layout) => evaluateLayout(vehicle, layout, occupancy, capability));

  // A vehicle with no configuration at all can carry nobody. There is no attempt to report and
  // nothing to rank, so say INFEASIBLE here rather than reach for `ranked[0]` of an empty list.
  if (attempts.length === 0) {
    return { ...base, status: "INFEASIBLE", attempts, severity: "RED" };
  }

  const fit = attempts.find((a) => a.verdict === "FEASIBLE");
  if (fit) {
    return {
      ...base, status: "FEASIBLE", layout: { id: fit.layoutId, code: fit.layoutCode },
      plan: fit.plan, attempts, severity: null,
    };
  }

  const pendingAttempts = attempts.filter((a) => a.verdict === "CAPABILITY_PENDING");
  if (pendingAttempts.length > 0) {
    return {
      ...base, status: "CAPABILITY_PENDING", attempts, severity: "AMBER",
      pendingReason: pendingAttempts.map((a) => a.pendingReason).filter(Boolean).join(" ")
        || copy.pending.unsureCapability,
    };
  }

  // Report the closest configuration. Configurations with too few wheelchair positions to ever
  // carry this run are set aside first (a 0WC configuration says nothing useful when a chair is
  // riding), then: fewest missing places, the one that gets furthest through the manifest,
  // declaration order. Keeps the reported k and type deterministic.
  const maxChairs = Math.max(0, ...occupancy.map((o) => o.onboard.filter((c) => c.mobility === "WC").length));
  const capable = attempts.filter((a) => a.wcPositionsBuilt >= maxChairs);
  const ranked = (capable.length > 0 ? capable : attempts)
    .map((attempt, index) => ({ attempt, index }))
    .sort((a, b) => deficitUnits(a.attempt) - deficitUnits(b.attempt)
      || (b.attempt.firstFailureK ?? 0) - (a.attempt.firstFailureK ?? 0)
      || a.index - b.index);
  const best = ranked[0].attempt;
  return {
    ...base, status: "INFEASIBLE", attempts, severity: "RED",
    deficit: best.deficits[0] ?? null, deficits: best.deficits,
  };
}

/**
 * Solve one leg against one vehicle and its capability observation for the day.
 * Returns the feasible layout, or the deficit plus ranked options for a human to approve.
 */
export function feasible(
  vehicle: Vehicle, leg: Leg, capability: DailyCapability, opts: FeasibleOptions = {},
): SolveResult {
  if (capability.vehicleId !== vehicle.id) {
    throw new Error(`capability is for vehicle ${capability.vehicleId}, not ${vehicle.id}`);
  }
  const result = solve(vehicle, leg, capability);
  if (result.status === "FEASIBLE" || result.status === "CAPABILITY_PENDING") return result;

  const occupancy = onboardByStop(leg);
  const options = buildOptions(leg, occupancy, result.deficit, opts.alternates ?? [], vehicle);
  const boarded = new Set(result.boardedChildTokens);
  for (const option of options) {
    if (option.affectedChildTokens.some((t) => boarded.has(t))) {
      throw new Error(`option ${option.id} would move a boarded child; the solver must never propose that`);
    }
  }
  return { ...result, options };
}

export const DEFICIT_REPORT_ORDER = DEFICIT_ORDER;
