/**
 * THE TWO THINGS AN APPROVED DROP-OFF CHANGE WRITES ON A LEG — the agreed time, and the adult
 * who will be there to take the child.
 *
 * SOURCE: Firia's 11:11 AM ET ruling of 2026-10-18 — "when staff press Approve the plan must
 * really change, not just the text". Until now the decision saved a placement (the van and the
 * bucket, `plan/place.ts`) and queued the words, and the **time** the family had just been
 * promised existed nowhere but in those words. `plan_run` / `plan_assignment` have no time column
 * at all (migration 0009), so the agreed time's one home in this schema is the leg's own
 * `ops.trip_leg.window_start` — which is where every screen that shows an arrival already looks
 * (`modules/plan/leg-facts.ts` is the read).
 *
 * Both writes are **named functions in the plan module**, not SQL in a screen or in the approval
 * path, for the reason gap-5 exists: one writer per fact. Both are guarded by **site and leg id
 * together** and take the `Exec` they are handed, so they are steps of the caller's transaction —
 * an approval that rolls back leaves no moved time and no receiver behind it.
 *
 * What is deliberately NOT written here: `trip_leg.plan_version`. The outbox's staleness rule
 * compares a queued message's `plan_version_basis` to that counter at drain
 * (`modules/outbox/outbox.ts`), and a decision that bumped it would cancel its own text. The plan
 * version a decision moves is `plan_run.version`, once, through the board's own writer (Veri
 * S1-3.2: two counters, one question).
 */
import { uuidv7 } from "uuidv7";
import type { Exec } from "@/db/exec";
import { SITE_TIME_ZONE } from "@/ui/service-date";

/* ───────────────────────────── a wall-clock time on a service date ───────────────────────────── */

