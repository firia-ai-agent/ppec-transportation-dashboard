import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/db/exec";
import { freshPlanDb, SITE } from "@/test/pglite";
import { DEMO_ACCOUNTS } from "@/auth/demo-accounts";
import { VANS } from "@/config/vans";
import { childTokenOf, vehicleIdOf } from "@/modules/demo/fixtures/standard";
import { seedStandardScenario } from "@/modules/demo/seed";
import { sqlPlanStore } from "./sql";
import { staffLabel } from "./staff";
import type { PlanStore } from "./types";

/**
 * The three tables migration 0009 adds, exercised through the real statements against the real
 * migrations.
 *
 * It runs on PGlite by default — in this process, no setup, nothing to point anywhere — and on a
 * **throwaway local Postgres** when `TEST_DATABASE_URL` names one (`pnpm test:db`, README
 * "Database tests"). Veri asked for the second; the first is what keeps it running on every
 * commit. A non-loopback URL is refused outright (src/test/pglite.ts `assertLocal`): these
 * statements recreate schemas, and the shared Neon database must never be on the other end.
 *
 * This is the file that has to exist: the board can be walked in a browser against the memory
 * fallback (src/modules/plan/memory.ts), and that proves nothing about the SQL a deployment
 * actually runs. So the save, the read-back, the optimistic lock and the default ladder's rows are
 * all asserted here, on a database.
 */

const env = { APP_DATA_CLASS: "SYNTHETIC", DEMO_MODE: "1", HMAC_PEPPER: "p", DATA_KEY: "k" };
/** A Friday 13:45 local, so "yesterday" is a weekday and the dates below are a real pair. */
const NOW = new Date("2026-10-16T17:45:00.000Z");
const TODAY = "2026-10-16";
const YESTERDAY = "2026-10-15";

let db: Db;
let close: () => Promise<void>;
let store: PlanStore;
const DIRECTOR = DEMO_ACCOUNTS.find((account) => account.role === "DIRECTOR")!;

const vanOne = () => vehicleIdOf(VANS[0].vehicleKey);
const vanTwo = () => vehicleIdOf(VANS[1].vehicleKey);

beforeAll(async () => {
  ({ db, close } = await freshPlanDb());
  // The seed is what creates the vans and the children these rows point at, and it writes the
  // yesterday setups this suite then reads through the ladder.
  await seedStandardScenario(db, { now: NOW, siteId: SITE, env });
  // One staff user to attribute a save to. The seed deliberately leaves auth alone (ADR-014), so
  // the row is written here rather than assumed.
  await db.query(
    `INSERT INTO ops.app_user (id, email, display_name, password_hash) VALUES ($1, $2, $3, 'x')
     ON CONFLICT (id) DO NOTHING`,
    [DIRECTOR.id, DIRECTOR.email, DIRECTOR.name],
  );
  store = sqlPlanStore(db);
}, 120_000);

afterAll(async () => {
  await close();
});

