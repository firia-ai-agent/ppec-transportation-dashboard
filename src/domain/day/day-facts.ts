/**
 * WHERE THE DAY'S FACTS COME FROM — two reads, and nothing written.
 *
 * The thin loader half of REDESIGN-SPEC §9.4's readiness helper: `readiness.ts` beside this file
 * decides the states, this one goes and gets the counts they are decided from. Split in two
 * because the deciding is the part worth testing exhaustively and the fetching is the part that
 * needs a connection — and because the step strip imports the *types* from `readiness.ts`, which
 * a client bundle must be able to do without dragging `pg` along with them.
 *
 * **Read-only, and two statements.** Both are `SELECT`s against tables migration 0009 already
 * created (`ops.vehicle_setup_day`, `ops.plan_run`); nothing here inserts, updates or migrates,
 * and no seed is run to make them answer. If they are empty, the honest answer is the one the
 * strip shows: nothing is checked and nothing is saved.
 *
 * **It never throws at the page.** A module that fails must not blank the shell (§9.4), so a
 * missing site, an absent database and a query that raises all land on the same answer —
 * `unreadFacts`, which `deriveReadiness` turns into Needed, Needed and Locked. That is also what
 * makes the browser checks deterministic: the Playwright run has no database at all, so it takes
 * this path every time, by the shape of the thing rather than by a flag a deployment could set.
 */
import type { Exec } from "@/domain/transition";
import { serviceDateIso, siteHour } from "@/ui/service-date";
import {
  deriveReadiness,
  unreadFacts,
  type DayFacts,
  type DayReadiness,
  type Leg,
} from "./readiness";

/**
 * Which run of the day it is, at the centre (REDESIGN-SPEC §9.1: "before 12:00 PM centre time
 * the default leg is Morning, after it Afternoon"). Centre time, not the reader's: a coordinator
 * on a laptop still set to Phoenix is working the same leg as the person beside them.
 */
export function legAt(now: Date = new Date()): Leg {
  return siteHour(now) < 12 ? "AM" : "PM";
}

/**
 * The leg a screen is about: the one the **address** names, and the clock's when it names none.
 *
 * §9.3 keeps a screen's state in its URL, so a `?leg=` a person followed — from the board, from
 * the ramp's van tabs — is a decision already made, and the clock must not quietly overrule it:
 * a coordinator opening Today from a morning link at 2 PM is looking at the morning. With no
 * `?leg=` nothing changes: {@link legAt} answers, in centre time, as before.
 */
export function legFor(asked: Leg | undefined, now: Date = new Date()): Leg {
  return asked ?? legAt(now);
}

/** Today's service date at the centre, which is the date every row below is keyed by. */
export function serviceDateAt(now: Date = new Date()): string {
  return serviceDateIso(now);
}

/**
 * The vans this site has, and how many of them carry today's `CHECKED` setup row.
 *
 * One statement rather than two, so the total and the checked count are the same instant's
 * answer: a van added between two queries would otherwise show up as "4/3 checked". `CHECKED` is
 * the only state that counts — `DEFAULT` is what the day starts from and `PLANNED` is a
 * coordinator's intention, and §9.1 is explicit that the ramp's confirm is the thing that
 * finishes this step.
 */
const VANS_CHECKED = `
  SELECT count(*)::int AS vans, count(s.vehicle_id)::int AS checked
    FROM ops.vehicle v
    LEFT JOIN ops.vehicle_setup_day s
      ON s.vehicle_id = v.id
     AND s.service_date = $2::date
     AND s.state = 'CHECKED'
   WHERE v.site_id = $1`;

/**
 * The plan saved for this site, this date and this leg, if there is one.
 *
 * `direction::text = $3` rather than a parameter cast to the enum: the leg travels as two
 * letters and is compared as two letters, which keeps this read working on every executor the
 * app has (the pooled Neon client and the local PGlite one disagree about enum parameters).
 * `plan_run` is unique on those three columns, so one row is all there can be.
 */
const PLAN_SAVED = `
  SELECT saved_at FROM ops.plan_run
   WHERE site_id = $1 AND service_date = $2::date AND direction::text = $3
   LIMIT 1`;

/** The two reads, as the facts `deriveReadiness` takes. Throws nothing: see `getDayReadiness`. */
export async function readDayFacts(
  exec: Exec,
  siteId: string,
  date: string,
  leg: Leg,
): Promise<DayFacts> {
  const vans = await exec.query<{ vans: number; checked: number }>(VANS_CHECKED, [siteId, date]);
  const plan = await exec.query<{ saved_at: Date | string }>(PLAN_SAVED, [siteId, date, leg]);
  const savedAt = plan.rows[0]?.saved_at;
  return {
    date,
    leg,
    read: true,
    vans: Number(vans.rows[0]?.vans ?? 0),
    vansChecked: Number(vans.rows[0]?.checked ?? 0),
    planSavedAt: savedAt == null ? null : new Date(savedAt),
  };
}

/**
 * The day's readiness for one site, as a screen asks for it.
 *
 * `siteId` is nullable on purpose and is the seam the browser checks come through: the synthetic
 * test session is a role with no site and no user row behind it (src/auth/caller.ts), so there
 * is no site to read a day for, and the answer is the unread one. No environment variable
 * decides that — a session either names a site or it does not.
 *
 * `exec` is the other seam, for a test that wants to hand this function a database.
 */
export async function getDayReadiness({
  siteId,
  now = new Date(),
  leg: asked,
  exec,
}: {
  siteId: string | null;
  now?: Date;
  /** The leg the address names (`?leg=`). The clock decides when it names none. */
  leg?: Leg;
  exec?: Exec;
}): Promise<DayReadiness> {
  const date = serviceDateAt(now);
  const leg = legFor(asked, now);
  if (!siteId) return deriveReadiness(unreadFacts(date, leg));
  try {
    const source = exec ?? (await import("@/auth/exec")).getExec();
    return deriveReadiness(await readDayFacts(source, siteId, date, leg));
  } catch {
    // §9.4: a module that cannot load says so in its own card; it never takes the shell with it.
    return deriveReadiness(unreadFacts(date, leg));
  }
}
