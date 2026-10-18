import { afterEach, describe, expect, it } from "vitest";
import { uuidv7 } from "uuidv7";
import type { PGlite } from "@electric-sql/pglite";
import type { Db } from "@/db/exec";
import { readDayFacts } from "@/domain/day/day-facts";
import { freshDb, ORG, SITE } from "@/test/pglite";
import { loadRightNow } from "./right-now-facts";
import { rightNowTiles, type RightNowTile } from "./right-now";

/**
 * Each tile's number is a count of rows, and changing the rows changes the number.
 *
 * Firia ruling 2026-10-17: Health = four Right-now tiles on Today. The figures the mockup
 * draws (png/health-demo-1440.png, png/health-demo-390.png) are what these rows add up to:
 * 12/12 placed, 2/3 vans checked with Van 3 still open, one van running late (Van 2), and two
 * things that need a person.
 *
 * docs/DATA-MODEL.md: a NEEDS_PERSON staff alert is an open task of that kind, and the van
 * check is `vehicle_setup_day` in state CHECKED. The plan is `plan_run` / `plan_assignment`.
 */

const DATE = "2026-10-17";
const LEG = "AM" as const;
const WINDOW_START = "2026-10-17T14:30:00Z";
const WINDOW_END = "2026-10-17T15:00:00Z";
const LATE = "2026-10-17T15:12:00Z";
const ON_TIME = "2026-10-17T14:50:00Z";

const open: PGlite[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((pg) => pg.close().catch(() => {})));
});

async function database(): Promise<Db> {
  const { pg, db } = await freshDb();
  open.push(pg);
  return db;
}

async function family(db: Db): Promise<string> {
  const group = uuidv7();
  const child = uuidv7();
  await db.query(
    `INSERT INTO ops.family_group (id, site_id, display_label, created_by, updated_by)
     VALUES ($1, $2, 'F (Demo)', 'test', 'test')`,
    [group, SITE],
  );
  await db.query(
    `INSERT INTO ops.child_profile (child_token, site_id, family_group_id, display_name, created_by, updated_by)
     VALUES ($1, $2, $3, 'Syn C.', 'test', 'test')`,
    [child, SITE, group],
  );
  return child;
}

async function van(db: Db, label: string): Promise<string> {
  const id = uuidv7();
  await db.query(
    `INSERT INTO ops.vehicle (id, site_id, label, lift_equipped, created_by, updated_by)
     VALUES ($1, $2, $3, true, 'test', 'test')`,
    [id, SITE, label],
  );
  return id;
}

async function setup(db: Db, vehicleId: string, state: "CHECKED" | "DEFAULT"): Promise<void> {
  await db.query(
    `INSERT INTO ops.vehicle_setup_day
       (id, site_id, vehicle_id, service_date, seats, wheelchair_spots, car_seats, oxygen_mounts, has_lift, state, created_by, updated_by)
     VALUES ($1, $2, $3, $4, 4, 0, 0, 0, true, $5, 'test', 'test')`,
    [uuidv7(), SITE, vehicleId, DATE, state],
  );
}

async function plan(db: Db, children: readonly { token: string; vehicleId: string | null; bucket: string }[]): Promise<string> {
  const run = uuidv7();
  await db.query(
    `INSERT INTO ops.plan_run (id, site_id, service_date, direction, created_by, updated_by)
     VALUES ($1, $2, $3, $4, 'test', 'test')`,
    [run, SITE, DATE, LEG],
  );
  for (const child of children) {
    await db.query(
      `INSERT INTO ops.plan_assignment
         (plan_run_id, site_id, child_token, vehicle_id, bucket, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, 'test', 'test')`,
      [run, SITE, child.token, child.vehicleId, child.bucket],
    );
  }
  return run;
}

async function arrival(
  db: Db,
  vehicleId: string,
  childToken: string,
  etaAt: string,
): Promise<string> {
  const manifest = uuidv7();
  const leg = uuidv7();
  const eta = uuidv7();
  await db.query(
    `INSERT INTO ops.manifest (id, site_id, service_date, direction, vehicle_id, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, 'test', 'test')`,
    [manifest, SITE, DATE, LEG, vehicleId],
  );
  await db.query(
    `INSERT INTO ops.trip_leg
       (id, site_id, child_token, service_date, direction, mode, manifest_id, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, 'PROVIDER', $6, 'test', 'test')`,
    [leg, SITE, childToken, DATE, LEG, manifest],
  );
  await db.query(
    `INSERT INTO ops.eta_estimate
       (id, site_id, trip_leg_id, computed_at, eta_at, uncertainty_sec, window_start, window_end, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, 60, $6, $7, 'test', 'test')`,
    [eta, SITE, leg, "2026-10-17T14:40:00Z", etaAt, WINDOW_START, WINDOW_END],
  );
  return eta;
}

async function needsPerson(db: Db, state = "OPEN"): Promise<string> {
  const id = uuidv7();
  await db.query(
    `INSERT INTO ops.task
       (id, site_id, category, severity, state, summary, completion_predicate, created_by, updated_by)
     VALUES ($1, $2, 'NEEDS_PERSON', 'RED', $3, 'A person has to answer', 'staff', 'test', 'test')`,
    [id, SITE, state],
  );
  return id;
}

