/**
 * WHAT CONFIRMING A CARD DID, IN ONE LINE (ledger #75 c).
 *
 * A colleague who did what you okayed tells you how it went: "Done. Every van fits, and 2 families
 * were texted a new time." Read from what is true after the action, never from what was hoped:
 * the board for the leg the card was about (does every van fit?), and the late-ETA texts the save
 * queued (replan-notices.ts). An action that is not a plan change says "Done." and no more.
 */
import type { Db } from "@/db/exec";
import { confirmCopy, fill } from "@/ui/copy";
import { vansOver } from "@/modules/plan/place";
import { loadBoard } from "@/modules/plan/store";
import type { ActionDeps } from "./types";

const PLAN_TOOLS: ReadonlySet<string> = new Set(["auto_plan", "save_plan", "move_child"]);

export async function staffActionOutcome(
  db: Db,
  a: {
    readonly siteId: string;
    readonly tool: string;
    readonly args: Readonly<Record<string, unknown>>;
    readonly since: Date;
    readonly deps: ActionDeps;
  },
): Promise<string> {
  const date = String(a.args.date ?? "");
  const leg = a.args.leg === "AM" || a.args.leg === "PM" ? a.args.leg : null;
  if (!PLAN_TOOLS.has(a.tool) || !leg || !a.deps.store || !a.deps.source) return confirmCopy.done;
  const view = await loadBoard(a.deps.store, a.siteId, date, leg, a.deps.source);
  const over = vansOver(view, view.plan).map((id) => view.day.vans.find((v) => v.id === id)?.name ?? id);
  const texted = (
    await db.query<{ n: number }>(
      `SELECT count(DISTINCT child_token)::int AS n FROM ops.outbound_message
        WHERE site_id = $1 AND template_id = 'dropoff.late_eta' AND created_at >= $2`,
      [a.siteId, a.since.toISOString()],
    )
  ).rows[0]?.n ?? 0;
  const fit = over.length === 0 ? confirmCopy.everyVanFits : fill(confirmCopy.stillOver, { vans: over.join(", ") });
  return texted > 0 ? fill(confirmCopy.doneTexted, { fit, count: texted }) : fill(confirmCopy.doneFit, { fit });
}
