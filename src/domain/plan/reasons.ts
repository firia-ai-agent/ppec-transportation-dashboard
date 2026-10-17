/**
 * Why a van said no, in the words a coordinator reads.
 *
 * One sentence, assembled from src/ui/copy.ts and keyed by the planner's own `UnplacedCause`
 * (src/domain/solver/plan.ts), so a new cause cannot reach a person without words and nobody
 * has to translate a deficit type on the way.
 *
 * It lives beside the planner rather than in the screen's helpers because the refusal is said in
 * two places now: on the screen, when a drag is refused, and in the save endpoint's answer, when
 * a plan that names that same move is refused over HTTP. The same refusal has to be the same
 * sentence — one definition, two readers — or a plan could be told two different stories about
 * one solver verdict.
 *
 * Pure, and it writes nothing of its own: every word comes from the copy module.
 */
import { fill, planRoutes, securement, vanName } from "@/ui/copy";
import type { Child, UnplacedCause, Vehicle } from "@/domain/solver";

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
