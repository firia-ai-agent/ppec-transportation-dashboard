/**
 * WHAT IS WAITING FOR A PERSON, IN ONE ORDER (ledger #77).
 *
 * The staff prompt labels the site's open tasks `TK-n` and its undecided cards `CARD-n`
 * (`staff-ask-context.ts`), and `get_waiting` lists them under the same labels — so both read
 * them here, in one order, and a label the model read in the prompt is the one it can name.
 */
import type { Exec } from "@/db/exec";
import { STAFF_ACTION_KIND } from "@/modules/actions/confirm-view";
import { DROPOFF_CHANGE_KIND } from "@/modules/approvals/dropoff-change";
import { MESSAGE_SEND_KIND } from "@/modules/approvals/message-send";

/** The cards a person decides on a screen: For you's replies and drop-offs, and confirm cards. */
const CARD_KINDS = [DROPOFF_CHANGE_KIND, MESSAGE_SEND_KIND, STAFF_ACTION_KIND];

export type WaitingTask = { id: string; category: string; severity: string; state: string; summary: string };
export type WaitingCard = { id: string; kind: string; summary: string };

/**
 * The site's open tasks, oldest first — the board as it stands. The run's own task (the ask, or
 * the alert it was started by) is left out: it is in T1 already.
 */
export async function openTaskRows(db: Exec, siteId: string, ownTaskId: string, limit: number): Promise<WaitingTask[]> {
  const r = await db.query<WaitingTask>(
    `SELECT id, category::text AS category, severity::text AS severity, state::text AS state, summary
     FROM ops.task
     WHERE site_id = $1 AND id <> $2 AND state = 'OPEN'
     ORDER BY created_at, id LIMIT $3`,
    [siteId, ownTaskId, limit],
  );
  return r.rows;
}

/** The site's undecided cards, oldest first: For you's and confirm cards alike. */
export async function pendingCardRows(db: Exec, siteId: string, limit: number): Promise<WaitingCard[]> {
  const r = await db.query<WaitingCard>(
    `SELECT id, coalesce(proposal->>'kind', '') AS kind,
            coalesce(proposal->>'summary', proposal->>'alert_text', proposal->>'reply', proposal->>'body', '') AS summary
       FROM ops.approval_request
      WHERE site_id = $1 AND decided_at IS NULL AND proposal->>'kind' = ANY($3::text[])
      ORDER BY created_at, id LIMIT $2`,
    [siteId, limit, CARD_KINDS],
  );
  return r.rows;
}