const ZONE_PARTS = new Intl.DateTimeFormat("en-US", {
  timeZone: SITE_TIME_ZONE,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

/** How far the site's clock is from UTC at a given instant, in ms. Positive east of Greenwich. */
function zoneOffsetMs(utcMs: number): number {
  const parts = ZONE_PARTS.formatToParts(new Date(utcMs));
  const value = (type: string): number => Number(parts.find((part) => part.type === type)?.value ?? "0");
  const asIfUtc = Date.UTC(
    value("year"),
    value("month") - 1,
    value("day"),
    value("hour"),
    value("minute"),
    value("second"),
  );
  return asIfUtc - utcMs;
}

/**
 * The instant a site-local "HH:MM" falls on, on a service date (PRD §6.1: a service date is a
 * calendar date in the site's timezone, never an instant).
 *
 * Two passes, which is what makes it right across a DST boundary: the first offset is read at the
 * naive guess, the second at the instant that offset produced — so 17:00 on a November Sunday is
 * 17:00 on the wall either side of the change rather than an hour out.
 *
 * `null` for anything that is not a wall-clock time or a calendar date, so a bad proposal is a
 * refusal the coordinator reads and never a leg silently moved to midnight.
 */
export function siteInstantOn(serviceDate: string, hhmm: string): Date | null {
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(serviceDate.trim());
  const clock = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!day || !clock) return null;
  const hours = Number(clock[1]);
  const minutes = Number(clock[2]);
  if (hours > 23 || minutes > 59) return null;
  const naive = Date.UTC(Number(day[1]), Number(day[2]) - 1, Number(day[3]), hours, minutes);
  const settled = naive - zoneOffsetMs(naive - zoneOffsetMs(naive));
  return new Date(settled);
}

/* ───────────────────────────── the agreed drop-off time ───────────────────────────── */

export type LegWindowInput = {
  readonly siteId: string;
  readonly legId: string;
  /** The date the leg is on, as the proposal names it. Part of the guard, not just a lookup. */
  readonly serviceDate: string;
  /** Site-local "HH:MM" — the time the family asked for and a coordinator approved. */
  readonly time: string;
  readonly now: Date;
  /** `staff:<uuid>` — the audit string the rest of the decision carries. */
  readonly by: string;
};

export type LegWindowWritten =
  | { readonly ok: true; readonly windowStart: Date }
  | { readonly ok: false; readonly reason: "BAD_TIME" | "NO_SUCH_LEG" };

/**
 * Move one leg's drop-off window to a time, by leg id **and** site **and** service date.
 *
 * All three in the `WHERE`: the id alone would let another site's leg be moved by a row that
 * named it, and the date is what keeps a proposal written for one day off a leg that has since
 * been re-seeded onto another. A leg none of the three matches is `NO_SUCH_LEG` — a refusal for
 * the caller to roll back on, never zero rows reported as a success.
 */
export async function setLegDropoffWindow(tx: Exec, input: LegWindowInput): Promise<LegWindowWritten> {
  const windowStart = siteInstantOn(input.serviceDate, input.time);
  if (windowStart === null) return { ok: false, reason: "BAD_TIME" };
  const moved = await tx.query<{ id: string }>(
    `UPDATE ops.trip_leg
        SET window_start = $4, updated_at = $5, updated_by = $6, version = version + 1
      WHERE id = $1 AND site_id = $2 AND service_date = $3
      RETURNING id`,
    [input.legId, input.siteId, input.serviceDate, windowStart, input.now, input.by],
  );
  if (moved.rows.length !== 1) return { ok: false, reason: "NO_SUCH_LEG" };
  return { ok: true, windowStart };
}

/* ───────────────────────────── the adult who will receive the child ───────────────────────────── */

export type LegReceiverInput = {
  readonly siteId: string;
  readonly legId: string;
  readonly childToken: string;
  /**
   * WHO will receive the child: the guardian whose message asked for the change (PPE-98), carried
   * on the proposal from the run's own trigger. Required — the earliest contact on the child's file
   * is not a stand-in for the adult who said they would be home.
   */
  readonly contactToken: string | null;
  readonly now: Date;
  readonly by: string;
};

export type LegReceiverWritten =
  | { readonly ok: true; readonly contactToken: string | null }
  | { readonly ok: false; readonly reason: "NO_SUCH_LEG" | "NO_CONTACT" };

/**
 * RECORD A RECEIVER FOR THIS LEG — what clears an AT-13 hold, in the model the app already has
 * for it.
 *
 * "Held: no adult to receive" is not a column. It is a state the leg machine *derives*
 * (`src/domain/board/board.ts`: a van that arrived, no custody event, and **nobody on file who
 * may receive the child**), and the file it derives that last part from is §6.4's
 * `ops.contact_authorization` with scope `RECEIVE_CHILD` — the rows the seed writes from each
 * family's scopes, the rows the outbox's own policy reads (`modules/outbox/policy.ts`), and the
 * rows `family-texts/checks.ts` answers its "{adult} on file" tick from. Noah O.'s family (F2)
 * holds every scope except that one, which is why his afternoon ends on the hold.
 *
 * So when a parent says someone is home and a coordinator approves it, what has changed is the
 * file: this child now has an adult authorized to receive them. That is one row, written through
 * the same scope and channel the seed writes, plus `trip_leg.receiver_confirmed_at` on the leg
 * the decision is about — the column §6.3's handoff keeps that fact in.
 *
 * The adult is the family's own guardian contact, found from the child's existing authorizations
 * (every other scope F2 holds), because a receiver this app cannot name is not one it will write:
 * `NO_CONTACT` rather than an invented contact token. Idempotent — a second approval finds the
 * row already there and writes no duplicate.
 */
export async function recordLegReceiver(tx: Exec, input: LegReceiverInput): Promise<LegReceiverWritten> {
  /*
   * EXACTLY THE ADULT WHO ASKED (PPE-98), and only if this child's file already knows them. A
   * proposal that names nobody, or a contact who holds no authorization for this child at all, is
   * `NO_CONTACT`: the hold stays and the decision rolls back. Adding a *new* adult to a child's file
   * is `propose_contact_or_profile_change`'s job, decided on its own card — never a side effect here.
   */
  const contactToken = input.contactToken;
  if (contactToken === null || contactToken === "") return { ok: false, reason: "NO_CONTACT" };
  const known = await tx.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM ops.contact_authorization
      WHERE site_id = $1 AND child_token = $2::uuid AND contact_token::text = $3`,
    [input.siteId, input.childToken, contactToken],
  );
  if ((known.rows[0]?.n ?? 0) === 0) return { ok: false, reason: "NO_CONTACT" };

  const confirmed = await tx.query<{ id: string }>(
    `UPDATE ops.trip_leg
        SET receiver_confirmed_at = $3, updated_at = $3, updated_by = $4, version = version + 1
      WHERE id = $1 AND site_id = $2
      RETURNING id`,
    [input.legId, input.siteId, input.now, input.by],
  );
  if (confirmed.rows.length !== 1) return { ok: false, reason: "NO_SUCH_LEG" };

  await tx.query(
    `INSERT INTO ops.contact_authorization
       (id, site_id, contact_token, child_token, scope, channel, valid_from, created_by, updated_by, source_mode)
     SELECT $6::uuid, $1, $2::uuid, $3::uuid, 'RECEIVE_CHILD', 'SMS_1TO1', $4, $5, $5, 'SIMULATED'
      WHERE NOT EXISTS (
        SELECT 1 FROM ops.contact_authorization
         WHERE site_id = $1 AND contact_token = $2::uuid AND child_token = $3::uuid AND scope = 'RECEIVE_CHILD')`,
    [input.siteId, contactToken, input.childToken, input.now, input.by, uuidv7()],
  );
  return { ok: true, contactToken };
}

/**
 * The wall clock at the centre, as the 24-hour string every schedule in this app is written in:
 * the inverse of {@link siteInstantOn}, and what the board's leg facts read a stored instant back
 * through (`modules/plan/leg-facts.ts`).
 *
 * In JavaScript rather than in `to_char(… AT TIME ZONE …)` deliberately: the conversion is the
 * same one `siteInstantOn` makes, by the same `Intl` zone data, so a time written here and read
 * back cannot disagree by a DST hour because two different libraries were asked.
 */
export function siteHhmm(at: Date): string {
  const parts = ZONE_PARTS.formatToParts(at);
  const value = (type: string): string => parts.find((part) => part.type === type)?.value ?? "00";
  return `${value("hour")}:${value("minute")}`;
}
