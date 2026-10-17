/**
 * Pure helpers behind the Plan routes screen: the solver's verdicts turned into the §3 state
 * vocabulary and the §5 sentences, and nothing else.
 *
 * Every word these functions assemble comes from src/ui/copy.ts and every state chip from
 * src/ui/states.ts, so a coordinator never reads a deficit type, a capability state or a layout
 * code — the three vocabularies the machine uses to talk to itself. The verdict is computed in
 * src/domain/solver; the sentence that says it is chosen here; neither is written here.
 */
import { countable, fill, layoutName, pluralize, planRoutes, rampIpad, securement, sentence, vanName } from "@/ui/copy";
import { capabilityStates, legStates, reservationStates, type StateDescriptor } from "@/ui/states";
import { clockLabel } from "@/ui/service-date";
import { causeOfDeficit } from "@/domain/solver";
import type {
  Child, DailyCapability, LanePlan, LaneSeats, Layout, PlanRider, SolveResult, Unplaced,
  UnplacedCause, Vehicle, WcPosition,
} from "@/domain/solver";

/* ───────────────────────── what the day knows about the van ───────────────────────── */

/**
 * The three answers a lane can carry about the van that is coming (VEH-02, VEH-04). "Not checked
 * yet" is first because it is the honest state of a morning, and it is never read as a yes.
 */
export const ARRIVAL_ANSWERS = ["NOT_CHECKED", "REPORTED", "RAMP_CHECKED"] as const;
export type ArrivalAnswer = (typeof ARRIVAL_ANSWERS)[number];

/**
 * One answer, labelled. "Reported by the provider" named a role where the day has a name on file
 * (Vera's review, 2026-10-17; COPY-GUIDE §1 "name the person"), so the provider's own name goes
 * on the button that records their report. The other two answers carry no placeholder and come
 * back unchanged.
 */
export function arrivalLabel(answer: ArrivalAnswer, providerName: string): string {
  return fill(planRoutes.arrival[answer], { provider: providerName });
}

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

/**
 * "Can’t put Zoe B. in the substitute van: no four-point straps." — one line, the child, the
 * missing thing, and the van by name rather than by the code the fixtures file it under.
 */
