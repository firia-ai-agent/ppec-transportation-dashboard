/**
 * Pure helpers behind the Plan routes screen: the solver's verdicts turned into the §3 state
 * vocabulary and the §5 sentences, and nothing else.
 *
 * Every word these functions assemble comes from src/ui/copy.ts and every state chip from
 * src/ui/states.ts, so a coordinator never reads a deficit type, a capability state or a layout
 * code — the three vocabularies the machine uses to talk to itself. The verdict is computed in
 * src/domain/solver; the sentence that says it is chosen here; neither is written here.
 */
import { countable, fill, layoutName, pluralize, planRoutes, rampPreview, securement, sentence } from "@/ui/copy";
import { capabilityStates, legStates, reservationStates, type StateDescriptor } from "@/ui/states";
import { clockLabel } from "@/ui/service-date";
import { causeOfDeficit } from "@/domain/solver";
import type {
  Child, DailyCapability, LanePlan, Layout, PlanRider, SolveResult, Unplaced, UnplacedCause,
  Vehicle, WcPosition,
} from "@/domain/solver";

/* ───────────────────────── what the day knows about the van ───────────────────────── */

/**
 * The three answers a lane can carry about the van that is coming (VEH-02, VEH-04). "Not checked
 * yet" is first because it is the honest state of a morning, and it is never read as a yes.
 */
export const ARRIVAL_ANSWERS = ["NOT_CHECKED", "REPORTED", "RAMP_CHECKED"] as const;
export type ArrivalAnswer = (typeof ARRIVAL_ANSWERS)[number];
export const ARRIVAL_LABEL: Readonly<Record<ArrivalAnswer, string>> = planRoutes.arrival;

/* ───────────────────────────── a lane's state ───────────────────────────── */

/**
 * The chip on a lane: the solver's verdict where there is one to give, and what the day knows
 * about the van where there is not.
 *
 * An empty lane does not get a seating verdict — "Fits" over a van with nobody in it says
 * nothing — so it says what the day knows instead: reported by the provider, asked again,
 * changed, or not checked yet. That is also the whole of the VEH-05 chain, in one chip.
 */
export function laneState(lane: LanePlan): StateDescriptor {
  if (lane.riders.length === 0) return capabilityStates[lane.lane.capability.state];
  switch (lane.verdict.status) {
    case "FEASIBLE":
      return reservationStates.FEASIBLE;
    case "CAPABILITY_PENDING":
      return capabilityStates[lane.lane.capability.state];
    case "VEHICLE_UNAVAILABLE":
      return capabilityStates.UNAVAILABLE;
    default:
      return reservationStates.INFEASIBLE;
  }
}

/** The securement hardware of the first chair riding this lane, in words. */
function chairSecurement(riders: readonly PlanRider[]): string {
  const chair = riders.find((rider) => rider.child.mobility === "WC");
  return securement[chair?.child.securement ?? "OTHER"];
}

/**
 * The thing that is missing, as a refusal or a lane line reads it: "no four-point straps".
 *
 * Keyed by the planner's cause rather than by the solver's deficit type, because a cause is
 * what a person can act on — "this van is full" and "this van is not built for this chair" are
 * two different conversations with the provider.
 */
export function missingPhrase(cause: UnplacedCause, securementWords: string): string {
  return fill(planRoutes.missing[cause], { securement: securementWords });
}

/** "V3 can’t take Zoe B.: no four-point straps." — one line, the child, the missing thing. */
export function refusalLine(vehicle: Vehicle, child: Child, cause: UnplacedCause): string {
  return fill(planRoutes.refused, {
    vehicle: vehicle.label,
    child: child.displayName,
    missing: missingPhrase(cause, securement[child.securement ?? "OTHER"]),
  });
}

/**
 * The sentence under a lane's chip. Three shapes, because they are three different facts:
 * everyone fits; nothing is known yet so nobody boards; or it does not fit, here, for this
 * reason — and in that last case the line says where on the run it was found, since a van that
 * fits two children and fails on the third fails at a stop.
 */
export function laneLines(lane: LanePlan): string[] {
  const { verdict } = lane;
  if (verdict.status === "FEASIBLE") {
    return [lane.riders.length === 0 ? planRoutes.laneEmpty : planRoutes.laneFits];
  }
  if (verdict.status === "CAPABILITY_PENDING") {
    return [verdict.pendingReason, planRoutes.laneNeedsCheck].filter(
      (line): line is string => typeof line === "string" && line.length > 0,
    );
  }
  if (verdict.status === "VEHICLE_UNAVAILABLE") {
    return [verdict.pendingReason ?? rampPreview.vehicleOut, planRoutes.laneBlocked];
  }
  const deficit = verdict.deficit;
  const stop = lane.leg.stops.find((s) => s.k === deficit?.k)?.label ?? lane.lane.vehicle.label;
  const cause = deficit ? causeOfDeficit(deficit.type) : "NO_VEHICLE";
  return [
    fill(planRoutes.laneMissing, { stop, missing: missingPhrase(cause, chairSecurement(lane.riders)) }),
    planRoutes.laneBlocked,
  ];
}

/* ───────────────────────── a child with no van ───────────────────────── */