describe("ops.vehicle_setup_day", () => {
  /**
   * The reset contract as re-cut on 2026-10-17 6:00 PM ET: the seed writes **no** setup row, for
   * yesterday or for today. Every van is therefore planned on its shared-config defaults until
   * the front desk confirms it at the ramp, and there is no carry-over for a test to find.
   */
  it("starts a seeded day with no van counted at all", async () => {
    expect(await store.setupRows(SITE, TODAY, [vanOne(), vanTwo()])).toEqual([]);
    expect(await store.setupRows(SITE, YESTERDAY, [vanOne(), vanTwo()])).toEqual([]);
  });

  it("writes today's setup, names who set it, and replaces it on a second write", async () => {
    await store.putSetup(SITE, {
      vehicleId: vanOne(),
      date: TODAY,
      setup: { seats: 5, wheelchairSpots: 1, carSeats: 2, oxygenMounts: 1, hasLift: true },
      state: "CHECKED",
      setBy: DIRECTOR.id,
      now: NOW,
    });
    let rows = await store.setupRows(SITE, TODAY, [vanOne()]);
    expect(rows[0]).toMatchObject({ serviceDate: TODAY, state: "CHECKED", setBy: staffLabel(DIRECTOR.id) });
    expect(rows[0].setup.seats).toBe(5);
    // The counts come back as numbers, not strings: a "4" would fail every comparison silently.
    expect(typeof rows[0].setup.seats).toBe("number");

    await store.putSetup(SITE, {
      vehicleId: vanOne(),
      date: TODAY,
      setup: { seats: 6, wheelchairSpots: 2, carSeats: 3, oxygenMounts: 0, hasLift: false },
      state: "CHECKED",
      setBy: DIRECTOR.id,
      now: NOW,
    });
    rows = await store.setupRows(SITE, TODAY, [vanOne()]);
    // One row per van per day, whatever the number of writes (the unique index).
    expect(rows.filter((row) => row.serviceDate === TODAY)).toHaveLength(1);
    expect(rows[0]).toMatchObject({ state: "CHECKED" });
    expect(rows[0].setup).toEqual({ seats: 6, wheelchairSpots: 2, carSeats: 3, oxygenMounts: 0, hasLift: false });
    const version = await db.query<{ version: number }>(
      "SELECT version FROM ops.vehicle_setup_day WHERE vehicle_id = $1 AND service_date = $2::date",
      [vanOne(), TODAY],
    );
    expect(Number(version.rows[0].version)).toBe(2);
  });

  it("refuses a state nobody defined and a count below zero (the table's own checks)", async () => {
    await expect(
      db.query(
        `INSERT INTO ops.vehicle_setup_day
           (id, site_id, vehicle_id, service_date, seats, wheelchair_spots, car_seats, oxygen_mounts,
            has_lift, state, created_by, updated_by)
         VALUES ('01900000-0000-7000-8000-00000000fe01', $1, $2, $3::date, 1, 0, 0, 0, true, 'MAYBE', 'test', 'test')`,
        [SITE, vanTwo(), "2026-10-01"],
      ),
    ).rejects.toThrow();
    await expect(
      db.query(
        `INSERT INTO ops.vehicle_setup_day
           (id, site_id, vehicle_id, service_date, seats, wheelchair_spots, car_seats, oxygen_mounts,
            has_lift, state, created_by, updated_by)
         VALUES ('01900000-0000-7000-8000-00000000fe02', $1, $2, $3::date, -1, 0, 0, 0, true, 'CHECKED', 'test', 'test')`,
        [SITE, vanTwo(), "2026-10-02"],
      ),
    ).rejects.toThrow();
  });
});

