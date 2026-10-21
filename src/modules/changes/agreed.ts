/**
 * THE ROUTE FOR A TIME AGREED WITH A FAMILY (ledger #79, #90): "I won't be home at 3:27 — can you
 * bring them at 4:00?" becomes a plan where the van drops them no earlier.
 *
 * NEVER LATE, EARLY IS FINE, FEWEST MINUTES ADDED (founder, ledger #90). Every van that has not
 * left is a candidate for the child, at every place in its run (`drops`), each previewed by the one
 * preview every plan card uses (`previewPlanChange`), with and without Auto-plan's smallest fix.
 * A route is offered only if it makes nobody late:
 *  - every van fits and nobody is stranded;
 *  - no other family is made late (`madeLate`), and nobody falls outside a time their family agreed;
 *  - the asking child gets there inside the range they asked for (the time to + the slot width).
 * Of those, the fewest minutes added to everybody else wins, then the closest to the asked time.
 * A van that has left keeps its children and its order: nobody joins it, nobody in it is reordered.
 * No route at all is an answer too — a person decides (`exec/proposals.ts dropoffChange`).
 */
import { availabilityConfig } from "@/config/live";
import { minuteOfDay, plannedStopTimes } from "@/domain/plan/arrivals";
import { FIRST_STOP, ridersInVan, type BoardPlan } from "@/domain/plan/board";
import { outsideSlots } from "@/domain/plan/slots";
import type { loadBoard } from "@/modules/plan/store";
import { previewPlanChange, type PlanChange, type PlanPreview } from "./plan-change";

type BoardView = Awaited<ReturnType<typeof loadBoard>>;

export type AgreedRoute = { readonly change: PlanChange; readonly preview: Extract<PlanPreview, { ok: true }> };

export function routesFor(view: BoardView, childToken: string, notBefore: string): AgreedRoute[] {
  const current = view.plan[childToken];
  const asked = minuteOfDay(notBefore);
  if (!current || asked === null) return [];
  const holds = { [childToken]: notBefore };
  const order = (plan: BoardPlan, vanId: string) => ridersInVan(view.day, plan, vanId).map((r) => r.token).join(",");
  const departed = view.day.vans.filter((van) => ridersInVan(view.day, view.plan, van.id).some((r) => r.aboard));
  const aboard = view.day.riders.find((r) => r.token === childToken)?.aboard === true;

  // A child already aboard rides on where they are; one still at the centre may take any van that has not left.
  const candidates: PlanChange[] = aboard ? [{ holds }] : [];
  if (!aboard) {
    for (const van of view.day.vans.filter((v) => !departed.includes(v))) {
      const moves = current.bucket === "VAN" && current.vanId === van.id ? [] : [{ token: childToken, bucket: "VAN" as const, vanId: van.id }];
      const others = ridersInVan(view.day, view.plan, van.id).filter((r) => r.token !== childToken);
      for (const after of [FIRST_STOP, ...others.map((r) => r.token)]) {
        candidates.push({ holds, ...(moves.length > 0 ? { moves } : {}), drops: { [childToken]: after } });
      }
    }
  }
  // Each again with Auto-plan's smallest fix, so a van that does not fit is put right in the same change.
  const all = [...candidates, ...candidates.map((c) => ({ ...c, auto: "FIX_FIT" as const }))];

  const latest = asked + availabilityConfig.slotMinutes;
  const scored = all
    .map((change) => ({ change, preview: previewPlanChange(view, change) }))
    .filter((r): r is AgreedRoute => r.preview.ok)
    .flatMap((r) => {
      const p = r.preview;
      if (!p.allFit || p.stranded.length > 0 || p.madeLate > 0) return [];
      // A van that has left keeps who is in it and the order it drives them.
      if (departed.some((van) => order(p.next, van.id) !== order(view.plan, van.id))) return [];
      // Nobody else outside a time their family agreed; the asking child's own earlier slot is the one being replaced.
      const outside = [...outsideSlots(view.day, p.next, p.departs)].some(([token, off]) => token !== childToken && off > 0);
      if (outside) return [];
      const arrives = plannedStopTimes(view.day, p.next, p.departs).get(childToken)?.arrivesAtMinute;
      if (arrives === undefined || arrives > latest) return [];
      return [{ route: r, score: [Math.round(p.addedMinutes * 10) / 10, Math.round(Math.abs(arrives - asked))] }];
    });
  return scored
    .sort((a, b) => (isBefore(a.score, b.score) ? -1 : isBefore(b.score, a.score) ? 1 : 0))
    .map((s) => s.route);
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
