/**
 * WHERE THE DAY'S FACTS COME FROM — two reads, and nothing written.
 *
 * The thin loader half of REDESIGN-SPEC §9.4's readiness helper: `readiness.ts` beside this file
 * decides the states, this one goes and gets the counts they are decided from. Split in two
 * because the deciding is the part worth testing exhaustively and the fetching is the part that
 * needs a connection — and because the step strip imports the *types* from `readiness.ts`, which
 * a client bundle must be able to do without dragging `pg` along with them.
 *
 * **Read-only, and three statements.** All three are `SELECT`s against tables migration 0009
 * already created (`ops.vehicle_setup_day`, `ops.plan_run`, `ops.plan_assignment`); nothing here
 * inserts, updates or migrates, and no seed is run to make them answer. If they are empty, the
 * honest answer is the one the strip shows: nothing is checked and nothing is saved. The third
 * read only runs when there is a plan to count children on, and its failure is contained — see
 * `countUnplaced`.
 *
 * **It never throws at the page.** A module that fails must not blank the shell (§9.4), so a
 * missing site, an absent database and a query that raises all land on the same answer —
 * `unreadFacts`, which `deriveReadiness` turns into Needed, Needed and Locked. That is also what
 * makes the browser checks deterministic: the Playwright run has no database at all, so it takes
 * this path every time, by the shape of the thing rather than by a flag a deployment could set.
 */
import type { Exec } from "@/domain/transition";
import { demoSessionRole } from "@/domain/access/map-view";
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
  SELECT id, saved_at FROM ops.plan_run
   WHERE site_id = $1 AND service_date = $2::date AND direction::text = $3
   LIMIT 1`;

/**
 * How many children that saved board left in nobody's van.
 *
 * `plan_assignment` holds one row per child per plan and `bucket` says where they are: a van, a
 * family driving them, away today, or `UNASSIGNED` — the bench. The bench is the only one that
 * means "this child has no ride", so it is the only one counted, and the count is what keeps
 * Plan routes off Done while somebody is on it (§9.5, Vera 2026-10-17 8:46 PM ET).
 *
 * Scoped by the site as well as the plan, like every other read in this app: the plan id comes
 * from a row that was already filtered by site, and asking for both means a plan id from
 * somewhere else cannot be used to count another centre's children (DATA-MODEL §5).
 *
 * `bucket` is plain text with a check constraint rather than an enum (src/db/schema.ts), so the
 * literal is compared as text and this read works on both executors the app has.
 */
const PLAN_UNPLACED = `
  SELECT count(*)::int AS unplaced FROM ops.plan_assignment
   WHERE plan_run_id = $1 AND site_id = $2 AND bucket = 'UNASSIGNED'`;

/** The reads, as the facts `deriveReadiness` takes. Throws nothing: see `getDayReadiness`. */
export async function readDayFacts(
  exec: Exec,
  siteId: string,
  date: string,
  leg: Leg,
): Promise<DayFacts> {
  const vans = await exec.query<{ vans: number; checked: number }>(VANS_CHECKED, [siteId, date]);
  const plan = await exec.query<{ id: string; saved_at: Date | string }>(PLAN_SAVED, [
    siteId,
    date,
    leg,
  ]);
  const saved = plan.rows[0];
  return {
    date,
    leg,
    read: true,
    vans: Number(vans.rows[0]?.vans ?? 0),
    vansChecked: Number(vans.rows[0]?.checked ?? 0),
    planSavedAt: saved?.saved_at == null ? null : new Date(saved.saved_at),
    planUnplaced: saved ? await countUnplaced(exec, saved.id, siteId) : null,
  };
}

/**
 * The bench count, or `null` when it could not be read.
 *
 * Its own try/catch, and that is the whole point of it: if this one read fails we still know a
 * plan was saved, so the live map stays unlocked (§9.1 — it unlocks on the plan existing) while
 * Plan routes falls back to "not Done" rather than to a tick nobody checked. A failure here is
 * never allowed to look like a board with everybody placed, and it is never allowed to take the
 * two reads above down with it.
 */
async function countUnplaced(exec: Exec, planRunId: string, siteId: string): Promise<number | null> {
  try {
    const rows = await exec.query<{ unplaced: number }>(PLAN_UNPLACED, [planRunId, siteId]);
    const count = Number(rows.rows[0]?.unplaced ?? 0);
    return Number.isFinite(count) ? count : null;
  } catch {
    return null;
  }
}

/**
 * The day's readiness for one site, as a screen asks for it.
 *
 * `siteId` is nullable on purpose and is the seam the browser checks come through: the synthetic
 * test session is a role with no site and no user row behind it (src/auth/caller.ts), so there
 * is no site to read a day for — and since Vera's 8:46 PM ET note (2026-10-17) that session
 * reads the demo day's own facts instead of the unread day, so the strip says "0/4 checked"
 * rather than "0/0". Every other caller with no site still gets the unread day. No new
 * environment variable decides any of it: a session either names a site or it does not, and the
 * demo session is recognised by the gate it already had.
 *
 * `exec` is the other seam, for a test that wants to hand this function a database.
 */
export async function getDayReadiness({
  siteId,
  now = new Date(),
  exec,
  env = process.env,
}: {
  siteId: string | null;
  now?: Date;
  exec?: Exec;
  /** The environment the browser-test session is recognised from (`demoSessionRole`). */
  env?: Record<string, string | undefined>;
}): Promise<DayReadiness> {
  const date = serviceDateAt(now);
  const leg = legAt(now);
  if (!siteId) {
    /*
     * No site — and there are two ways to have none. The browser-test session is a role with no
     * centre behind it, and the day it stands in for is the demo day, which is written down
     * (src/modules/demo/day.ts): four vans, none checked, no plan. Reading it there means the
     * strip in a browser check describes the same day the demo runs on, instead of "0/0", and
     * no row is read or written to do it.
     *
     * `demoSessionRole` is the gate that already exists for that session — it answers `null`
     * the moment `VERCEL_ENV` is set, which is every deployment we own, and it needs synthetic
     * data and demo mode besides. No new flag is introduced here: a deployment cannot turn this
     * path on, by the same fact that makes the session itself unreachable there.
     *
     * Anyone else with no site is a caller we genuinely know nothing about, and gets the unread
     * day: Needed, Needed, Locked.
     */
    if (demoSessionRole(env)) {
      const { demoDayFacts } = await import("@/modules/demo/day");
      return deriveReadiness(demoDayFacts(date, leg));
    }
    return deriveReadiness(unreadFacts(date, leg));
  }
  try {
    const source = exec ?? (await import("@/auth/exec")).getExec();
    return deriveReadiness(await readDayFacts(source, siteId, date, leg));
  } catch {
    // §9.4: a module that cannot load says so in its own card; it never takes the shell with it.
    return deriveReadiness(unreadFacts(date, leg));
  }
}