describe("ops.plan_run + ops.plan_assignment", () => {
  const placements = (vanId: string) => ({
    [childTokenOf("C1")]: { bucket: "VAN" as const, vanId, pinned: true, stopSeq: 1 },
    [childTokenOf("C2")]: { bucket: "VAN" as const, vanId, pinned: false, stopSeq: 2 },
    [childTokenOf("C3")]: { bucket: "UNASSIGNED" as const, vanId: null, pinned: false },
    [childTokenOf("C10")]: { bucket: "FAMILY_DRIVES" as const, vanId: null, pinned: false },
  });

  it("has nothing to read before anything is saved", async () => {
    expect(await store.loadPlan(SITE, TODAY, "AM")).toBeNull();
  });

  it("saves a board and reads the same board back (§1.7 #3)", async () => {
    const saved = await store.savePlan(SITE, {
      date: TODAY,
      direction: "PM",
      version: 0,
      placements: placements(vanOne()),
      savedBy: DIRECTOR.id,
      now: NOW,
    });
    expect(saved).toMatchObject({ ok: true, version: 1 });

    const read = await store.loadPlan(SITE, TODAY, "PM");
    expect(read).not.toBeNull();
    expect(read).toMatchObject({ version: 1, savedBy: staffLabel(DIRECTOR.id) });
    expect(read!.savedAt).toBe(NOW.toISOString());
    expect(read!.placements[childTokenOf("C1")]).toEqual({ bucket: "VAN", vanId: vanOne(), pinned: true });
    expect(read!.placements[childTokenOf("C3")]).toEqual({ bucket: "UNASSIGNED", vanId: null, pinned: false });
    expect(read!.placements[childTokenOf("C10")]).toEqual({ bucket: "FAMILY_DRIVES", vanId: null, pinned: false });
    // The stop number is written down too, so the row describes itself.
    const seq = await db.query<{ stop_seq: number | null }>(
      `SELECT stop_seq FROM ops.plan_assignment a JOIN ops.plan_run r ON r.id = a.plan_run_id
        WHERE r.service_date = $1::date AND a.child_token = $2`,
      [TODAY, childTokenOf("C2")],
    );
    expect(Number(seq.rows[0].stop_seq)).toBe(2);
  });

  it("keeps the two legs of a day apart", async () => {
    const am = await store.savePlan(SITE, {
      date: TODAY, direction: "AM", version: 0, placements: placements(vanTwo()),
      savedBy: null, now: NOW,
    });
    expect(am).toMatchObject({ ok: true, version: 1 });
    const morning = await store.loadPlan(SITE, TODAY, "AM");
    const afternoon = await store.loadPlan(SITE, TODAY, "PM");
    expect(morning!.placements[childTokenOf("C1")].vanId).toBe(vanTwo());
    expect(afternoon!.placements[childTokenOf("C1")].vanId).toBe(vanOne());
    // Nobody recorded for the morning save: no name is invented for it.
    expect(morning!.savedBy).toBeNull();
  });

  it("replaces the whole board on the next save and bumps the version", async () => {
    const second = await store.savePlan(SITE, {
      date: TODAY,
      direction: "PM",
      version: 1,
      placements: {
        [childTokenOf("C1")]: { bucket: "UNASSIGNED", vanId: null, pinned: true },
      },
      savedBy: DIRECTOR.id,
      now: NOW,
    });
    expect(second).toMatchObject({ ok: true, version: 2 });
    const read = await store.loadPlan(SITE, TODAY, "PM");
    expect(Object.keys(read!.placements)).toEqual([childTokenOf("C1")]);
    expect(read!.version).toBe(2);
  });

  it("refuses a save against a version somebody else has moved on from (§1.3)", async () => {
    const stale = await store.savePlan(SITE, {
      date: TODAY, direction: "PM", version: 1,
      placements: { [childTokenOf("C2")]: { bucket: "UNASSIGNED", vanId: null, pinned: false } },
      savedBy: null, now: NOW,
    });
    expect(stale).toEqual({ ok: false, conflict: true, changedBy: staffLabel(DIRECTOR.id), version: 2 });
    // And the refused save changed nothing.
    const read = await store.loadPlan(SITE, TODAY, "PM");
    expect(Object.keys(read!.placements)).toEqual([childTokenOf("C1")]);
  });

  it("refuses a group that names a van, and a van that names no group (the table's own check)", async () => {
    const run = await db.query<{ id: string }>(
      "SELECT id FROM ops.plan_run WHERE service_date = $1::date AND direction = 'PM'",
      [TODAY],
    );
    await expect(
      db.query(
        `INSERT INTO ops.plan_assignment (plan_run_id, site_id, child_token, vehicle_id, bucket, created_by, updated_by)
         VALUES ($1, $2, $3, $4, 'ABSENT', 'test', 'test')`,
        [run.rows[0].id, SITE, childTokenOf("C4"), vanOne()],
      ),
    ).rejects.toThrow();
    await expect(
      db.query(
        `INSERT INTO ops.plan_assignment (plan_run_id, site_id, child_token, vehicle_id, bucket, created_by, updated_by)
         VALUES ($1, $2, $3, NULL, 'VAN', 'test', 'test')`,
        [run.rows[0].id, SITE, childTokenOf("C5")],
      ),
    ).rejects.toThrow();
  });
});

describe("the day's other facts", () => {
  it("reads the day the demo is started on, and who is away", async () => {
    const context = await store.dayContext(SITE, TODAY);
    // The seed rewinds the scenario clock to 06:00 on the day it was run for: that is the started day.
    expect(context.startedDate).toBe(TODAY);
    expect(context.absentTokens).toEqual([]);
    expect(context.vansOut).toBe(0);
    expect(context.approvalsWaiting).toBe(0);
  });

  it("counts a child with a full-day exception as away on that date", async () => {
    await db.query(
      `INSERT INTO ops.attendance_exception (id, site_id, child_token, service_date, scope, created_by, updated_by)
       VALUES ('01900000-0000-7000-8000-00000000fe03', $1, $2, $3::date, 'FULL_DAY', 'test', 'test')`,
      [SITE, childTokenOf("C9"), TODAY],
    );
    const context = await store.dayContext(SITE, TODAY);
    expect(context.absentTokens).toEqual([childTokenOf("C9")]);
    // And not on another date.
    expect((await store.dayContext(SITE, "2026-10-14")).absentTokens).toEqual([]);
  });
});
