import type { DayFacts, Leg } from "@/domain/day/readiness";
import { VEHICLES } from "./fixtures/standard";

/**
 * THE DEMO DAY, AS FACTS — for the one caller that has a role and no centre.
 *
 * The browser-test session is a role and nothing else: no user id, no site, so the readiness
 * loader has no `site_id` to read `ops.vehicle` or `ops.plan_run` for and used to answer with
 * the unread day. On screen that is "0/0 checked", which is a site with no vans in it — and the
 * demo site has four vehicles, written by the seed from the fixture below. The step strip in a
 * browser check was therefore describing a different day from the one the demo runs on, which
 * is the gap Vera found (2026-10-17 8:46 PM ET).
 *
 * So this is that session's day, read from the same fixture the seed writes rows from:
 *
 *  - **vans** — `VEHICLES`, one `ops.vehicle` row each (src/modules/demo/seed.ts). Four of
 *    them: V1, V2 and V3, the three that run the demo's routes, and V4, the sedan. The loader
 *    counts vehicles rather than vans-on-routes, so this counts exactly what a seeded database
 *    would hand back — the point of the mirror is that the two paths agree.
 *  - **checked: 0** — nothing confirms a van in this build. The ramp iPad is a mock surface
 *    that writes no `vehicle_setup_day` row, so a day that has not been seeded *and* driven has
 *    none, and claiming otherwise would be the one invented fact on the screen.
 *  - **no plan, no bench** — the demo's plan lives in the demo's own state
 *    (src/modules/demo/plan-store.ts), never in `ops.plan_run`, so there is nothing saved to
 *    read and nothing to count children against.
 *
 * `read: true` is the claim this file is making and it is a true one: these facts were read,
 * from the fixture that *is* the demo day, rather than guessed because a query failed.
 */
export function demoDayFacts(date: string, leg: Leg): DayFacts {
  return {
    date,
    leg,
    read: true,
    vans: VEHICLES.length,
    vansChecked: 0,
    planSavedAt: null,
    planUnplaced: null,
  };
}

/** The demo site's vehicles, as the strip counts them. Exported so a test can name the number. */
export const DEMO_VANS = VEHICLES.length;
