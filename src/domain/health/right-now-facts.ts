/**
 * WHERE THE FOUR TILES' FACTS COME FROM — reads only, nothing written.
 *
 * The same split as the step strip: `right-now.ts` decides the tiles, this file goes and gets
 * the counts. The van check is not a second query with a second opinion — it is
 * `readDayFacts`, the loader the step strip already uses, so "Vans checked 2/3" and
 * "Van setup 2/3 checked" are one answer (Firia, 2026-10-17: the tile numbers come from the
 * same day facts as the step strip).
 *
 * The other three are the day's own rows:
 *  - kids placed: the saved plan (`plan_run` / `plan_assignment`) for this date and leg;
 *  - running late: a van whose latest arrival estimate is past the window it was given — the van
 *    **the saved plan puts that child on**, not the one the seeded manifest has them on;
 *  - needs you: open tasks of kind NEEDS_PERSON (docs/DATA-MODEL.md, StaffAlert).
 *
 * THE SAVED PLAN IS WHAT THESE TILES ARE ABOUT (Firia, 2026-10-17 6:02 PM ET: "Today, Live map
 * and Health read the saved plan", and the S1 ruling of 2026-10-18 4:45 AM ET). Veri's prod check
 * found Today's van column disagreeing with the board a director had just saved for five of nine
 * children; two of these four tiles are counted per van, so the same disagreement was theirs to
 * make. Both now answer from the plan: `PLACED` always did, and `LATE_VANS` does below.
 *
 * It never throws at the page. No site, no database and a query that raises all land on
 * `unreadRightNow`, the same fail-safe the strip uses.
 */
import type { Exec } from "@/domain/transition";
import { readDayFacts, legAt, serviceDateAt } from "@/domain/day/day-facts";
import type { Leg } from "@/domain/day/readiness";
import { unreadRightNow, vanOnScreen, type RightNowFacts } from "./right-now";

/**
 * Vans with no CHECKED setup row for this date.
 *
 * The same join the step strip's count uses (`CHECKED` is the only state that counts), so a
 * van in `DEFAULT` or `PLANNED` is still unchecked and can be named on the pill.
 */
const UNCHECKED_VANS = `
  SELECT v.label
    FROM ops.vehicle v
    LEFT JOIN ops.vehicle_setup_day s
      ON s.vehicle_id = v.id
     AND s.service_date = $2::date
     AND s.state = 'CHECKED'
   WHERE v.site_id = $1
     AND s.vehicle_id IS NULL
   ORDER BY v.label`;

/**
 * Children the saved plan is seating, and how many of them are in a van.
 *
 * Family drives and absent are not "to place": they are not waiting on a van. A day with no
 * saved plan has no rows, and the tile says 0/0 rather than inventing a cohort.
 *
 * **These are the board's own two numbers.** `VAN` and `VAN`+`UNASSIGNED` is exactly what Today's
 * van column and the plan board count (`savedPlacementsForBoard` → `buildBoard`), so the tile and
 * the column cannot read differently off one saved plan — which is the thing Veri's check found
 * them doing. That it holds for the real save path is asserted rather than assumed, child by
 * child, in src/app/(app)/today/saved-plan.db.test.ts.
 *
 * It stays a statement of its own rather than a second call to `loadBoard`: `loadBoard` needs a
 * plan store, a day-data source and a fleet whose ids are the fixtures' (`vehicleKeyOf` throws on
 * any other van), and these four tiles are counted from one `Exec` on any site's rows. The one
 * case where the two could part company is a day whose roster or fleet changed *after* the plan
 * was saved — `planFrom` drops a child the day no longer has and demotes a van it no longer runs
 * — and the board's answer is the one on screen; a demo reset writes both halves at once, so no
 * seeded day has that shape.
 */
const PLACED = `
  SELECT count(*) FILTER (WHERE a.bucket = 'VAN')::int AS placed,
         count(*) FILTER (WHERE a.bucket IN ('VAN', 'UNASSIGNED'))::int AS to_place
    FROM ops.plan_assignment a
    JOIN ops.plan_run r ON r.id = a.plan_run_id
   WHERE r.site_id = $1
     AND r.service_date = $2::date
     AND r.direction::text = $3`;

