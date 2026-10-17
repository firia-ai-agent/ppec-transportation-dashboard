/**
 * One ramp check, in sentences — for the three screens that show the same one.
 *
 * A ramp check used to be a fact on one surface. Now the ramp iPad takes it, the plan a
 * coordinator decides from reads it and the Today board shows what it did (src/domain/plan/
 * arrival.ts computes all of that, and nothing here computes any of it). Three screens saying
 * one thing is exactly where wording drifts, so the words are assembled once, here: "Owen C.
 * moves to the center van" is the same clause on the iPad, in the plan's banner and in the
 * board's row note.
 *
 * Nothing in here decides anything. Each function takes a re-plan the solver already produced
 * and chooses the sentence for it, out of src/ui/copy.ts; the chips come out of src/ui/states.ts.
 * So no screen reading this can print a lane id, a place id, a configuration code, a deficit
 * type or a solver verdict — the vocabularies the machine uses to talk to itself.
 *
 * The three cause-keyed helpers at the top were the Plan routes screen's own
 * (src/app/plan-preview/lanes.ts, which now re-exports them from here). They moved when the
 * ramp iPad and the board needed the same answer: "why has this child no van" has one wording,
 * and a second copy of it would be a second wording a week later.
 */
import { fill, planRoutes, rampReplan, securement, sentence, vanName } from "./copy";
import {
  capabilityStates,
  legStates,
  reservationStates,
  type StateDescriptor,
} from "./states";
import { vehicleByKey } from "@/domain/plan/day";
import type { ArrivalReplan, RideChange } from "@/domain/plan/arrival";
import type { Unplaced, UnplacedCause } from "@/domain/solver";

/* ───────────────────────── why a child has no van ───────────────────────── */

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
 * The §3 chip beside a child in no van: what kind of "no van" this is.
 *
 * A van that fits them and is full is the leg machine's own side exit — the one PRD l.750 and
 * l.876 name — so it wears that state and not a generic refusal; a van that is not built for
 * the child is not that state at all, and says so.
 */
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

/* ───────────────────────── one ramp check, in lines ───────────────────────── */

/** The van on a lane, by what it is: "the center van", never the key the fixtures file it under. */
export function laneVanName(laneId: string): string {
  return vanName(vehicleByKey(laneId).description);
}

/**
 * One line a screen shows about one child, with the chip that belongs beside it.
 *
 * `state` is only set where the day has a state to show — a child in no van — because a chip on
 * a child who simply moved van would be inventing one: nothing about their ride's state changed,
 * only which van it is on.
 */
export type ArrivalLine = {
  /** The child this line is about, so a list of them has stable keys and can be opened. */
  childToken: string;
  text: string;
  state?: StateDescriptor;
};

/** The riders the checked van still holds, in the order it drives them. */
export function stayLines(replan: ArrivalReplan): ArrivalLine[] {
  const byToken = new Map(replan.input.riders.map((rider) => [rider.child.token, rider]));
  return replan.stays.flatMap((token) => {
    const rider = byToken.get(token);
    if (!rider) return [];
    return [
      { childToken: token, text: fill(rampReplan.stays, { child: rider.child.displayName }) },
    ];
  });
}

/** The riders the solver found another van for, and the van it agreed to. */
export function moveLines(replan: ArrivalReplan): ArrivalLine[] {
  return replan.moves.map((move) => ({
    childToken: move.childToken,
    text: fill(rampReplan.moved, {
      child: move.childLabel,
      vehicle: laneVanName(move.toLaneId),
    }),
  }));
}

/**
 * The riders no van on the day can take, each with the reason and the state that goes with it.
 *
 * The sentence is the plan screen's own (`reasonLine`), unchanged: a coordinator who reads
 * "No van with four-point straps for Zoe B." on the iPad reads the same sentence when they open
 * the plan the link hands them.
 */
export function holdLines(replan: ArrivalReplan): ArrivalLine[] {
  return replan.holds.map((hold) => ({
    childToken: hold.childToken,
    text: reasonLine(hold.unplaced, hold.unplaced.laneId ? laneVanName(hold.unplaced.laneId) : ""),
    state: unplacedState(hold.cause),
  }));
}

/* ───────────────────────── the banner on the other two screens ───────────────────────── */

/**
 * Why the plan and the board are not showing the day they opened on: a van was checked, and
 * this is what the check did.
 *
 * Two sentences at most — what happened, and how many children it is about — because a banner
 * nobody finishes reading is a banner that did not say anything. The names are in the rows
 * underneath, which is where somebody acting on one of them is already looking.
 *
 * The first line opens on the van, which `vanName` writes as it is said in the middle of a
 * sentence ("the convertible van"), so the stylesheet capitalises the first letter exactly as a
 * lane heading does. That is the existing rule and the reason for it: one string per van, not a
 * sentence-initial copy of each one that could drift from it.
 */
export function arrivalBannerLines(replan: ArrivalReplan): string[] {
  const vehicle = laneVanName(replan.finding.laneId);
  if (!replan.changed) return [fill(rampReplan.bannerNothing, { vehicle })];
  return [
    fill(rampReplan.banner, { vehicle }),
    fill(rampReplan.bannerCount, {
      moved: replan.moves.length,
      held: replan.holds.length,
    }),
  ];
}

/** What one board row says the ramp check did to that ride. */
export function rideChangeLine(change: RideChange): string {
  switch (change.kind) {
    case "MOVED":
      return fill(rampReplan.rowMoved, { vehicle: laneVanName(change.toLaneId) });
    case "HELD":
      return rampReplan.rowHeld;
    default:
      return rampReplan.rowChecked;
  }
}

/** The chip a board row wears once the ramp check has taken its van away from it. */
export function rideChangeState(change: RideChange): StateDescriptor | null {
  return change.kind === "HELD" ? unplacedState(change.cause) : null;
}
