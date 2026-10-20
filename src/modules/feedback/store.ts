import { uuidv7 } from "uuidv7";
import { z } from "zod";
import type { Db } from "@/db/exec";
import { FEEDBACK_MAX } from "./limits";

/**
 * STAFF FEEDBACK (ledger #82): one line a member of staff wants changed, from the DEMO bar.
 *
 * Words about a screen, written by staff, so the body is never logged (NFR-10) and the read is the
 * director's. The row carries the standard columns (§6.1) and one audit line (NFR-05).
 */

export const feedbackBody = z.strictObject({
  body: z.string().trim().min(1).max(FEEDBACK_MAX),
  /** The screen it was written on: an app path, never a full URL. */
  pagePath: z.string().regex(/^\/[A-Za-z0-9/_\-()[\]?=&.]*$/).max(200),
});

export type FeedbackInput = z.infer<typeof feedbackBody>;

export type OpenFeedback = {
  readonly id: string;
  readonly pagePath: string;
  readonly body: string;
  readonly by: string;
  readonly at: string;
};

export async function addFeedback(
  db: Db,
  input: FeedbackInput & { siteId: string; by: string; now: Date },
): Promise<{ id: string }> {
  const id = uuidv7();
  await db.tx(async (tx) => {
    await tx.query(
      `INSERT INTO ops.feedback (id, site_id, page_path, body, created_at, created_by, updated_at, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $5, $6)`,
      [id, input.siteId, input.pagePath, input.body, input.now, input.by],
    );
    // The audit line names the row, never the words.
    await tx.query(
      `INSERT INTO ops.audit_event (site_id, actor, action, entity, entity_id, to_version, at)
       VALUES ($1, $2, 'feedback.add', 'feedback', $3, 1, $4)`,
      [input.siteId, input.by, id, input.now],
    );
  });
  return { id };
}

/** The site's open feedback, newest first. */
export async function openFeedback(db: Db, siteId: string, limit = 100): Promise<OpenFeedback[]> {
  const rows = await db.query<{ id: string; page_path: string; body: string; created_by: string; created_at: Date | string }>(
    `SELECT id::text AS id, page_path, body, created_by, created_at
       FROM ops.feedback
      WHERE site_id = $1 AND status = 'OPEN'
      ORDER BY created_at DESC
      LIMIT $2`,
    [siteId, limit],
  );
  return rows.rows.map((row) => ({
    id: row.id,
    pagePath: row.page_path,
    body: row.body,
    by: row.created_by,
    at: new Date(row.created_at).toISOString(),
  }));
}
