/**
 * The confirm cards waiting at a centre (ledger #74 d), as the bubble draws them: the card's id and
 * its one line. A plain read of `ops.approval_request` — no action layer, no plan writers — so the
 * shell can show them on every page without pulling those into its graph.
 */
import type { Exec } from "@/db/exec";
import { STAFF_ACTION_KIND, type ConfirmView } from "./confirm-view";
import { namedOrNull } from "@/modules/identity/names";
import { staffActionSummary } from "./summary";

export type { ConfirmView } from "./confirm-view";

/**
 * A PLAN CARD THE BOARD MOVED PAST (ledger #75 c): the leg it would re-plan was saved after the card
 * was drafted — a person fixed it on the board first. Confirming it would re-plan over their work,
 * so it is not offered; the thread says "Already handled on the board." in its place. Both times
 * are the database's clock (`updated_at`, `created_at`), never a caller's. One SQL
 * predicate over `a` (the approval row), shared by this read and the thread's (ask/thread.ts).
 */
export const STALE_PLAN_CARD_SQL = `(
  a.proposal->>'tool' IN ('auto_plan', 'save_plan', 'move_child') AND EXISTS (
    SELECT 1 FROM ops.plan_run p
     WHERE p.site_id = a.site_id AND p.service_date::text = a.proposal->'args'->>'date'
       AND p.direction::text = a.proposal->'args'->>'leg' AND p.updated_at > a.created_at))`;

export async function confirmCards(db: Exec, siteId: string): Promise<readonly ConfirmView[]> {
  const rows = await db.query<{ id: string; tool: string | null; args: Record<string, unknown> | null; note: string | null; summary: string | null; impact: string[] | null }>(
    `SELECT a.id, a.proposal->>'tool' AS tool, a.proposal->'args' AS args, a.proposal->>'note' AS note,
            a.proposal->>'summary' AS summary, a.proposal->'impact' AS impact FROM ops.approval_request a
      WHERE a.site_id = $1 AND a.decided_at IS NULL AND a.proposal->>'kind' = $2 AND NOT ${STALE_PLAN_CARD_SQL}
      ORDER BY a.created_at, a.id`,
    [siteId, STAFF_ACTION_KIND],
  );
  return rows.rows.map((r) => ({
    approvalId: r.id,
    // The card's own title where it was written with one (a re-plan draft), else the tool's line.
    summary: r.summary ?? staffActionSummary(r.tool ?? "", r.args ?? {}),
    // A note this roster cannot name in full is no note: the card falls back to the summary.
    note: namedOrNull(r.note),
    impact: Array.isArray(r.impact) ? r.impact.filter((line): line is string => typeof line === "string") : [],
  }));
}
