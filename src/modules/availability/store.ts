import { uuidv7 } from "uuidv7";
import { availabilityConfig } from "@/config/live";
import type { Exec } from "@/db/exec";
import type { Direction } from "@/domain/day/leg";
import { hhmmOf, minuteOfDay } from "@/domain/plan/arrivals";
import type { TimeSlot } from "@/domain/day/source";

/**
 * AVAILABILITY (ledger #83; PRD TRP-02, §6.4, RES-02).
 *
 * Two objects, kept apart on purpose:
 *  - what a family **asked** is a `change_request` of kind AVAILABILITY, with the message it came
 *    from. It is PROPOSED only when the sender may say when the child can be received
 *    (`CONFIRM_AVAILABILITY_TO_RECEIVE` for that child, now); otherwise NEEDS_HUMAN, because a
 *    phone match is recognised, not authorised.
 *  - what a person **approved** is an `ops.availability` row: tier-T1 fact, one live row per child,
 *    date and leg. Only Approve writes one, in the same transaction as the leg's window.
 */

export const AVAILABILITY_CHANGE_KIND = "AVAILABILITY";

/** May this adult tell us when this child can be received, at this moment? (§6.4, re-asked each time.) */
export async function mayConfirmAvailability(
  tx: Exec,
  q: { siteId: string; contactToken: string | null; childToken: string; at: Date },
): Promise<boolean> {
  if (!q.contactToken) return false;
  const r = await tx.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM ops.contact_authorization
      WHERE site_id = $1 AND contact_token = $2::uuid AND child_token = $3::uuid
        AND scope = 'CONFIRM_AVAILABILITY_TO_RECEIVE'
        AND valid_from <= $4 AND (valid_to IS NULL OR valid_to > $4)`,
    [q.siteId, q.contactToken, q.childToken, q.at],
  );
  return (r.rows[0]?.n ?? 0) > 0;
}

/** The family's request, as evidence (never authority): one row, PROPOSED or NEEDS_HUMAN. */
export async function recordAvailabilityRequest(
  tx: Exec,
  input: {
    id: string; siteId: string; childToken: string; contactToken: string | null;
    serviceDate: string; direction: Direction; time: string;
    basisMessageId: string | null; now: Date; by: string;
  },
): Promise<{ id: string; status: "PROPOSED" | "NEEDS_HUMAN" }> {
  const authorised = await mayConfirmAvailability(tx, {
    siteId: input.siteId, contactToken: input.contactToken, childToken: input.childToken, at: input.now,
  });
  const status = authorised ? "PROPOSED" : "NEEDS_HUMAN";
  const start = minuteOfDay(input.time);
  const payload = {
    leg: input.direction, date: input.serviceDate, kind: "CAN",
    start: input.time, end: start === null ? null : hhmmOf(start + availabilityConfig.slotMinutes),
    contact_token: input.contactToken,
  };
  await tx.query(
    `INSERT INTO ops.change_request
       (id, site_id, kind, subject_child_tokens, basis_message_id, payload, status, created_at, created_by, updated_at, updated_by)
     VALUES ($1, $2, $3, ARRAY[$4::uuid], $5, $6::jsonb, $7, $8, $9, $8, $9)
     ON CONFLICT (id) DO NOTHING`,
    [input.id, input.siteId, AVAILABILITY_CHANGE_KIND, input.childToken, input.basisMessageId,
      JSON.stringify(payload), status, input.now, input.by],
  );
  return { id: input.id, status };
}

/** A decided request: APPLIED by Approve, REJECTED by "Don't send". Only an open one moves. */
export async function settleAvailabilityRequest(
  tx: Exec,
  input: { id: string; siteId: string; status: "APPLIED" | "REJECTED"; now: Date; by: string },
): Promise<void> {
  await tx.query(
    `UPDATE ops.change_request
        SET status = $3, updated_at = $4, updated_by = $5, version = version + 1
      WHERE id = $1 AND site_id = $2 AND kind = $6 AND status IN ('PROPOSED', 'NEEDS_HUMAN')`,
    [input.id, input.siteId, input.status, input.now, input.by, AVAILABILITY_CHANGE_KIND],
  );
}

/**
 * THE APPROVED SLOT: the time plus `slotMinutes`, for this child, date and leg. A slot already live
 * for the same ride is superseded by this one, in the same statement pair, so there is never two.
 */
export async function recordApprovedSlot(
  tx: Exec,
  input: {
    siteId: string; childToken: string; contactToken: string | null;
    serviceDate: string; direction: Direction; time: string;
    changeRequestId: string | null; approvalId: string | null; now: Date; by: string;
  },
): Promise<{ ok: true; id: string } | { ok: false; reason: "BAD_TIME" }> {
  const start = minuteOfDay(input.time);
  if (start === null) return { ok: false, reason: "BAD_TIME" };
  const end = Math.min(1440, start + availabilityConfig.slotMinutes);
  const id = uuidv7();
  await tx.query(
    `UPDATE ops.availability
        SET superseded_by = $5, updated_at = $6, updated_by = $7, version = version + 1
      WHERE site_id = $1 AND child_token = $2::uuid AND service_date = $3 AND direction = $4 AND superseded_by IS NULL`,
    [input.siteId, input.childToken, input.serviceDate, input.direction, id, input.now, input.by],
  );
  await tx.query(
    `INSERT INTO ops.availability
       (id, site_id, child_token, contact_token, direction, service_date, start_min, end_min,
        change_request_id, approval_id, created_at, created_by, updated_at, updated_by)
     VALUES ($1, $2, $3::uuid, $4, $5, $6, $7, $8, $9, $10, $11, $12, $11, $12)`,
    [id, input.siteId, input.childToken, input.contactToken, input.direction, input.serviceDate, start, end,
      input.changeRequestId, input.approvalId, input.now, input.by],
  );
  return { ok: true, id };
}

/** This day's approved slots on one leg, by child token: what the board, preview and agent read. */
export async function approvedSlots(
  db: Exec,
  q: { siteId: string; serviceDate: string; direction: Direction },
): Promise<Map<string, TimeSlot[]>> {
  const rows = await db.query<{ child_token: string; start_min: number; end_min: number }>(
    `SELECT child_token::text AS child_token, start_min, end_min FROM ops.availability
      WHERE site_id = $1 AND service_date = $2 AND direction = $3 AND superseded_by IS NULL
      ORDER BY start_min`,
    [q.siteId, q.serviceDate, q.direction],
  );
  const slots = new Map<string, TimeSlot[]>();
  for (const row of rows.rows) {
    const list = slots.get(row.child_token) ?? [];
    list.push({ start: hhmmOf(row.start_min), end: hhmmOf(row.end_min) });
    slots.set(row.child_token, list);
  }
  return slots;
}