function one(tiles: readonly RightNowTile[], key: RightNowTile["key"]): RightNowTile {
  const found = tiles.find((t) => t.key === key);
  if (!found) throw new Error(`no ${key}`);
  return found;
}

describe("kids placed follows the saved plan", () => {
  /**
   * png/health-demo-1440.png: Kids placed 12/12, pill All.
   * Firia ruling 2026-10-17: Health = four Right-now tiles on Today. The number is the plan's
   * rows, so taking a child out of a van changes it.
   */
  it("counts children in a van, and drops one when a child is no longer in one", async () => {
    const db = await database();
    const vanId = await van(db, "V1");
    const tokens = [];
    for (let i = 0; i < 12; i += 1) tokens.push(await family(db));
    await plan(
      db,
      tokens.map((token) => ({ token, vehicleId: vanId, bucket: "VAN" })),
    );

    const before = one(rightNowTiles(await loadRightNow(db, SITE, DATE, LEG)), "KIDS_PLACED");
    expect(before.count).toBe(12);
    expect(before.outOf).toBe(12);
    expect(before.pill?.text).toBe("All");

    await db.query(
      `UPDATE ops.plan_assignment SET bucket = 'UNASSIGNED', vehicle_id = NULL WHERE child_token = $1`,
      [tokens[0]],
    );
    const after = one(rightNowTiles(await loadRightNow(db, SITE, DATE, LEG)), "KIDS_PLACED");
    expect(after.count).toBe(11);
    expect(after.outOf).toBe(12);
    expect(after.pill).toBeNull();
  }, 60_000);

  /**
   * Family drives and absent are not children the plan is still seating.
   * docs/DATA-MODEL.md: plan_assignment.bucket is VAN, UNASSIGNED, FAMILY_DRIVES or ABSENT.
   */
  it("does not count a child the family drives, or one who is absent, as someone to place", async () => {
    const db = await database();
    const vanId = await van(db, "V1");
    const riding = await family(db);
    const drives = await family(db);
    const absent = await family(db);
    await plan(db, [
      { token: riding, vehicleId: vanId, bucket: "VAN" },
      { token: drives, vehicleId: null, bucket: "FAMILY_DRIVES" },
      { token: absent, vehicleId: null, bucket: "ABSENT" },
    ]);
    const kids = one(rightNowTiles(await loadRightNow(db, SITE, DATE, LEG)), "KIDS_PLACED");
    expect(kids.count).toBe(1);
    expect(kids.outOf).toBe(1);
    expect(kids.pill?.text).toBe("All");
  }, 60_000);
});

describe("vans checked follows the ramp", () => {
  /**
   * png/health-demo-1440.png: Vans checked 2/3, pill Van 3.
   * Firia ruling 2026-10-17: the tile agrees with the step strip. Checking the open van
   * changes both.
   */
  it("counts CHECKED vans and names the one that is not, then moves when it is checked", async () => {
    const db = await database();
    const v1 = await van(db, "V1");
    const v2 = await van(db, "V2");
    const v3 = await van(db, "V3 substitute van");
    await setup(db, v1, "CHECKED");
    await setup(db, v2, "CHECKED");
    await setup(db, v3, "DEFAULT");

    const before = one(rightNowTiles(await loadRightNow(db, SITE, DATE, LEG)), "VANS_CHECKED");
    const day = await readDayFacts(db, SITE, DATE, LEG);
    expect(before.count).toBe(day.vansChecked);
    expect(before.outOf).toBe(day.vans);
    expect(before.count).toBe(2);
    expect(before.outOf).toBe(3);
    expect(before.pill?.text).toBe("Van 3");
    expect(before.pill?.text).not.toMatch(/\bV\d\b/);

    await db.query(
      `UPDATE ops.vehicle_setup_day SET state = 'CHECKED' WHERE vehicle_id = $1`,
      [v3],
    );
    const afterFacts = await loadRightNow(db, SITE, DATE, LEG);
    const after = one(rightNowTiles(afterFacts), "VANS_CHECKED");
    const dayAfter = await readDayFacts(db, SITE, DATE, LEG);
    expect(after.count).toBe(3);
    expect(after.outOf).toBe(3);
    expect(after.count).toBe(dayAfter.vansChecked);
    expect(after.outOf).toBe(dayAfter.vans);
    expect(after.pill?.text).toBe("All");
  }, 60_000);
});

