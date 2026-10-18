import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/db/exec";
import { DEMO_ACCOUNTS } from "@/auth/demo-accounts";
import { VANS } from "@/config/vans";
import { freshPlanDb, SITE } from "@/test/pglite";
import { readDayFacts } from "@/domain/day/day-facts";
import { deriveReadiness } from "@/domain/day/readiness";
import { loadBoard } from "@/modules/plan/store";
import { sqlPlanStore } from "@/modules/plan/sql";
import { sqlDaySource } from "@/modules/roster/sql";
import { vehicleIdOf } from "./fixtures/standard";
import { handleDemoReset } from "./reset";

/**
 * **The fresh demo seed, applied the only way it is ever applied: the reset route.**
 *
 * Firia, 2026-10-17 8:02 PM ET — no migration-style wipe, no dropped tables, no direct SQL at a
 * real database. `handleDemoReset` is what "Restart demo day" calls, and this runs it twice
 * against a throwaway local Postgres (`pnpm test:db`, loopback only — src/test/pglite.ts refuses
 * anything else) to prove two things a demo depends on:
 *
 *  - it is **idempotent**: the rows after the second reset are the rows after the first, id for
 *    id, so a founder can press the button twice and get the same day;
 *  - the board, Today and the map read **the seeded** vans and children, not a fixture that
 *    happens to look like them.
 */

let db: Db;
let close: () => Promise<void>;

const NOW = new Date("2026-10-16T17:45:00.000Z");
const ENV = {
  APP_DATA_CLASS: "SYNTHETIC",
  DEMO_MODE: "1",
  HMAC_PEPPER: "p",
  DATA_KEY: "k",
  DEMO_RESET_ENABLED: "1",
};
const DIRECTOR = DEMO_ACCOUNTS.find((account) => account.role === "DIRECTOR")!;

/** Every row of the tables a reset owns, ordered, as one comparable snapshot. */
async function snapshot(): Promise<Record<string, unknown[]>> {
  const tables = [
    ["children", "SELECT child_token::text, display_name FROM ops.child_profile ORDER BY child_token"],
    ["vehicles", "SELECT id::text, label FROM ops.vehicle ORDER BY id"],
    ["profiles", "SELECT child_token::text, status::text, profile_version FROM ops.transport_profile ORDER BY child_token"],
    [
      "needs",
      `SELECT tp.child_token::text, ni.category, ni.state::text
         FROM ops.transport_need_item ni JOIN ops.transport_profile tp ON tp.id = ni.profile_id
        ORDER BY tp.child_token, ni.category`,
    ],
    ["stops", "SELECT id::text, label FROM ops.stop_location ORDER BY id"],
    ["setups", "SELECT vehicle_id::text, service_date::text, state FROM ops.vehicle_setup_day ORDER BY vehicle_id"],
    ["plans", "SELECT id::text FROM ops.plan_run ORDER BY id"],
    ["attendance", "SELECT child_token::text, service_date::text, state::text FROM ops.attendance_day ORDER BY child_token"],
  ] as const;
  const out: Record<string, unknown[]> = {};
  for (const [name, sql] of tables) out[name] = (await db.query(sql, [])).rows;
  return out;
}

beforeAll(async () => {
  ({ db, close } = await freshPlanDb());
  // The reset needs a director with a membership at the site, exactly as a request would have.
  await db.query(
    `INSERT INTO ops.app_user (id, email, display_name, password_hash) VALUES ($1, $2, $3, 'x')
     ON CONFLICT (id) DO NOTHING`,
    [DIRECTOR.id, DIRECTOR.email, DIRECTOR.name],
  );
  await db.query(
    `INSERT INTO ops.site_membership (user_id, site_id, role) VALUES ($1, $2, 'DIRECTOR')
     ON CONFLICT DO NOTHING`,
    [DIRECTOR.id, SITE],
  );
}, 180_000);

afterAll(async () => {
  await close();
});

