/**
 * The one way a rebuilt screen learns what the day is made of: which vans are out, who is
 * driving them, which children ride which leg, and what each child needs.
 *
 * SOURCE: Firia's rule 5 (2026-10-17 5:48 PM ET) — "rebuilt screens read day data through ONE
 * domain interface and NEVER import `@/fixtures` or `src/modules/demo/fixtures` directly;
 * fixtures sit only behind the demo adapter" — and Vera's differences list, which found three
 * rosters and three fleets in one app ("Noah B." against "Noah O.", a board "Van 3" that was the
 * live map's V4).
 *
 * **Two** implementations: the database (src/modules/roster/sql.ts), which is what every
 * deployment gets, and the synthetic day (src/modules/demo/day-source.ts) for a server with no
 * `DATABASE_URL` — the browser check and a local `next dev`. Which one a request gets is decided
 * once, in src/modules/plan/store.ts, by whether a database is configured. The demo adapter is
 * the *only* thing in the app that reads a fixture (Firia's rule 5, and the 7:18 PM ET
 * correction: the child's needs are rows now, so a Save on the board's child panel changes the
 * board).
 *
 * What it deliberately does **not** carry: today's counts and the saved plan. Those are rows in
 * the three tables migration 0009 adds and they are read through `PlanStore`
 * (src/modules/plan/types.ts); the two halves are composed once, in `loadBoard`
 * (src/modules/plan/store.ts), which is the single call every screen makes.
 *
 * Pure: an implementation may read fixtures or a database, and nothing here has a clock.
 */
import type { FitRider, VanSetup } from "@/domain/plan/fit";
import type { Direction } from "./leg";

/** One van on the road today, named and coloured by the shared config (src/config/vans.ts). */
export type DayVan = {
  /** `ops.vehicle.id` — the id the board puts in its markup and its addresses, never a code. */
  id: string;
  /** 1-based: the number in "Van 2" and its colour slot. */
  slot: number;
  /** "Van 2" — the only name this van has on screen. */
  name: string;
  /** The design token its colour comes from, e.g. `brand`. Never a hex (§0's rule 6). */
  colourToken: string;
  /** "Marcus L." — who is driving it today. */
  driverName: string;
  /** What it carries when nobody has counted it today (Firia/Veri 6:00 PM ET: no carry-over). */
  defaultSetup: VanSetup;
};

/** A child this leg drives: what the fit rule needs, plus where and when they are picked up. */
export type DayRider = FitRider & {
  /** "Okeeheelee Park" — a landmark, never an address. */
  stopLabel: string;
  /** "15:55", site-local, which is the order the stops are driven in. */
  window: string;
};

/** The four places a child can be on a board (§1.6's `bucket`). */
export const BUCKETS = ["VAN", "UNASSIGNED", "FAMILY_DRIVES", "ABSENT"] as const;
export type Bucket = (typeof BUCKETS)[number];

/** A child of the day who is not ours to place this leg. */
export type OtherChild = { token: string; name: string; bucket: Bucket };

export interface DayDataSource {
  /** The vans on the road on this date, in slot order. */
  vans(date: string): Promise<readonly DayVan[]>;
  /**
   * When this van pulls away from the centre on this leg, epoch ms.
   *
   * The ramp's van tabs are in the order the vans leave (§2), and that time is a fact about the
   * day's own runs — so it comes through the port with the rest of the day rather than out of a
   * fixture the screen reads for itself.
   */
  leavesAtMs(date: string, leg: Direction, vanId: string): number;

  /**
   * The children the centre drives on this leg: a stop of their own, and a ride that is not the
   * family's.
   *
   * Being *away* is not asked about here. Absence is a placement on the day's own plan
   * (`plan_assignment.bucket = 'ABSENT'`, per date **and** per leg — founder 7:17 PM ET), so a
   * child recorded away is still a rider of the roster and the board shows them in its Absent
   * group. Nothing reads `ops.attendance_day` for this.
   */
  riders(date: string, leg: Direction): Promise<readonly DayRider[]>;
  /**
   * Everybody else on the roster, with the bucket they start in when no plan says otherwise:
   * the families who drive their own child.
   */
  others(date: string, leg: Direction): Promise<readonly OtherChild[]>;
}
