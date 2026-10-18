/**
 * THE "NEEDS A PERSON" TASK ROW, with no agent on it.
 *
 * `staff-alert.ts` is the whole of this feature — raising the alert, classifying why no model
 * answered, wording the card — and to do that it imports the agent's config and its provider
 * errors. That is correct there and wrong anywhere near a server action: the action the "For you"
 * tab posts to must reach no vendor at all (`vendor-failure-panel.test.ts`,
 * `key-never-leaves.test.ts`), and a server-action module is where the bundle walk stops, so
 * anything it imports is on its graph.
 *
 * So the three things a *caller outside the agent* needs — the category, the live states, and the
 * one UPDATE that marks an alert taken — live here, importing nothing but `Exec`.
 * `staff-alert.ts` re-exports them, so there is one name for each and not two.
 */
import type { Exec } from "@/db/exec";

/** `ops.task.category` for a model this deployment could not reach. */
export const MODEL_UNAVAILABLE_CATEGORY = "ASSISTANT_UNAVAILABLE";

/** The states an alert is still a person's work in. Closed ones leave the board. */
export const LIVE_ALERT_STATES = ["OPEN", "IN_PROGRESS"] as const;

/**
 * The same list as a SQL literal.
 *
 * Inlined rather than bound as a parameter because the driver has to be told the element type of
 * an enum array and `$n::task_state[]` does not survive the round trip through every backend this
 * runs on. Safe to inline precisely because these are module constants declared one line above —
 * no caller supplies them, so there is no value here that did not come from this file.
 */
export const sqlEnumList = (values: readonly string[]) => values.map((v) => `'${v}'`).join(", ");
export const LIVE_ALERT_STATES_SQL = sqlEnumList(LIVE_ALERT_STATES);

/**
 * A staff member took this alert: mark it taken, and say whether that was this call.
 *
 * `OPEN → IN_PROGRESS`, guarded on both the state and the site, so two coordinators pressing the
 * same button do not both think they are the one handling it, and an id from another tenant
 * updates nothing. It does **not** close the alert: only answering the family does that, and this
 * code cannot know when that happened.
 *
 * ON A POST, AND ONLY ON A POST (Firia's S1-4, 2026-10-18 12:13 AM ET). This used to run inside
 * the `/exceptions` page's GET render, where a link prefetch could claim an alert nobody had
 * read. Its one caller in `src/app` is now `family-texts/actions.ts` `takeAlertAction`, and
 * `family-texts/alert-taken-on-post.test.ts` holds that line with a scan.
 */
export async function openAlert(
  db: Exec,
  a: { id: string; siteIds: readonly string[]; by: string },
): Promise<{ readonly claimed: boolean }> {
  if (a.siteIds.length === 0) return { claimed: false };
  const r = await db.query<{ id: string }>(
    `UPDATE ops.task SET state = 'IN_PROGRESS', updated_by = $3, updated_at = now()
     WHERE id = $1 AND site_id = ANY($2::uuid[]) AND category = $4 AND state = 'OPEN'
     RETURNING id`,
    [a.id, a.siteIds, a.by, MODEL_UNAVAILABLE_CATEGORY],
  );
  return { claimed: r.rows.length > 0 };
}
