import type { Direction } from "@/domain/day/leg";
import { autoPlan } from "@/domain/plan/board";
import { ACTIONS, type ActionCtx } from "@/modules/actions/registry";
import { dayDataSource, loadBoard, planStore } from "@/modules/plan/store";

/**
 * The board's Auto-plan then Save, as a person does it — for tests that need a saved plan to start
 * from. (The `auto_plan` action itself only drafts a card since ledger #76.)
 */
export async function saveAutoPlan(
  ctx: ActionCtx,
  date: string,
  direction: Direction,
  /** Every van's departure for the day, "HH:MM", as a planner would set it on the board. */
  leaves?: string,
) {
  const view = await loadBoard(
    ctx.deps?.store ?? planStore(), ctx.siteId, date, direction, ctx.deps?.source ?? dayDataSource(ctx.siteId),
  );
  const next = autoPlan(view.day, view.plan);
  const moves = Object.entries(next)
    .filter(([token, p]) => view.plan[token]?.bucket !== p.bucket || view.plan[token]?.vanId !== p.vanId)
    .map(([childToken, p]) => ({ childToken, bucket: p.bucket, vanId: p.vanId, planned: true }));
  const departures = leaves ? Object.fromEntries(view.day.vans.map((van) => [van.id, leaves])) : undefined;
  return ACTIONS.save_plan.run(ctx, { date, direction, version: view.version, moves, departures });
}
