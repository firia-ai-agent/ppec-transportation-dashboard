/**
 * What the board's child panel actually writes: the three need items on a child's **approved**
 * transport profile.
 *
 * SOURCE: the founder's 7:17 PM ET change (a child card opens a panel with Wheelchair, Car seat
 * and Oxygen) and Athena's schema answer at 7:19 PM, signed off by Firia: **no migration**.
 * `ops.transport_need_item.category` is `text` (schema.ts:218-223), so `OXYGEN` is a new string
 * and not a new column; `state` is the existing `need_item_state` enum and `APPROVED` is already
 * one of its values.
 *
 * Three rules, and each of them is a decision somebody could get wrong:
 *
 *  - **No new profile version.** The panel edits the items on the one `APPROVED` profile the
 *    child already has (`transport_profile_one_approved_uq`), it does not supersede it. A new
 *    version is an intake decision with an approver behind it; this is a coordinator fixing what
 *    the day plans against.
 *  - **Off is not deleted.** Turning a need off sets the item's state to `UNKNOWN` rather than
 *    removing the row: only `APPROVED` is planned against (DECISION-LEDGER row 1), and the
 *    record of what was once held about a child is not the planner's to throw away.
 *  - **`mobility` is left alone.** A chair is the approved `WHEELCHAIR_SECUREMENT` item, which is
 *    what the planner reads (src/domain/plan/needs.ts); the profile's `mobility` column, its
 *    securement and its measurements are intake's and are untouched here.
 *
 * Site-scoped and parameterised. Nothing here decides *who* may write: that is the access
 * table's answer, taken by the route before it gets this far.
 */
import { uuidv7 } from "uuidv7";
import { PANEL_CATEGORIES } from "@/config/equipment";
import type { Db, Exec } from "@/db/exec";
import { categoryChangesFor, needsFromCategories, type PanelNeeds } from "@/domain/plan/needs";
import type { NeedFlags } from "@/config/equipment";

/** Written to `created_by` / `updated_by`: the surface that wrote the row, never a person. */
const BY = "plan-board-child-panel";

export type SetChildNeedsInput = {
  siteId: string;
  childToken: string;
  panel: PanelNeeds;
  /** The staff user, for the audit columns. Null for a session with no identity. */
  actor: string | null;
  now?: Date;
};

export type SetChildNeedsOutcome =
  | { ok: true; needs: NeedFlags }
  /** No approved profile for this child at this site: the same uniform refusal as a bad id. */
  | { ok: false; reason: "NO_PROFILE" };

export async function setChildNeeds(
  db: Db,
  input: SetChildNeedsInput,
): Promise<SetChildNeedsOutcome> {
  return db.tx(async (tx) => writeNeeds(tx, input));
}

async function writeNeeds(tx: Exec, input: SetChildNeedsInput): Promise<SetChildNeedsOutcome> {
  const profile = await tx.query<{ id: string }>(
    `SELECT id::text AS id FROM ops.transport_profile
      WHERE site_id = $1 AND child_token = $2 AND status = 'APPROVED'
      FOR UPDATE`,
    [input.siteId, input.childToken],
  );
  const profileId = profile.rows[0]?.id;
  if (!profileId) return { ok: false, reason: "NO_PROFILE" };

  const { on, off } = categoryChangesFor(input.panel);
  const at = (input.now ?? new Date()).toISOString();

  for (const category of on) {
    // One row per category on this profile: insert it, or approve the one that is already there.
    const existing = await tx.query<{ id: string }>(
      `SELECT id::text AS id FROM ops.transport_need_item
        WHERE profile_id = $1 AND category = $2 LIMIT 1`,
      [profileId, category],
    );
    const id = existing.rows[0]?.id;
    if (id) {
      await tx.query(
        `UPDATE ops.transport_need_item
            SET state = 'APPROVED', updated_at = $2, updated_by = $3, version = version + 1
          WHERE id = $1`,
        [id, at, BY],
      );
      continue;
    }
    await tx.query(
      `INSERT INTO ops.transport_need_item
         (id, site_id, profile_id, category, value, state, created_by, updated_by, source_mode)
       VALUES ($1, $2, $3, $4, $5::jsonb, 'APPROVED', $6, $6, 'SIMULATED')`,
      [uuidv7(), input.siteId, profileId, category, JSON.stringify({ setBy: "BOARD" }), BY],
    );
  }

  for (const category of off) {
    await tx.query(
      `UPDATE ops.transport_need_item
          SET state = 'UNKNOWN', updated_at = $3, updated_by = $4, version = version + 1
        WHERE profile_id = $1 AND category = $2 AND state <> 'UNKNOWN'`,
      [profileId, category, at, BY],
    );
  }

  const approved = await tx.query<{ category: string }>(
    `SELECT category FROM ops.transport_need_item WHERE profile_id = $1 AND state = 'APPROVED'`,
    [profileId],
  );
  return { ok: true, needs: needsFromCategories(approved.rows.map((row) => row.category)) };
}

/** The categories this write path is allowed to touch, for a route that refuses anything else. */
export const WRITABLE_CATEGORIES = PANEL_CATEGORIES;