describe("running late follows the latest arrival", () => {
  /**
   * png/health-demo-1440.png: Running late 1, pill Van 2.
   * Firia ruling 2026-10-17: Health = four Right-now tiles on Today. The number is the vans
   * whose latest estimate is past the window, so bringing that estimate back changes it.
   */
  it("counts a van past its window, and drops it when the estimate comes back inside", async () => {
    const db = await database();
    const v2 = await van(db, "V2");
    const child = await family(db);
    const eta = await arrival(db, v2, child, LATE);

    const before = one(rightNowTiles(await loadRightNow(db, SITE, DATE, LEG)), "RUNNING_LATE");
    expect(before.count).toBe(1);
    expect(before.pill?.text).toBe("Van 2");

    await db.query(`UPDATE ops.eta_estimate SET eta_at = $2 WHERE id = $1`, [eta, ON_TIME]);
    const after = one(rightNowTiles(await loadRightNow(db, SITE, DATE, LEG)), "RUNNING_LATE");
    expect(after.count).toBe(0);
    expect(after.pill).toBeNull();
  }, 60_000);

  /** An earlier late estimate does not count once a later one is inside the window. */
  it("uses the latest estimate, not an older one that was late", async () => {
    const db = await database();
    const v2 = await van(db, "V2");
    const child = await family(db);
    const eta = await arrival(db, v2, child, LATE);
    await db.query(
      `INSERT INTO ops.eta_estimate
         (id, site_id, trip_leg_id, computed_at, eta_at, uncertainty_sec, window_start, window_end, created_by, updated_by)
       SELECT $1, site_id, trip_leg_id, $2, $3, uncertainty_sec, window_start, window_end, created_by, updated_by
         FROM ops.eta_estimate WHERE id = $4`,
      [uuidv7(), "2026-10-17T14:45:00Z", ON_TIME, eta],
    );
    const late = one(rightNowTiles(await loadRightNow(db, SITE, DATE, LEG)), "RUNNING_LATE");
    expect(late.count).toBe(0);
  }, 60_000);
});

describe("needs you follows the open staff alerts", () => {
  /**
   * png/health-demo-1440.png: Needs you 2, pill Family texts.
   * docs/DATA-MODEL.md: the staff alert is kind NEEDS_PERSON, state OPEN, and it shows in
   * Family texts. Closing one changes the tile. A task of another kind does not count.
   */
  it("counts open NEEDS_PERSON tasks, and drops one when it is no longer open", async () => {
    const db = await database();
    const first = await needsPerson(db);
    await needsPerson(db);
    await db.query(
      `INSERT INTO ops.task
         (id, site_id, category, severity, state, summary, completion_predicate, created_by, updated_by)
       VALUES ($1, $2, 'OTHER', 'AMBER', 'OPEN', 'Not this tile', 'staff', 'test', 'test')`,
      [uuidv7(), SITE],
    );

    const before = one(rightNowTiles(await loadRightNow(db, SITE, DATE, LEG)), "NEEDS_YOU");
    expect(before.count).toBe(2);
    expect(before.pill?.text).toBe("Family texts");

    await db.query(`UPDATE ops.task SET state = 'RESOLVED_APPROVED' WHERE id = $1`, [first]);
    const after = one(rightNowTiles(await loadRightNow(db, SITE, DATE, LEG)), "NEEDS_YOU");
    expect(after.count).toBe(1);
    expect(after.pill?.text).toBe("Family texts");
  }, 60_000);
});

describe("a tile counts only this centre", () => {
  /**
   * docs/DATA-MODEL.md: a staff alert and a van check belong to a site. The other centre's
   * open NEEDS_PERSON task and its unchecked van are not this centre's numbers.
   */
  it("ignores the other site's unchecked van and its open alerts", async () => {
    const db = await database();
    const other = "00000000-0000-7000-8000-000000000099";
    await db.query(
      `INSERT INTO ops.site (id, org_id, name, depot_lat, depot_lng, created_by, updated_by)
       VALUES ($1, $2, 'SYN Other', 26.64, -80.14, 'test', 'test')`,
      [other, ORG],
    );
    const v1 = await van(db, "V1");
    const v2 = await van(db, "V2");
    const v3 = await van(db, "V3");
    await setup(db, v1, "CHECKED");
    await setup(db, v2, "CHECKED");
    await setup(db, v3, "DEFAULT");
    await db.query(
      `INSERT INTO ops.vehicle (id, site_id, label, lift_equipped, created_by, updated_by)
       VALUES ($1, $2, 'A other van', true, 'test', 'test')`,
      [uuidv7(), other],
    );
    await needsPerson(db);
    await needsPerson(db);
    for (let i = 0; i < 4; i++) {
      await db.query(
        `INSERT INTO ops.task
           (id, site_id, category, severity, state, summary, completion_predicate, created_by, updated_by)
         VALUES ($1, $2, 'NEEDS_PERSON', 'RED', 'OPEN', 'Other centre', 'staff', 'test', 'test')`,
        [uuidv7(), other],
      );
    }

    const tiles = rightNowTiles(await loadRightNow(db, SITE, DATE, LEG));
    const vans = one(tiles, "VANS_CHECKED");
    const needs = one(tiles, "NEEDS_YOU");
    // The other centre's van sorts first by label. It must not become the pill.
    expect(vans.count).toBe(2);
    expect(vans.outOf).toBe(3);
    expect(vans.pill?.text).toBe("Van 3");
    expect(needs.count).toBe(2);
  }, 60_000);
});
