/**
 * THE ROUTE FOR A TIME AGREED WITH A FAMILY (ledger #79): "I won't be home at 4:16 — can you bring
 * them at 4:50?" becomes a plan where the van drops them no earlier.
 *
 * Small and deterministic. The candidates are the child's own van — their stop driven in the
 * agreed order, the van waiting there if it would still be early — and, while that van has not
 * left, every other van running this leg. Each is previewed by the one preview every plan card uses
 * (`previewPlanChange`), with and without Auto-plan's smallest fix, and ranked: every van fits, then the one that gets
 * the fewest minutes any child falls outside a time their family agreed (ledger #84), then the one that gets
 * there closest to the agreed time, then the fewest families made late, then the fewest minutes
 * added to everybody else. Same van wins a tie: the family keeps the driver they know.
 */
import type { loadBoard } from "@/modules/plan/store";
import { ridersInVan } from "@/domain/plan/board";
import { previewPlanChange, type PlanChange, type PlanPreview } from "./plan-change";

type BoardView = Awaited<ReturnType<typeof loadBoard>>;

export type AgreedRoute = { readonly change: PlanChange; readonly preview: Extract<PlanPreview, { ok: true }> };

export function routesFor(view: BoardView, childToken: string, notBefore: string): AgreedRoute[] {
  const current = view.plan[childToken];
  if (!current) return [];
  const holds = { [childToken]: notBefore };
  const candidates: PlanChange[] = [{ holds }];
  // A child already aboard rides the van they are in; one still at the centre could take another.
  const aboard = view.day.riders.find((r) => r.token === childToken)?.aboard === true;
  if (current.bucket === "VAN" && !aboard) {
    for (const van of view.day.vans) {
      if (van.id === current.vanId) continue;
      // A van that has left — somebody is already on it — is not a van this child can be put in.
      if (ridersInVan(view.day, view.plan, van.id).some((r) => r.aboard)) continue;
      candidates.push({ holds, moves: [{ token: childToken, bucket: "VAN", vanId: van.id }] });
    }
  }
  // Each again with Auto-plan's smallest fix, so a van that does not fit is put right in the same
  // change — one Approve for the family's request and what was in its way.
  const all = [...candidates, ...candidates.map((c) => ({ ...c, auto: "FIX_FIT" as const }))];
  // Every van fits; then nobody pushed outside a time their family agreed (ledger #84); then the
  // asking family's own time; then the fewest families made late; then the fewest minutes added.
  const rank = (p: Extract<PlanPreview, { ok: true }>) => [p.allFit ? 0 : 1, p.outsideMinutes, p.agreedLate, p.madeLate, p.addedMinutes];
  return all
    .map((change) => ({ change, preview: previewPlanChange(view, change) }))
    .filter((r): r is AgreedRoute => r.preview.ok)
    // One family's time is never bought with another child's ride.
    .filter((r) => r.preview.stranded.length === 0)
    .sort((a, b) => (isBefore(rank(a.preview), rank(b.preview)) ? -1 : isBefore(rank(b.preview), rank(a.preview)) ? 1 : 0));
}

/** The best route, or null — the first of `routesFor`. */
export function bestRouteFor(view: BoardView, childToken: string, notBefore: string): AgreedRoute | null {
  return routesFor(view, childToken, notBefore)[0] ?? null;
}

/** Lexical order of two score lists: the first difference decides. */
function isBefore(a: readonly number[], b: readonly number[]): boolean {
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return a[i] < b[i];
  return false;
}
