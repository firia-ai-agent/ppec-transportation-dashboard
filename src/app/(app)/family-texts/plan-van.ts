/**
 * WHICH VAN A CHILD IS ON THIS AFTERNOON, AND WHO IS IN IT — from the plan somebody saved.
 *
 * The card's one plan line ("Noah: drop-off moves to 5:00 PM on Van 3") and the pane beside the
 * thread ("Van 3 after change", its four counts) both used to read the fixture's afternoon run.
 * That is the plan nobody made: after a re-plan around a van that arrived short they named the
 * van the child had been moved off, and counted it against a setup the ramp had just corrected.
 *
 * So this reads what every other screen reads — the plan board's own `loadBoard`, for today's
 * afternoon at this centre — and answers with the van from that plan (carrying today's confirmed
 * setup, not its defaults) and the riders in it. A day nobody has planned yet falls back to the
 * fixture's run, which is the same rule Today applies to a ride with no saved placement; a child
 * a saved plan puts in no van has no van here either.
 *
 * Never throws: a board that cannot be read is the fixture's answer, as it is on a day with no
 * plan, and a screen that shows a thread does not fail for want of a van line.
 */
import type { BoardRider, BoardVan } from "@/domain/plan/board";
import { ridersInVan } from "@/domain/plan/board";
import { serviceDateAt } from "@/domain/day/day-facts";
import { childKeyOfToken, runOfChild, vehicleIdOf } from "@/modules/demo/fixtures/standard";
import { dayDataSource, loadBoard, planStore, type BoardView } from "@/modules/plan/store";

export type ChildVan = { readonly van: BoardVan; readonly aboard: readonly BoardRider[] };

export async function afternoonVanOf(siteId: string, childToken: string): Promise<ChildVan | null> {
  let view: BoardView;
  try {
    view = await loadBoard(planStore(), siteId, serviceDateAt(), "PM", dayDataSource(siteId));
  } catch {
    return null;
  }
  const placed = view.plan[childToken];
  if (placed?.bucket === "VAN" && placed.vanId) {
    const van = view.day.vans.find((v) => v.id === placed.vanId);
    return van ? { van, aboard: ridersInVan(view.day, view.plan, van.id) } : null;
  }
  if (view.version > 0) return null;

  // Nobody has saved this afternoon: the day's own runs are the plan, as on Today.
  const childKey = childKeyOfToken(childToken);
  const run = childKey ? runOfChild(childKey) : null;
  const van = run ? view.day.vans.find((v) => v.id === vehicleIdOf(run.vehicleKey)) : undefined;
  if (!run || !van) return null;
  const aboard = view.day.riders.filter((rider) => run.childKeys.includes(childKeyOfToken(rider.token) ?? ""));
  return { van, aboard };
}