describe("Restart demo day, twice", () => {
  it("writes the same rows both times, id for id", async () => {
    const first = await handleDemoReset(db, ENV, { userId: DIRECTOR.id, siteId: SITE, now: NOW });
    expect(first.status).toBe(200);
    const afterFirst = await snapshot();

    const second = await handleDemoReset(db, ENV, { userId: DIRECTOR.id, siteId: SITE, now: NOW });
    expect(second.status).toBe(200);
    const afterSecond = await snapshot();

    expect(afterSecond).toEqual(afterFirst);
  }, 240_000);

  it("seeds twelve children, three vans on the road, and every need approved", async () => {
    const snap = await snapshot();
    expect(snap.children).toHaveLength(12);
    for (const row of snap.needs as { state: string }[]) expect(row.state).toBe("APPROVED");
    // The three the day runs are the shared config's, by id.
    const vehicleIds = new Set((snap.vehicles as { id: string }[]).map((row) => row.id));
    for (const van of VANS) expect(vehicleIds.has(vehicleIdOf(van.vehicleKey))).toBe(true);
  });

  /**
   * EXACTLY THREE VEHICLES, AND THE RESET KEEPS IT THAT WAY — "Firia 8:02 PM seed ruling".
   *
   * `RESET_TABLES` truncates `ops.vehicle`, so Restart demo day deletes the fleet and seeds it
   * again: the thing worth proving is that it comes back as the same three, with no fourth
   * vehicle left behind and no reserve added. Run twice above, read here.
   */
  it("leaves exactly three vehicles, named Van 1–3, however often it is run", async () => {
    const snap = await snapshot();
    const vehicles = snap.vehicles as { id: string; label: string }[];
    expect(vehicles).toHaveLength(3);
    expect(vehicles.map((row) => row.label).sort()).toEqual(["Van 1", "Van 2", "Van 3"]);
    expect(VANS).toHaveLength(3);
    expect(VANS.map((van) => van.slot)).toEqual([1, 2, 3]);
    expect(VANS.map((van) => van.vehicleKey)).toEqual(["V1", "V2", "V3"]);
    // One generic van: the same defaults for all three, every one of them lift-equipped
    // (Vera/Athena/Veri with Firia's sign-off, 2026-10-18 12:13 AM ET).
    for (const van of VANS) {
      expect(van.defaultSetup).toEqual(VANS[0].defaultSetup);
      expect(van.defaultSetup.hasLift).toBe(true);
      expect(van.onRoadToday).toBe(true);
    }
    // And no row anybody reads names a kind of vehicle, or a code.
    for (const row of vehicles) {
      expect(row.label).not.toMatch(/sedan|convertible|cent(?:er|re)|substitute/i);
      expect(row.label).not.toMatch(/^V\d$/);
    }
  });

  it("writes no van setup for today: every van reads its defaults until the ramp confirms one", async () => {
    expect(await snapshot().then((snap) => snap.setups)).toEqual([]);
  });

  it("is what the board, Today and the map then read", async () => {
    const view = await loadBoard(sqlPlanStore(db), SITE, "2026-10-16", "PM", sqlDaySource(db, SITE));
    // The board's three columns are the seeded vehicles, with the config's default counts.
    expect(view.day.vans.map((van) => van.name)).toEqual(["Van 1", "Van 2", "Van 3"]);
    for (const van of view.day.vans) expect(van.setup).toEqual(van.defaultSetup);
    // Its riders are the seeded children, by token and by name, and one of them is the chair
    // rider the mockup draws.
    expect(view.day.riders.length + view.day.others.length).toBe(12);
    expect(view.day.riders.some((rider) => rider.name === "Noah O." && rider.needs.wheelchair)).toBe(true);
    // Every rider has the stop the seed wrote, which is what the map draws them at.
    for (const rider of view.day.riders) expect(rider.stopLabel.length).toBeGreaterThan(0);
    // And no plan exists yet, so the live map is locked until one is saved (§9.1).
    expect(view.savedAt).toBeNull();
  });

  /**
   * Today's step strip counts the vans this site has: "0/3 checked", never "0/0" (§9.5, and
   * the loader src/domain/day/day-facts.ts the Today page reads through). Three, because the
   * seed writes three vehicles and no fourth — "Firia 8:02 PM seed ruling".
   */
  it("gives Today's step strip three vans to count, and none of them checked yet", async () => {
    const facts = await readDayFacts(db, SITE, "2026-10-16", "PM");
    expect(facts).toMatchObject({ read: true, vans: 3, vansChecked: 0 });
    expect(deriveReadiness(facts).setup).toMatchObject({
      state: "NEEDED",
      checked: 0,
      total: 3,
    });
  });
});