/** The §3 chip beside an unplaced child: what kind of "no van" this is. */
export function unplacedState(cause: UnplacedCause): StateDescriptor {
  switch (cause) {
    case "UNKNOWN_UNTIL_ARRIVAL":
      return capabilityStates.UNKNOWN;
    case "VANS_FULL":
    case "NO_SEAT":
      return legStates.LEFT_BEHIND_CAPACITY;
    case "NOT_IN_A_VAN":
      return legStates.SCHEDULED;
    case "NO_VEHICLE":
      return capabilityStates.UNAVAILABLE;
    default:
      return reservationStates.INFEASIBLE;
  }
}

/**
 * The one plain sentence an unplaced child's row carries: "No van with a ramp for Noah O."
 *
 * It names the child, and it names the thing that is missing rather than the rule that was
 * broken. `vehicle` is only needed by the one reason that is about a particular van — the van
 * that is the only fit and has not been reported on — and is the empty string otherwise, which
 * is why the reason table never interpolates it anywhere else.
 */
export function reasonLine(unplaced: Unplaced, vehicleLabel: string): string {
  const child = unplaced.rider.child;
  // Closed with `sentence()`: a reason that ends on the child's name already ends in the full
  // stop their last initial carries, and the templates that do carry none of their own.
  return sentence(
    fill(planRoutes.reason[unplaced.cause], {
      child: child.displayName,
      vehicle: vehicleLabel,
      securement: securement[child.securement ?? "OTHER"],
    }),
  );
}

/* ───────────────────────────── the van itself ───────────────────────────── */

function isWcPosition(position: Layout["positions"][number]): position is WcPosition {
  return position.kind === "WC";
}

/**
 * What a van has today, as chips: its ramp, each wheelchair place with the hardware and the
 * footprint it accepts, then the seats and how many of them are anchored.
 *
 * Measured against the configuration the lane is planned as and the day's observation, so a
 * position reported out of service is not on the list — a van's equipment is what it has
 * *today*, not what it was built with.
 */
export function equipmentChips(
  vehicle: Vehicle,
  layout: Layout,
  capability: DailyCapability,
  places: { wc: number; amb: number; tether: number },
): string[] {
  const unusable = new Set([
    ...capability.unavailablePositionIds,
    ...(capability.unknownPositionIds ?? []),
  ]);
  const chips: string[] = [
    vehicle.liftEquipped && capability.liftOk !== false
      ? planRoutes.equipment.lift
      : planRoutes.equipment.noLift,
  ];
  for (const position of layout.positions.filter(isWcPosition)) {
    if (unusable.has(position.id)) continue;
    chips.push(
      fill(planRoutes.equipment.wcPlace, {
        securement: securement[position.securement],
        length: position.maxLengthCm,
        width: position.maxWidthCm,
      }),
    );
  }
  chips.push(pluralize(places.amb, countable.seat));
  if (places.tether > 0) chips.push(pluralize(places.tether, countable.anchoredSeat));
  return chips;
}

/** "Set up as 1 wheelchair · 3 seats" — the configuration in words, never the shorthand. */
export function setUpAsLine(layout: Layout): string {
  return fill(planRoutes.setUpAs, { layout: layoutName(layout.code) });
}

/* ───────────────────────────── a rider's row ───────────────────────────── */

/** "Okeeheelee Park · 6:50 AM" — where this child is picked up, and when it is planned for. */
export function stopLine(rider: PlanRider): string {
  return fill(planRoutes.pickupRow, { stop: rider.stopLabel, time: clockLabel(rider.window) });
}

/**
 * A child's transport needs in plain words, never a diagnosis (COPY-GUIDE §1).
 *
 * The chair's size carries where the measurement came from, because on this screen that is the
 * whole of AT-04: the chair on file is what the plan was made against, and the chair measured at
 * the ramp is what actually arrived. Two sentences, so nobody has to guess which one they are
 * looking at. The two chips that say the same thing here as on the ramp iPad are the ramp's own
 * strings — the same fact gets the same words (COPY-GUIDE §5).
 */
export function needChips(child: Child, measured: boolean): string[] {
  const chips: string[] = [];
  if (child.mobility === "WC") {
    chips.push(fill(rampPreview.usesWheelchair, { securement: securement[child.securement ?? "OTHER"] }));
    if (child.wcLengthCm !== undefined && child.wcWidthCm !== undefined) {
      chips.push(
        fill(measured ? planRoutes.chairMeasured : planRoutes.chairOnFile, {
          length: child.wcLengthCm,
          width: child.wcWidthCm,
        }),
      );
    }
  }
  if (child.tether) chips.push(rampPreview.needsAnchoredSeat);
  if (child.escort) chips.push(rampPreview.escortRides);
  return chips;
}

/* ───────────────────────────── the plan as a whole ───────────────────────────── */

/** "7 of 9 riders are in a van." */
export function summaryLine(planned: number, total: number): string {
  return fill(planRoutes.summary, { planned, total });
}

/** Is there anything on this plan a coordinator still has to decide? */
export function needsADecision(lanes: readonly LanePlan[], unplaced: readonly Unplaced[]): boolean {
  return (
    unplaced.some((u) => u.cause !== "NOT_IN_A_VAN") ||
    lanes.some((lane) => blockedVerdict(lane.verdict))
  );
}

function blockedVerdict(verdict: SolveResult): boolean {
  return verdict.status === "INFEASIBLE" || verdict.status === "VEHICLE_UNAVAILABLE";
}
