/**
 * The confirm cards waiting at a centre (ledger #74 d), as the bubble draws them: the card's id and
 * its one line. A plain read of `ops.approval_request` — no action layer, no plan writers — so the
 * shell can show them on every page without pulling those into its graph.
 */
import type { Exec } from "@/db/exec";
import { STAFF_ACTION_KIND, type ConfirmView } from "./confirm-view";
import { staffActionSummary } from "./summary";

export type { ConfirmView } from "./confirm-view";

export async function confirmCards(db: Exec, siteId: string): Promise<readonly ConfirmView[]> {
  const rows = await db.query<{ id: string; tool: string | null; args: Record<string, unknown> | null }>(
    `SELECT id, proposal->>'tool' AS tool, proposal->'args' AS args FROM ops.approval_request
      WHERE site_id = $1 AND decided_at IS NULL AND proposal->>'kind' = $2 ORDER BY created_at, id`,
    [siteId, STAFF_ACTION_KIND],
  );
  return rows.rows.map((r) => ({ approvalId: r.id, summary: staffActionSummary(r.tool ?? "", r.args ?? {}) }));
}