export function refusalLine(vehicle: Vehicle, child: Child, cause: UnplacedCause): string {
  return fill(planRoutes.refused, {
    vehicle: vanName(vehicle.description),
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
    return [verdict.pendingReason ?? rampIpad.vehicleOut, planRoutes.laneBlocked];
  }
  const deficit = verdict.deficit;
  const stop = lane.leg.stops.find((s) => s.k === deficit?.k)?.label;
  const cause = deficit ? causeOfDeficit(deficit.type) : "NO_VEHICLE";
  const missing = missingPhrase(cause, chairSecurement(lane.riders));
  return [
    // A deficit the solver found at a stop says where; one it found about the van itself does
    // not, because "At the sedan, this van has …" is not a place.
    stop === undefined
      ? fill(planRoutes.laneMissingAnywhere, { missing })
      : fill(planRoutes.laneMissing, { stop, missing }),
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
 * broken. `vanLabel` is only needed by the one reason that is about a particular van — the van
 * that is the only fit and has not been reported on — and is the empty string otherwise, which
 * is why the reason table never interpolates it anywhere else. When it is needed it is the van's
 * own name ("the center van"), because no code reaches this screen.
 */
export function reasonLine(unplaced: Unplaced, vanLabel: string): string {
  const child = unplaced.rider.child;
  // Closed with `sentence()`: a reason that ends on the child's name already ends in the full
  // stop their last initial carries, and the templates that do carry none of their own.
  return sentence(
    fill(planRoutes.reason[unplaced.cause], {
      child: child.displayName,
      vehicle: vanLabel,
      securement: securement[child.securement ?? "OTHER"],
    }),
  );
}

/* ───────────────────────────── the van itself ───────────────────────────── */

function isWcPosition(position: Layout["positions"][number]): position is WcPosition {
  return position.kind === "WC";
}

/**
 * What a van has today, as chips: its ramp, and each wheelchair place with the hardware and the
 * footprint it accepts.
 *
 * Measured against the configuration the lane is planned as and the day's observation, so a
 * position reported out of service is not on the list — a van's equipment is what it has
 * *today*, not what it was built with.
 *
 * It used to end with two more chips, "3 seats" and "2 anchored seats", which are the second
 * halves of the two place lines directly underneath it ("0 of 3 seats used") — the same numbers,
 * twice, in two shapes (Vera's review, 2026-10-17). The lines say how full the van is and these
 * say what it is built with, so the counts belong to the lines and the chips stop at the chairs.
 */
export function equipmentChips(
  vehicle: Vehicle,
  layout: Layout,
  capability: DailyCapability,
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
  return chips;
}

/** "Set up as 1 wheelchair · 3 seats" — the configuration in words, never the shorthand. */
export function setUpAsLine(layout: Layout): string {
  return fill(planRoutes.setUpAs, { layout: layoutName(layout.code) });
}

/**
 * Why that line changes on a van that can be re-seated, and nothing at all on a van that cannot.
 *
 * A convertible van is built several ways, and the configuration a lane shows is the one the day
 * knows most about (`plannedLayout`): before a plan it is only the first one that could hold the
 * riders, after a plan it is the one the solver found room in, and once somebody has seen the van
 * it is the one that actually arrived. So the same lane can say "Set up as 6 seats" and then
 * "Set up as 1 wheelchair · 3 seats" a click later — true both times, and unreadable without this
 * sentence. Vans with one configuration get `null`: there is nothing to explain.
 */
export function setUpChangeLine(lane: LanePlan): string | null {
  if (lane.lane.vehicle.layouts.length < 2) return null;
  if (lane.lane.capability.observedLayoutId) return planRoutes.setUpChanges.SEEN;
  return lane.riders.length === 0 ? planRoutes.setUpChanges.BEFORE : planRoutes.setUpChanges.PLANNED;
}

/* ───────────────────────────── how full the van is ───────────────────────────── */

/** One place line: "3 of 6 seats used", and what to say when the run asks for more than that. */
function seatLine(used: number, available: number, noun: { one: string; many: string }): string {
  const line = fill(planRoutes.seatsUsed, { used, places: pluralize(available, noun) });
  return used > available ? fill(planRoutes.seatsOver, { line }) : line;
}

/**
 * The place lines on a lane, used of available (Vera's review): wheelchair places, seats,
 * anchored seats. An infeasible run can need more than the van has, so a line whose first number
 * is the larger one says so in words rather than leaving "4 of 3" looking like a slip.
 *
 * A kind of place the van does not have and nobody is using is left out entirely. "0 of 0
 * wheelchair places used" is a true sentence about the sedan and it is not a fact — it says
 * nothing a coordinator can act on, and it was on two of the three lanes (Vera's review,
 * 2026-10-17). A van asked for a place it has none of still says so, because then the first
 * number is not zero and the line is the whole reason the run does not fit.
 */
export function seatLines(seats: LaneSeats): string[] {
  const places: ReadonlyArray<{ used: number; available: number; noun: { one: string; many: string } }> = [
    { used: seats.wcUsed, available: seats.wcAvailable, noun: countable.wcPlace },
    { used: seats.ambUsed, available: seats.ambAvailable, noun: countable.seat },
    { used: seats.tetherUsed, available: seats.tetherAvailable, noun: countable.anchoredSeat },
  ];
  return places
    .filter((place) => place.used > 0 || place.available > 0)
    .map((place) => seatLine(place.used, place.available, place.noun));
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
    chips.push(fill(rampIpad.usesWheelchair, { securement: securement[child.securement ?? "OTHER"] }));
    if (child.wcLengthCm !== undefined && child.wcWidthCm !== undefined) {
      chips.push(
        fill(measured ? planRoutes.chairMeasured : planRoutes.chairOnFile, {
          length: child.wcLengthCm,
          width: child.wcWidthCm,
        }),
      );
    }
  }
  if (child.tether) chips.push(rampIpad.needsAnchoredSeat);
  if (child.escort) chips.push(rampIpad.escortRides);
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
