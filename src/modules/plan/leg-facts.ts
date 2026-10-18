/**
 * THE LEGS OF ONE DATE, FOR THE SCREENS THAT SHOW AN ARRIVAL — the read half of what Approve
 * writes (`./leg-write.ts`).
 *
 * SOURCE: Firia's 11:11 AM ET ruling of 2026-10-18 — "the plan must really change". Pressing
 * Approve now writes the agreed drop-off to `ops.trip_leg.window_start` and the receiver to the
 * child's file; this is how Today reads them back, because `src/domain/board` is a pure function
 * of a fixture day and would otherwise go on showing the scheduled window and the hold however
 * many decisions had been made.
 *
 * Shaped exactly like `savedPlacementsForBoard` and `savedSetupsForBoard` (`./store.ts`) and for
 * the same reasons: keyed in the vocabulary `buildBoard` speaks (fixture child keys, by
 * direction), and **it never throws at the page** — a session with no centre, a server with no
 * database and a query that raises all land on "the scenario's own day", which is what the
 * browser checks run on.
 */
import { getNeonDb, type Db, type Exec } from "@/db/exec";
import type { BoardLegFacts, LegFact } from "@/domain/board/board";
import type { Direction } from "@/domain/day/leg";
import { childKeyOfToken } from "@/modules/demo/fixtures/standard";
import { hasNoDatabase } from "./store";
import { siteHhmm } from "./leg-write";

type LegRow = {
  child_token: string;
  direction: string;
  window_start: Date | string | null;
  receiver_on_file: boolean;
};

/**
 * One date's legs, read inside whatever `Exec` the caller has — so an approval's own transaction
 * can read back what it just wrote, and a page read can use the pooled connection.
 *
 * The receiver is `EXISTS` over §6.4's authorizations with scope `RECEIVE_CHILD`, which is the
 * one file that answers "may an adult be handed this child" everywhere else in this app
 * (`modules/outbox/policy.ts`, `family-texts/checks.ts`) and the row `recordLegReceiver` writes.
 */
export async function legFactsIn(tx: Exec, siteId: string, date: string): Promise<BoardLegFacts> {
  const rows = await tx.query<LegRow>(
    `SELECT l.child_token::text AS child_token, l.direction::text AS direction, l.window_start,
            EXISTS (
              SELECT 1 FROM ops.contact_authorization a
               WHERE a.site_id = l.site_id AND a.child_token = l.child_token
                 AND a.scope = 'RECEIVE_CHILD'
                 AND (a.valid_to IS NULL OR a.valid_to > now())
            ) AS receiver_on_file
       FROM ops.trip_leg l
      WHERE l.site_id = $1 AND l.service_date = $2`,
    [siteId, date],
  );
  const facts: { -readonly [D in Direction]?: Record<string, LegFact> } = {};
  for (const row of rows.rows) {
    const childKey = childKeyOfToken(row.child_token);
    const direction = row.direction === "AM" ? "AM" : row.direction === "PM" ? "PM" : null;
    // A token this deployment's roster cannot name is a leg no board row is keyed by: skipped,
    // never guessed at.
    if (childKey === null || direction === null) continue;
    const at = row.window_start === null ? null : new Date(row.window_start);
    const legs = (facts[direction] ??= {});
    legs[childKey] = {
      dropoffTime: at === null || Number.isNaN(at.getTime()) ? null : siteHhmm(at),
      receiverOnFile: row.receiver_on_file,
    };
  }
  return facts;
}

/** The same read, for a page: its own connection, no centre or no database answered as `{}`. */
export async function legFactsForBoard(
  siteId: string | null,
  date: string,
  db?: Db,
): Promise<BoardLegFacts> {
  if (!siteId || (db === undefined && hasNoDatabase())) return {};
  try {
    return await legFactsIn(db ?? getNeonDb(), siteId, date);
  } catch {
    return {};
  }
}
