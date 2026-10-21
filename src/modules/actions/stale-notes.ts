/**
 * A STALE AGENT PLAN CARD LEAVES A NOTE (Vera, #124). When a person saves a leg after the agent wrote
 * a plan card for it, the card cannot be approved (`STALE_PLAN_CARD_SQL`, and Approve's 422) — but it
 * must not just vanish from For you. In its place is one line, the same words as the refusal:
 * "{child}'s plan changed after this card was written." with Open Plan routes. No Approve.
 *
 * The note stays until the coordinator dismisses it or opens Plan routes from it. That is kept on
 * the card's own `proposal` JSON (`stale_note_cleared`), so no column and no migration.
 */
import type { Exec } from "@/db/exec";
import { sqlPlanStoreIn } from "@/modules/plan/sql";
import { sqlDaySource } from "@/modules/roster/sql";
import { refusalOf, refusalWords } from "@/modules/changes/refusal";
import { loadBoard } from "@/modules/plan/store";
import { STALE_PLAN_CARD_SQL } from "./confirm-cards";
import { STAFF_ACTION_KIND, type StaleNoteView } from "./confirm-view";

/** The child a plan card is about: `move_child`'s, or a `save_plan`'s first move's. */
export function cardChild(args: Record<string, unknown>): string | null {
  if (typeof args.child_token === "string") return args.child_token;
  const first = Array.isArray(args.moves) ? (args.moves[0] as { child_token?: unknown } | undefined) : undefined;
  return typeof first?.child_token === "string" ? first.child_token : null;
}

/** The notes waiting at a centre: stale, undecided agent plan cards nobody has cleared yet. */
export async function staleNotes(db: Exec, siteId: string): Promise<readonly StaleNoteView[]> {
  const rows = await db.query<{ id: string; args: Record<string, unknown> | null }>(
    `SELECT a.id, a.proposal->'args' AS args FROM ops.approval_request a
      WHERE a.site_id = $1 AND a.decided_at IS NULL AND a.proposal->>'kind' = $2
        AND NOT (a.proposal ? 'stale_note_cleared') AND ${STALE_PLAN_CARD_SQL}
      ORDER BY a.created_at, a.id`,
    [siteId, STAFF_ACTION_KIND],
  );
  const store = sqlPlanStoreIn(db);
  const source = sqlDaySource(db, siteId);
  const out: StaleNoteView[] = [];
  for (const r of rows.rows) {
    const args = r.args ?? {};
    const at = { date: String(args.date ?? ""), leg: args.leg === "AM" ? ("AM" as const) : ("PM" as const) };
    const board = await loadBoard(store, siteId, at.date, at.leg, source).catch(() => null);
    const words = refusalWords(refusalOf({ reason: "STALE_CARD", vanId: null, childToken: cardChild(args) }, at, board));
    out.push({ approvalId: r.id, says: words.says, fix: words.fix });
  }
  return out;
}

/**
 * Clear one note: dismissed, or Plan routes opened from it. Only a stale, undecided card at this
 * centre — a live card is never touched, and the card itself stays undecided (Approve still 422s).
 */
export async function clearStaleNote(
  db: Exec,
  a: { readonly siteId: string; readonly approvalId: string; readonly userId: string; readonly how: "DISMISSED" | "OPENED_PLAN_ROUTES"; readonly now: Date },
): Promise<boolean> {
  const done = await db.query<{ id: string }>(
    `UPDATE ops.approval_request a
        SET proposal = a.proposal || jsonb_build_object('stale_note_cleared', jsonb_build_object('how', $3::text, 'by', $4::text, 'at', $5::text))
      WHERE a.id = $1 AND a.site_id = $2 AND a.decided_at IS NULL AND a.proposal->>'kind' = '${STAFF_ACTION_KIND}'
        AND NOT (a.proposal ? 'stale_note_cleared') AND ${STALE_PLAN_CARD_SQL}
      RETURNING a.id`,
    [/^[0-9a-f-]{36}$/i.test(a.approvalId) ? a.approvalId : null, a.siteId, a.how, `staff:${a.userId}`, a.now.toISOString()],
  );
  return done.rows.length === 1;
}
