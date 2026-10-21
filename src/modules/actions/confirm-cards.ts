/**
 * The confirm cards waiting at a centre (ledger #74 d), as the bubble draws them: the card's id and
 * its one line. A plain read of `ops.approval_request` — no action layer, no plan writers — so the
 * shell can show them on every page without pulling those into its graph.
 *
 * It does read the *board* a plan card is about, to name the child and the van the card would move
 * (Vera). That is the same read the stale card's words already make from this same
 * screen (`stale-notes.ts staleCardWords`), it is fail-soft, and it is one query per leg however
 * many cards name it — never a writer, and never the action layer.
 */
import type { Exec } from "@/db/exec";
import { STAFF_ACTION_KIND, type ConfirmView } from "./confirm-view";
import { childFirstName } from "@/modules/identity/display-name";
import { namedOrNull } from "@/modules/identity/names";
import { sqlPlanStoreIn } from "@/modules/plan/sql";
import { sqlDaySource } from "@/modules/roster/sql";
import { loadBoard } from "@/modules/plan/store";
import { staffActionDecline, staffActionSummary, type CardNames } from "./summary";

export type { ConfirmView } from "./confirm-view";

/**
 * A PLAN CARD THE BOARD MOVED PAST (ledger #75 c): the leg it would re-plan was saved after the card
 * was drafted — a person fixed it on the board first. Confirming it would re-plan over their work,
 * so it is not offered; in its place For you leaves a note and the thread a line saying the plan
 * changed after the card was written, both with Open Plan routes (Vera — "Already handled on
 * the board." is now only for a card somebody decided with no outcome recorded). Both times
 * are the database's clock (`updated_at`, `created_at`), never a caller's — except that a card carrying
 * `basis_version` is judged by version: a save's `updated_at` is its transaction's *start*, so a card
 * drafted on the old board while that save was still committing looked newer than it (ledger #86). One SQL
 * predicate over `a` (the approval row), shared by this read and the thread's (ask/thread.ts). A
 * `basis_version` that is not a number names no board, so the card is not offered — and the read
 * never casts it, so one bad row cannot break the list for the site (PPE-111).
 */
export const STALE_PLAN_CARD_SQL = `(
  a.proposal->>'tool' IN ('auto_plan', 'save_plan', 'move_child') AND EXISTS (
    SELECT 1 FROM ops.plan_run p
     WHERE p.site_id = a.site_id AND p.service_date::text = a.proposal->'args'->>'date'
       AND p.direction::text = a.proposal->'args'->>'leg'
       AND CASE WHEN a.proposal->'args' ? 'basis_version'
                THEN jsonb_typeof(a.proposal->'args'->'basis_version') <> 'number'
                     OR p.version > (a.proposal->'args'->>'basis_version')::numeric
                ELSE p.updated_at > a.created_at END))`;

/**
 * TWO CARDS FOR ONE CHANGE ARE ONE CARD (Vera).
 *
 * A proposal is written per agent run, and a run can be driven twice over one situation — a staging
 * script run again, an alert heard twice, a retry whose first attempt had already committed. Each
 * write is its own `approval_request` under its own `approval_key`, so nothing upstream collapses
 * them, and For you showed the identical card twice: two Approves for one move, the second of which
 * can only fail or re-do what the first did.
 *
 * What identifies a card is **the change it would make** — its tool and its arguments, minus
 * `basis_version`, which records the board it was written against and not what it does. Same key,
 * same change: the one the person has had on screen longest is kept (the read is already in
 * `created_at` order). Any argument differing makes it a different change and both stay. Nothing is
 * merged, nothing is decided and no row is touched: this is only what the list offers.
 */
function changeKey(tool: string, args: Record<string, unknown>): string {
  const stable = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(stable);
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .filter(([k]) => k !== "basis_version")
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([k, v]) => [k, stable(v)]),
      );
    }
    return value;
  };
  return `${tool}|${JSON.stringify(stable(args))}`;
}

type Board = Awaited<ReturnType<typeof loadBoard>>;

/**
 * The child and the van a plan card names, as the board it is about names them.
 *
 * The card stores a child token and a vehicle id, which are not words anybody reads, and this app
 * has one place that turns them into both names at once: the board. The child comes back as their
 * first name, from the one helper (`childFirstName`) — "Move Noah to Van 3", never "Noah O.".
 *
 * Fail-soft, and one board per leg however many cards are about it: a board that will not load
 * leaves both names null and the card keeps the line it has always had.
 */
async function cardNames(db: Exec, siteId: string, args: Record<string, unknown>, boards: Map<string, Promise<Board | null>>): Promise<CardNames> {
  const date = typeof args.date === "string" ? args.date : "";
  const leg = args.leg === "AM" ? ("AM" as const) : args.leg === "PM" ? ("PM" as const) : null;
  const token = typeof args.child_token === "string" ? args.child_token : null;
  const vanId = typeof args.van_id === "string" ? args.van_id : null;
  if (date === "" || leg === null || token === null || vanId === null) return {};
  const key = `${date}|${leg}`;
  if (!boards.has(key)) boards.set(key, loadBoard(sqlPlanStoreIn(db), siteId, date, leg, sqlDaySource(db, siteId)).catch(() => null));
  const board = await boards.get(key)!;
  if (!board) return {};
  const label = [...board.day.riders, ...board.day.others].find((c) => c.token === token)?.name ?? null;
  return {
    child: label === null ? null : childFirstName(label) || null,
    van: board.day.vans.find((v) => v.id === vanId)?.name ?? null,
  };
}

export async function confirmCards(db: Exec, siteId: string): Promise<readonly ConfirmView[]> {
  const rows = await db.query<{ id: string; tool: string | null; args: Record<string, unknown> | null; note: string | null; summary: string | null; impact: string[] | null }>(
    `SELECT a.id, a.proposal->>'tool' AS tool, a.proposal->'args' AS args, a.proposal->>'note' AS note,
            a.proposal->>'summary' AS summary, a.proposal->'impact' AS impact FROM ops.approval_request a
      WHERE a.site_id = $1 AND a.decided_at IS NULL AND a.proposal->>'kind' = $2 AND NOT ${STALE_PLAN_CARD_SQL}
      ORDER BY a.created_at, a.id`,
    [siteId, STAFF_ACTION_KIND],
  );
  const boards = new Map<string, Promise<Board | null>>();
  const seen = new Set<string>();
  const cards: ConfirmView[] = [];
  for (const r of rows.rows) {
    const tool = r.tool ?? "";
    const args = r.args ?? {};
    const key = changeKey(tool, args);
    if (seen.has(key)) continue;
    seen.add(key);
    /*
     * A move says who moves and where: "Move Noah to Van 3 on the afternoon plan and save it.",
     * built from this card's own stored arguments. It is preferred over the summary stored on the
     * row, because that was written when the card was — by a writer with no board in hand — so the
     * cards already in the queue read right too. A child or van this board cannot name falls back.
     */
    const named = tool === "move_child" ? staffActionSummary(tool, args, await cardNames(db, siteId, args, boards)) : null;
    cards.push({
      approvalId: r.id,
      // The card's own title where it was written with one (a re-plan draft), else the tool's line.
      summary: named ?? r.summary ?? staffActionSummary(tool, args),
      // A note this roster cannot name in full is no note: the card falls back to the summary.
      note: namedOrNull(r.note),
      // What Don't refuses, in the card's own verb (Vera).
      decline: staffActionDecline(tool),
      impact: Array.isArray(r.impact) ? r.impact.filter((line): line is string => typeof line === "string") : [],
    });
  }
  return cards;
}