/**
 * Vans running later than the window last published for a ride on them.
 *
 * The latest estimate is the one that counts: an earlier one that was late and a later one
 * that caught up is not "running late". One van with two late rides is one van.
 *
 * **Which van is late is the plan's answer, not the manifest's** (Firia, 2026-10-17 6:02 PM ET).
 * The arrival estimate belongs to a child's ride; the van that ride is on is a person's decision,
 * and once a coordinator has saved one for this date and leg that decision is in `saved` below.
 * So a child the plan moved from Van 3 to Van 1 makes **Van 1** the van the pill names — which is
 * the van the same child sits on, on Today, on the board and on the live map. Reading the van off
 * `ops.manifest` instead is how a director saw Today and Health blame different vans.
 *
 * Three cases, and the `CASE` below is them in order:
 *  - no row in the saved plan for this child (which is every child when **nothing** is saved for
 *    the leg, because `saved` is then empty): the seeded manifest's van, exactly as before;
 *  - the plan puts them in a van: that van;
 *  - the plan takes them off a van — Unassigned, Family drives, away today: no van is running
 *    late for a ride the plan says is not on one, so the row drops out (`label IS NULL`).
 */
const LATE_VANS = `
  WITH saved AS (
    SELECT a.child_token, a.bucket::text AS bucket, a.vehicle_id
      FROM ops.plan_assignment a
      JOIN ops.plan_run r ON r.id = a.plan_run_id
     WHERE r.site_id = $1
       AND r.service_date = $2::date
       AND r.direction::text = $3
  )
  SELECT DISTINCT label
    FROM (
      SELECT CASE
               WHEN s.child_token IS NULL THEN seeded.label
               WHEN s.bucket = 'VAN' THEN planned.label
             END AS label
        FROM ops.manifest m
        JOIN ops.vehicle seeded
          ON seeded.id = m.vehicle_id
         AND seeded.site_id = m.site_id
        JOIN ops.trip_leg l ON l.manifest_id = m.id
        LEFT JOIN saved s ON s.child_token = l.child_token
        LEFT JOIN ops.vehicle planned
          ON planned.id = s.vehicle_id
         AND planned.site_id = m.site_id
        JOIN LATERAL (
          SELECT eta_at, window_end
            FROM ops.eta_estimate e
           WHERE e.trip_leg_id = l.id
           ORDER BY e.computed_at DESC
           LIMIT 1
        ) e ON e.eta_at > e.window_end
       WHERE m.site_id = $1
         AND m.service_date = $2::date
         AND m.direction::text = $3
    ) rides
   WHERE label IS NOT NULL
   ORDER BY label`;

/** Open "needs a person" tasks. Any other category, and any task that is no longer open, is not this number. */
const NEEDS_YOU = `
  SELECT count(*)::int AS n
    FROM ops.task
   WHERE site_id = $1
     AND category = 'NEEDS_PERSON'
     AND state = 'OPEN'`;

/** The four facts for one site, one date, one leg. Throws on a query failure; the page catches that. */
export async function loadRightNow(
  exec: Exec,
  siteId: string,
  date: string,
  leg: Leg,
): Promise<RightNowFacts> {
  const day = await readDayFacts(exec, siteId, date, leg);
  const unchecked = await exec.query<{ label: string }>(UNCHECKED_VANS, [siteId, date]);
  const placed = await exec.query<{ placed: number; to_place: number }>(PLACED, [siteId, date, leg]);
  const late = await exec.query<{ label: string }>(LATE_VANS, [siteId, date, leg]);
  const needs = await exec.query<{ n: number }>(NEEDS_YOU, [siteId]);
  const row = placed.rows[0];
  return {
    read: true,
    placed: Number(row?.placed ?? 0),
    toPlace: Number(row?.to_place ?? 0),
    vansChecked: day.vansChecked ?? 0,
    vans: day.vans ?? 0,
    uncheckedVans: unchecked.rows.map((r) => vanOnScreen(r.label)),
    lateVans: late.rows.map((r) => vanOnScreen(r.label)),
    needsYou: Number(needs.rows[0]?.n ?? 0),
  };
}

/**
 * The four facts as a screen asks for them.
 *
 * `siteId` null is the browser check: a role and no centre behind it, so there is nothing to
 * count and the answer is the unread one. No environment variable decides that.
 */
export async function readRightNow({
  siteId,
  now = new Date(),
  exec,
}: {
  siteId: string | null;
  now?: Date;
  exec?: Exec;
}): Promise<RightNowFacts> {
  if (!siteId) return unreadRightNow();
  try {
    const source = exec ?? (await import("@/auth/exec")).getExec();
    return await loadRightNow(source, siteId, serviceDateAt(now), legAt(now));
  } catch {
    return unreadRightNow();
  }
}
