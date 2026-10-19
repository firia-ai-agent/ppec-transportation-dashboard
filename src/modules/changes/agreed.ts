/**
 * THE ROUTE FOR A TIME AGREED WITH A FAMILY (ledger #79): "I won't be home at 4:16 — can you bring
 * them at 4:50?" becomes a plan where the van drops them no earlier.
 *
 * Small and deterministic. The candidates are the child's own van — their stop driven in the
 * agreed order, the van waiting there if it would still be early — and, while that van has not
 * left, every other van running this leg. Each is previewed by the one preview every plan card uses
 * (`previewPlanChange`), and the best is the one where every van fits, then the one that gets
 * there closest to the agreed time, then the fewest families made late, then the fewest minutes
 * added to everybody else. Same van wins a tie: the family keeps the driver they know.
 */
import type { loadBoard } from "@/modules/plan/store";
import { previewPlanChange, vanHasLeft, type PlanChange, type PlanPreview } from "./plan-change";

type BoardView = Awaited<ReturnType<typeof loadBoard>>;

export type AgreedRoute = { readonly change: PlanChange; readonly preview: Extract<PlanPreview, { ok: true }> };

export function bestRouteFor(view: BoardView, childToken: string, notBefore: string, now?: Date): AgreedRoute | null {
  const current = view.plan[childToken];
  if (!current) return null;
  const holds = { [childToken]: notBefore };
  const candidates: PlanChange[] = [{ holds }];
  if (current.bucket === "VAN" && !vanHasLeft(view, current.vanId, now)) {
    for (const van of view.day.vans) {
      if (van.id === current.vanId || vanHasLeft(view, van.id, now)) continue;
      candidates.push({ holds, moves: [{ token: childToken, bucket: "VAN", vanId: van.id }] });
    }
  }
  let best: AgreedRoute | null = null;
  for (const change of candidates) {
    const preview = previewPlanChange(view, change, now);
    if (!preview.ok) continue;
    const rank = (p: typeof preview) => [p.allFit ? 0 : 1, p.agreedLate, p.madeLate, p.addedMinutes];
    const better = best === null || isBefore(rank(preview), rank(best.preview));
    if (better) best = { change, preview };
  }
  return best;
}

/** Lexical order of two score lists: the first difference decides. */
function isBefore(a: readonly number[], b: readonly number[]): boolean {
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return a[i] < b[i];
  return false;
}
