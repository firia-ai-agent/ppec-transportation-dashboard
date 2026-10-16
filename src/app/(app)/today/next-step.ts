import type { LegRow } from "@/domain/board/board";
import { board as boardCopy, fill, sentence } from "@/ui/copy";

/**
 * The words a ride's next step and its needs-action reasons are read as — written once, because
 * they are read twice: in the row's "Next step" column at 1280, and in the drawer's ride card,
 * which is where the narrow widths keep them after that column folds away (§4.1).
 *
 * The step is a sentence that opens with a verb and names the child, and the people in it are
 * named too: the dispatcher who can answer for a van is "Hal B.", not "the provider"
 * (COPY-GUIDE §1 "name the person"). The centre's own fleet has nobody on file to name, so that
 * step names the fleet rather than inventing somebody to call — which is why there are two
 * codes for one question.
 */
function values(leg: LegRow): Record<string, string> {
  return {
    child: leg.child.childLabel,
    dispatcher: leg.ride.providerDispatcher ?? "",
    provider: leg.ride.providerName ?? "",
    van: leg.ride.vehicleLabel ?? "",
  };
}

/**
 * The step, or null when the honest answer is that nobody is waiting on anything.
 *
 * Closed with `sentence()`, because a step that ends on the child's name ends on the full stop
 * their last initial already carries: "Record who receives Noah O.", never "Noah O..".
 */
export function nextStepText(leg: LegRow): string | null {
  if (leg.nextStep === "NOTHING") return null;
  return sentence(fill(boardCopy.nextSteps[leg.nextStep], values(leg)));
}

/** "Nothing to do" — said rather than left as an empty cell, which reads as missing data. */
export function nextStepCellText(leg: LegRow): string {
  return nextStepText(leg) ?? boardCopy.nextSteps.NOTHING;
}

/** Why this ride needs a person, in the board's ranked order. Empty when it does not. */
export function needsActionReasonText(leg: LegRow): string[] {
  return leg.needsActionReasons.map((reason) => fill(boardCopy.reasons[reason], values(leg)));
}
