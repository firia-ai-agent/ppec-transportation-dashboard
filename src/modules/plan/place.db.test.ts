import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { NEED_CATEGORY } from "@/config/equipment";
import { VANS } from "@/config/vans";
import type { Db } from "@/db/exec";
import { childrenInBucket, ridersInVan, usedInVan } from "@/domain/plan/board";
import { usedBy } from "@/domain/plan/fit";
import { freshPlanDb, SITE } from "@/test/pglite";
import { childTokenOf, vehicleIdOf } from "@/modules/demo/fixtures/standard";
import { seedStandardScenario } from "@/modules/demo/seed";
import { sqlDaySource } from "@/modules/roster/sql";
import { setChildNeeds } from "@/modules/roster/needs-write";
import { applyPendingMoves, setChildAwayAllDay, setChildPlacement } from "./place";
import { autoPlan } from "@/domain/plan/board";
import { setChildNeedsRequest } from "./api";
import { loadBoard } from "./store";
import { sqlPlanStore } from "./sql";
import type { PlanStore } from "./types";

/**
 * The drags and the saves, **against a database** — the only place they are proved (Firia,
 * 2026-10-17 7:18 PM ET).
 *
 * It runs on PGlite by default: a throwaway Postgres in this process, with every migration in
 * `drizzle/` applied, no server to start and nothing anybody can point at the wrong database.
 * `pnpm test:db` runs the same file, and with `TEST_DATABASE_URL` set it runs against a local
 * Postgres instead (src/test/pglite.ts, which refuses any host that is not loopback). The shared
 * Neon database is never touched by either: previews are read-only and nothing here knows its
 * name.
 *
 * What it is here to prove, end to end and in rows:
 *  - a drag writes `plan_assignment` and bumps `plan_run.version` — every time, never silently;
 *  - Absent and Family drives are **placements on this day's plan**, per leg, with no vehicle;
 *  - a stale version is a 409 and changes nothing;
 *  - the child panel's Save writes `transport_need_item` on the approved profile and the plan
 *    the board reads back has moved (gate (c): wheelchair, car seat and oxygen each do it).
 */

let db: Db;
let close: () => Promise<void>;
let store: PlanStore;

const NOW = new Date("2026-10-16T17:45:00.000Z");
const DATE = "2026-10-16";
const vanOne = () => vehicleIdOf(VANS[0].vehicleKey);
const vanTwo = () => vehicleIdOf(VANS[1].vehicleKey);
/** Theo V. (C8) rides the afternoon and needs nothing, so he fits anywhere. */
const THEO = () => childTokenOf("C8");
/**
 * The third van, which is the same generic van as the other two (Vera/Athena/Veri with Firia's
 * sign-off, 2026-10-18 12:13 AM ET): one wheelchair spot, like all of them. A chair is refused
 * from it when that **spot is already used**, which is a count and not a weaker vehicle.
 */
const vanThree = () => vehicleIdOf(VANS[2].vehicleKey);

const source = () => sqlDaySource(db, SITE);
const board = (direction: "AM" | "PM" = "PM") =>
  loadBoard(store, SITE, DATE, direction, source());

beforeAll(async () => {
  ({ db, close } = await freshPlanDb());
  await seedStandardScenario(db, {
    now: NOW,
    siteId: SITE,
    env: { APP_DATA_CLASS: "SYNTHETIC", DEMO_MODE: "1", HMAC_PEPPER: "p", DATA_KEY: "k" },
  });
  store = sqlPlanStore(db);
}, 180_000);

afterAll(async () => {
  await close();
});

beforeEach(async () => {
  // Each test starts from no plan at all, which is what a reset leaves behind.
  await db.query("DELETE FROM ops.plan_assignment", []);
  await db.query("DELETE FROM ops.plan_run", []);
});

/** The day's own clock has to say the day is started, or every write is a 409 by design. */
async function startTheDay(): Promise<void> {
  const started = await board();
  expect(started.started, "the seeded scenario clock starts the day").toBe(true);
}

describe("a drag is a row, and a new version every time", () => {
  it("puts a child in a van, bumps the version, and reads back after a reload", async () => {
    await startTheDay();
    const first = await setChildPlacement(
      {
        siteId: SITE,
        serviceDate: DATE,
        direction: "PM",
        childToken: THEO(),
        bucket: "VAN",
        vehicleId: vanOne(),
        expectedVersion: 0,
        actor: null,
        now: NOW,
      },
      store,
      source(),
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.version).toBe(1);

    // The row is what the next read sees, which is what "survives a reload" means.
    const reloaded = await board();
    expect(reloaded.plan[THEO()]).toMatchObject({ bucket: "VAN", vanId: vanOne() });
    expect(ridersInVan(reloaded.day, reloaded.plan, vanOne()).map((r) => r.token)).toContain(THEO());

    const rows = await db.query<{ bucket: string; vehicle_id: string | null }>(
      `SELECT bucket, vehicle_id::text AS vehicle_id FROM ops.plan_assignment
        WHERE child_token = $1::uuid`,
      [THEO()],
    );
    expect(rows.rows[0]).toMatchObject({ bucket: "VAN", vehicle_id: vanOne() });

    // A second move is a second version — never an overwrite of the first.
    const second = await setChildPlacement(
      {
        siteId: SITE,
        serviceDate: DATE,
        direction: "PM",
        childToken: THEO(),
        bucket: "VAN",
        vehicleId: vanTwo(),
        expectedVersion: first.version,
        actor: null,
        now: NOW,
      },
      store,
      source(),
    );
    expect(second.ok && second.version).toBe(2);
  });

  it("refuses a stale version with a 409 and leaves the plan alone", async () => {
    await startTheDay();
    const first = await setChildPlacement(
      { siteId: SITE, serviceDate: DATE, direction: "PM", childToken: THEO(), bucket: "VAN",
        vehicleId: vanOne(), expectedVersion: 0, actor: null, now: NOW },
      store,
      source(),
    );
    expect(first.ok).toBe(true);

    const stale = await setChildPlacement(
      { siteId: SITE, serviceDate: DATE, direction: "PM", childToken: THEO(), bucket: "VAN",
        vehicleId: vanTwo(), expectedVersion: 0, actor: null, now: NOW },
      store,
      source(),
    );
    expect(stale).toMatchObject({ ok: false, status: 409, reason: "CHANGED" });
    const after = await board();
    expect(after.plan[THEO()].vanId).toBe(vanOne());
    expect(after.version).toBe(1);
  });

  /**
   * Firia's option A (2026-10-17 10:29 PM ET): a stale draft is told "Plan changed, reload".
   * The version is judged **first**, so a draft built on an old plan is never refused for a
   * reason that belongs to a plan its author has not seen.
   */
  it("answers a stale draft with CHANGED even when its move would not fit either", async () => {
    await startTheDay();
    const kept = await setChildPlacement(
      { siteId: SITE, serviceDate: DATE, direction: "PM", childToken: THEO(), bucket: "VAN",
        vehicleId: vanOne(), expectedVersion: 0, actor: null, now: NOW },
      store,
      source(),
    );
    expect(kept.ok).toBe(true);

    // Noah O. rides in his own chair and this van has no spot for it: a 422 on a fresh board.
    const stale = await setChildPlacement(
      { siteId: SITE, serviceDate: DATE, direction: "PM", childToken: childTokenOf("C2"),
        bucket: "VAN", vehicleId: vanThree(), expectedVersion: 0, actor: null, now: NOW },
      store,
      source(),
    );
    expect(stale).toMatchObject({ ok: false, status: 409, reason: "CHANGED" });
    const after = await board();
    expect(after.version).toBe(1);
    expect(after.plan[childTokenOf("C2")]?.bucket).not.toBe("VAN");
  });

  it("refuses a drop the fit rule refuses, with the reason and no row", async () => {
    await startTheDay();
    // Zoe B. rides in her own chair and takes the van's one wheelchair spot…
    const first = await setChildPlacement(
      { siteId: SITE, serviceDate: DATE, direction: "PM", childToken: childTokenOf("C6"),
        bucket: "VAN", vehicleId: vanThree(), expectedVersion: 0, actor: null, now: NOW },
      store,
      source(),
    );
    expect(first.ok).toBe(true);

    // …so Noah O.'s chair is refused from it, by name, and nothing of his is written.
    const before = await board();
    const refused = await setChildPlacement(
      { siteId: SITE, serviceDate: DATE, direction: "PM", childToken: childTokenOf("C2"),
        bucket: "VAN", vehicleId: vanThree(), expectedVersion: before.version, actor: null, now: NOW },
      store,
      source(),
    );
    expect(refused).toMatchObject({ ok: false, status: 422, reason: "WHEELCHAIR" });
    const after = await board();
    expect(after.version).toBe(before.version);
    expect(after.plan[childTokenOf("C2")]?.bucket).not.toBe("VAN");
  });
});

/**
 * Save: the whole queue, in one transaction (Firia's option A, 2026-10-17 10:29 PM ET).
 *
 * The board drags into a queue and writes nothing, so everything that matters happens here —
 * on a real database, because "all or nothing" is a transaction claim and nothing else can
 * prove it.
 */
describe("Save applies every pending move at once, or none of them", () => {
  it("writes one new version for the whole queue", async () => {
    await startTheDay();
    const riders = (await board()).day.riders.slice(0, 3);
    const moves = riders.map((rider, i) => ({
      childToken: rider.token,
      bucket: "VAN" as const,
      vanId: [vanOne(), vanTwo(), vanOne()][i],
    }));
    const written = await applyPendingMoves(
      { siteId: SITE, serviceDate: DATE, direction: "PM", moves, expectedVersion: 0, actor: null, now: NOW },
      store,
      source(),
    );
    expect(written.ok).toBe(true);
    if (!written.ok) return;
    expect(written.version).toBe(1);
    const after = await board();
    for (const move of moves) expect(after.plan[move.childToken].vanId).toBe(move.vanId);
    // One version for the lot, not one per move.
    const runs = await db.query<{ version: number }>("SELECT version FROM ops.plan_run", []);
    expect(runs.rows.map((row) => Number(row.version))).toEqual([1]);
  });

  it("writes nothing at all when one move in the queue is refused", async () => {
    await startTheDay();
    const day = (await board()).day;
    const chairs = day.riders.filter((rider) => rider.needs.wheelchair);
    expect(chairs.length).toBeGreaterThan(1);
    const anybody = day.riders.find((rider) => !rider.needs.wheelchair)!;
    const refused = await applyPendingMoves(
      {
        siteId: SITE,
        serviceDate: DATE,
        direction: "PM",
        moves: [
          { childToken: anybody.token, bucket: "VAN", vanId: vanOne() },
          // Two chairs into a van with one spot: the second move cannot be applied, so the
          // first one is not written either.
          { childToken: chairs[0].token, bucket: "VAN", vanId: vanThree() },
          { childToken: chairs[1].token, bucket: "VAN", vanId: vanThree() },
        ],
        expectedVersion: 0,
        actor: null,
        now: NOW,
      },
      store,
      source(),
    );
    expect(refused).toMatchObject({ ok: false, status: 422 });
    // Not even the good move landed, and there is no plan at all.
    expect((await db.query("SELECT 1 FROM ops.plan_run", [])).rows).toHaveLength(0);
    expect((await board()).plan[anybody.token].bucket).not.toBe("VAN");
  });

  it("refuses the whole queue on a stale version, and changes nothing", async () => {
    await startTheDay();
    const riders = (await board()).day.riders;
    await applyPendingMoves(
      {
        siteId: SITE, serviceDate: DATE, direction: "PM", expectedVersion: 0, actor: null, now: NOW,
        moves: [{ childToken: riders[0].token, bucket: "VAN", vanId: vanOne() }],
      },
      store,
      source(),
    );
    const stale = await applyPendingMoves(
      {
        siteId: SITE, serviceDate: DATE, direction: "PM", expectedVersion: 0, actor: null, now: NOW,
        moves: [{ childToken: riders[1].token, bucket: "VAN", vanId: vanTwo() }],
      },
      store,
      source(),
    );
    expect(stale).toMatchObject({ ok: false, status: 409, reason: "CHANGED" });
    const after = await board();
    expect(after.version).toBe(1);
    expect(after.plan[riders[1].token].bucket).not.toBe("VAN");
  });

  it("saves Auto-plan's moves to the same plan a fresh run would give", async () => {
    await startTheDay();
    const before = await board();
    const planned = autoPlan(before.day, before.plan);
    const moves = Object.entries(planned)
      .filter(([token, placement]) => before.plan[token]?.vanId !== placement.vanId)
      .map(([token, placement]) => ({
        childToken: token,
        bucket: placement.bucket,
        vanId: placement.vanId,
      }));
    expect(moves.length).toBeGreaterThan(0);

    const written = await applyPendingMoves(
      { siteId: SITE, serviceDate: DATE, direction: "PM", moves, expectedVersion: 0, actor: null, now: NOW },
      store,
      source(),
    );
    expect(written.ok).toBe(true);
    const after = await board();
    for (const rider of after.day.riders) {
      expect({ who: rider.name, van: after.plan[rider.token].vanId }).toEqual({
        who: rider.name,
        van: planned[rider.token].vanId,
      });
    }
  });
});

describe("Absent and Family drives are placements on this day's plan", () => {
  it("writes the bucket with no van, and the board reads it back", async () => {
    await startTheDay();
    const away = await setChildPlacement(
      { siteId: SITE, serviceDate: DATE, direction: "PM", childToken: THEO(), bucket: "ABSENT",
        expectedVersion: 0, actor: null, now: NOW },
      store,
      source(),
    );
    expect(away.ok).toBe(true);
    const rows = await db.query<{ bucket: string; vehicle_id: string | null }>(
      `SELECT bucket, vehicle_id::text AS vehicle_id FROM ops.plan_assignment WHERE child_token = $1::uuid`,
      [THEO()],
    );
    expect(rows.rows[0]).toEqual({ bucket: "ABSENT", vehicle_id: null });

    // And they come back: a drag out of the group is the same one writer.
    const back = await setChildPlacement(
      { siteId: SITE, serviceDate: DATE, direction: "PM", childToken: THEO(), bucket: "VAN",
        vehicleId: vanOne(), expectedVersion: (away as { version: number }).version, actor: null, now: NOW },
      store,
      source(),
    );
    expect(back.ok).toBe(true);
    expect((await board()).plan[THEO()]).toMatchObject({ bucket: "VAN", vanId: vanOne() });
  });

  it("is per leg: away this afternoon is not away this morning", async () => {
    await startTheDay();
    await setChildPlacement(
      { siteId: SITE, serviceDate: DATE, direction: "PM", childToken: THEO(), bucket: "ABSENT",
        expectedVersion: 0, actor: null, now: NOW },
      store,
      source(),
    );
    expect((await board("PM")).plan[THEO()].bucket).toBe("ABSENT");
    expect((await board("AM")).plan[THEO()].bucket).not.toBe("ABSENT");
  });

  it("marks a child away for the whole day by writing both legs", async () => {
    await startTheDay();
    const both = await setChildAwayAllDay(
      { siteId: SITE, serviceDate: DATE, childToken: THEO(), actor: null, now: NOW,
        expectedVersions: { AM: 0, PM: 0 } },
      store,
      source(),
    );
    expect(both.AM.ok && both.PM.ok).toBe(true);
    expect((await board("AM")).plan[THEO()].bucket).toBe("ABSENT");
    expect((await board("PM")).plan[THEO()].bucket).toBe("ABSENT");

    // Tomorrow starts clean: nothing carries over, because a plan is per date.
    const tomorrow = await loadBoard(store, SITE, "2026-10-17", "PM", source());
    expect(tomorrow.plan[THEO()].bucket).not.toBe("ABSENT");
  });
});

/**
 * Veri F3, 2026-10-17: **a needs Save is all-or-nothing.** The item rows and the re-planned plan
 * are one decision, so a 409 from the version check must leave the child's needs exactly as they
 * were — otherwise the screen says "somebody else saved first" while the record has already
 * changed under it, and a reload shows a pinned child in a van that no longer fits.
 */
describe("a Family drives child is a child of the plan (Firia, 2026-10-18)", () => {
  /**
   * Ana S. is one of the three the centre does not drive: `am_mode`/`pm_mode` is `FAMILY` and
   * she has no `stop_location`, so the SQL day source hands her over as an "other" and the board
   * draws her in the Family drives lane. The report was that the lane was a line reading "3".
   *
   * What is proved here is the half a browser cannot: the move a coordinator makes on that card
   * is a row. It passes the two checks a save runs — `namesOnlyThisDay` and `checkPlan`, both
   * inside `writePlan` — it comes back on the next read of the day, and it goes home again.
   */
  const ANA = () => childTokenOf("C10");

  it("is handed over by the roster with her approved needs and no stop of ours", async () => {
    const day = (await board()).day;
    const ana = day.others.find((other) => other.token === ANA());
    expect(ana, "Ana S. is a child the centre does not drive this leg").toBeTruthy();
    expect(ana!.name).toBe("Ana S.");
    // Nothing approved, so the one fit rule asks for a seat and nothing else.
    expect(ana!.needs).toEqual({ wheelchair: false, carSeat: false, oxygen: false, nurse: false });
    expect(ana!.stopLabel).toBe("");
    expect(day.riders.some((rider) => rider.token === ANA())).toBe(false);
    // And the plan she arrives on has her in the lane, not waiting.
    expect((await board()).plan[ANA()]).toMatchObject({ bucket: "FAMILY_DRIVES", vanId: null });
  });

  it("goes onto a van through the save path, and is in the van on the next read", async () => {
    await startTheDay();
    const saved = await applyPendingMoves(
      {
        siteId: SITE,
        serviceDate: DATE,
        direction: "PM",
        moves: [{ childToken: ANA(), bucket: "VAN", vanId: vanOne() }],
        expectedVersion: 0,
        actor: null,
        now: NOW,
      },
      store,
      source(),
    );
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    expect(saved.version).toBe(1);

    const rows = await db.query<{ bucket: string; vehicle_id: string | null; stop_seq: number | null }>(
      `SELECT bucket, vehicle_id::text AS vehicle_id, stop_seq FROM ops.plan_assignment
        WHERE child_token = $1::uuid`,
      [ANA()],
    );
    // In the van, and not a stop: there is no kerb of ours to drive her to.
    expect(rows.rows[0]).toMatchObject({ bucket: "VAN", vehicle_id: vanOne(), stop_seq: null });

    const reloaded = await board();
    expect(reloaded.plan[ANA()]).toMatchObject({ bucket: "VAN", vanId: vanOne() });
    expect(ridersInVan(reloaded.day, reloaded.plan, vanOne()).map((r) => r.token)).toContain(ANA());
    // And her seat is counted, which is what `eligibility` and `checkPlan` now agree on.
    expect(usedInVan(reloaded.day, reloaded.plan, vanOne()).seats).toBe(1);
  });

  it("goes back into Family drives, and stays there on the next read", async () => {
    await startTheDay();
    const onto = await applyPendingMoves(
      { siteId: SITE, serviceDate: DATE, direction: "PM",
        moves: [{ childToken: ANA(), bucket: "VAN", vanId: vanOne() }],
        expectedVersion: 0, actor: null, now: NOW },
      store,
      source(),
    );
    expect(onto.ok).toBe(true);
    if (!onto.ok) return;

    const home = await applyPendingMoves(
      { siteId: SITE, serviceDate: DATE, direction: "PM",
        moves: [{ childToken: ANA(), bucket: "FAMILY_DRIVES", vanId: null }],
        expectedVersion: onto.version, actor: null, now: NOW },
      store,
      source(),
    );
    expect(home.ok).toBe(true);

    const reloaded = await board();
    expect(reloaded.plan[ANA()]).toMatchObject({ bucket: "FAMILY_DRIVES", vanId: null });
    expect(ridersInVan(reloaded.day, reloaded.plan, vanOne()).map((r) => r.token)).not.toContain(ANA());
    expect(
      childrenInBucket(reloaded.day, reloaded.plan, "FAMILY_DRIVES").map((child) => child.name),
    ).toEqual(["Ana S.", "Beni A.", "Cleo M."]);
  });

  it("takes a seat like anybody else: a full Van 1 fits, and full plus Ana does not", async () => {
    await startTheDay();
    const view = await board();
    const day = view.day;
    const van = day.vans.find((candidate) => candidate.id === vanOne());
    if (!van) throw new Error("the day does not run Van 1");
    /*
     * Enough children to fill Van 1's seats exactly and overrun no other counter: car-seat
     * riders up to the car seats the van carries, then riders who need nothing at all.
     *
     * The numbers come off **this van's own setup** rather than being written here (they were
     * "six seats, three car seats" until Firia's S1 of 2026-10-18, when the shared default
     * became the configuration the seeded van is actually fitted as): one default, in
     * src/config/vans.ts, and no second copy of it in a test that would then have to be edited
     * alongside it. The claim is unchanged and is the one the bug was about — the van is filled
     * to its counts, and the next child is refused.
     */
    const ambulatory = day.riders.filter(
      (rider) => !rider.needs.wheelchair && !rider.needs.nurse && !rider.needs.oxygen,
    );
    const fill = [
      ...ambulatory.filter((rider) => rider.needs.carSeat).slice(0, van.setup.carSeats),
      ...ambulatory.filter((rider) => !rider.needs.carSeat),
    ].slice(0, van.setup.seats);
    expect(usedBy(fill)).toMatchObject({ seats: van.setup.seats, wheelchairSpots: 0 });
    expect(usedBy(fill).carSeats).toBeLessThanOrEqual(van.setup.carSeats);

    const six = await applyPendingMoves(
      {
        siteId: SITE,
        serviceDate: DATE,
        direction: "PM",
        moves: fill.map((rider) => ({ childToken: rider.token, bucket: "VAN" as const, vanId: vanOne() })),
        expectedVersion: 0,
        actor: null,
        now: NOW,
      },
      store,
      source(),
    );
    expect(six.ok).toBe(true);
    if (!six.ok) return;
    expect(usedInVan(six.view.day, six.view.plan, vanOne()).seats).toBe(van.setup.seats);

    /*
     * Ana would be one more, and every seat is taken. **This is the half that was broken**: she
     * was not a rider the server counted at all, so `checkPlan` replayed Van 1 without her and
     * this save would have been kept — a van carrying one more child than it has seats.
     */
    const seventh = await applyPendingMoves(
      { siteId: SITE, serviceDate: DATE, direction: "PM",
        moves: [{ childToken: ANA(), bucket: "VAN", vanId: vanOne() }],
        expectedVersion: six.version, actor: null, now: NOW },
      store,
      source(),
    );
    expect(seventh).toMatchObject({ ok: false, status: 422, reason: "SEAT", vanId: vanOne() });

    // And nothing was written: the version is still the one the six left behind, and Ana is
    // still in her lane.
    const after = await board();
    expect(after.version).toBe(six.version);
    expect(after.plan[ANA()]).toMatchObject({ bucket: "FAMILY_DRIVES", vanId: null });
  });
});

describe("a needs Save and its re-plan are one transaction", () => {
  const approvedCategories = async (token: string) => {
    const rows = await db.query<{ category: string }>(
      `SELECT ni.category FROM ops.transport_need_item ni
         JOIN ops.transport_profile tp ON tp.id = ni.profile_id
        WHERE tp.child_token = $1::uuid AND ni.state = 'APPROVED' ORDER BY ni.category`,
      [token],
    );
    return rows.rows.map((row) => row.category);
  };

  it("rolls the need rows back when the plan save hits a stale version", async () => {
    await startTheDay();
    // Somebody saves first, so the version the panel is holding is already behind.
    const first = await setChildPlacement(
      { siteId: SITE, serviceDate: DATE, direction: "PM", childToken: THEO(), bucket: "VAN",
        vehicleId: vanOne(), expectedVersion: 0, actor: null, now: NOW },
      store,
      source(),
    );
    expect(first.ok).toBe(true);

    const before = await approvedCategories(THEO());
    const stale = await setChildNeedsRequest(
      SITE,
      { userId: undefined },
      THEO(),
      { date: DATE, direction: "PM", wheelchair: false, carSeat: true, oxygen: true, version: 0 },
      NOW,
      store,
      { DATABASE_URL: "configured" },
      db,
      source(),
    );
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ ok: false, reason: "CHANGED" });
    // The need rows are exactly as they were: the transaction took them back with it.
    expect(await approvedCategories(THEO())).toEqual(before);
    // And the plan is still the one the first write left.
    expect((await board()).plan[THEO()]).toMatchObject({ bucket: "VAN", vanId: vanOne() });
  });

  it("keeps both when the version is the one the caller was holding", async () => {
    await startTheDay();
    const before = await approvedCategories(THEO());
    expect(before).not.toContain(NEED_CATEGORY.oxygen);
    const ok = await setChildNeedsRequest(
      SITE,
      { userId: undefined },
      THEO(),
      { date: DATE, direction: "PM", wheelchair: false, carSeat: false, oxygen: true, version: 0 },
      NOW,
      store,
      { DATABASE_URL: "configured" },
      db,
      source(),
    );
    expect(ok.status).toBe(200);
    expect(await approvedCategories(THEO())).toContain(NEED_CATEGORY.oxygen);
    expect((await db.query("SELECT version FROM ops.plan_run", [])).rows).toHaveLength(1);
  });
});

describe("gate (c): the child panel's Save moves the board", () => {
  const needsOf = async (token: string) => {
    const view = await board();
    return view.day.riders.find((rider) => rider.token === token)?.needs;
  };

  it("writes the three categories on the approved profile, and nothing else", async () => {
    const written = await setChildNeeds(db, {
      siteId: SITE,
      childToken: THEO(),
      panel: { wheelchair: false, carSeat: true, oxygen: true },
      actor: null,
      now: NOW,
    });
    expect(written).toMatchObject({ ok: true });
    const rows = await db.query<{ category: string; state: string }>(
      `SELECT ni.category, ni.state::text AS state
         FROM ops.transport_need_item ni
         JOIN ops.transport_profile tp ON tp.id = ni.profile_id
        WHERE tp.child_token = $1::uuid ORDER BY ni.category`,
      [THEO()],
    );
    const byCategory = Object.fromEntries(rows.rows.map((row) => [row.category, row.state]));
    expect(byCategory[NEED_CATEGORY.carSeat]).toBe("APPROVED");
    expect(byCategory[NEED_CATEGORY.oxygen]).toBe("APPROVED");
    expect(byCategory[NEED_CATEGORY.wheelchair]).toBeUndefined();

    // One approved profile, still version 1: the panel edits items, it does not supersede.
    const profiles = await db.query<{ n: number; version: number }>(
      `SELECT count(*)::int AS n, max(profile_version) AS version FROM ops.transport_profile
        WHERE child_token = $1::uuid`,
      [THEO()],
    );
    expect(profiles.rows[0]).toMatchObject({ n: 1, version: 1 });
  });

  it("leaves transport_profile.mobility exactly as intake left it", async () => {
    const before = await db.query<{ mobility: string }>(
      `SELECT mobility::text AS mobility FROM ops.transport_profile WHERE child_token = $1::uuid`,
      [childTokenOf("C2")],
    );
    await setChildNeeds(db, {
      siteId: SITE,
      childToken: childTokenOf("C2"),
      panel: { wheelchair: false, carSeat: false, oxygen: false },
      actor: null,
      now: NOW,
    });
    const after = await db.query<{ mobility: string }>(
      `SELECT mobility::text AS mobility FROM ops.transport_profile WHERE child_token = $1::uuid`,
      [childTokenOf("C2")],
    );
    expect(after.rows[0].mobility).toBe(before.rows[0].mobility);
    // …and the flag the planner reads has still changed, because it is the item that counts.
    expect((await needsOf(childTokenOf("C2")))?.wheelchair).toBe(false);
  });

  it("each of the three flags changes the plan it is saved into", async () => {
    await startTheDay();
    for (const [flag, counter] of [
      ["wheelchair", "wheelchairSpots"],
      ["carSeat", "carSeats"],
      ["oxygen", "oxygenMounts"],
    ] as const) {
      // Start from nothing, then turn exactly one on and re-plan through the same request the
      // panel's Save makes.
      await db.query("DELETE FROM ops.plan_assignment", []);
      await db.query("DELETE FROM ops.plan_run", []);
      await setChildNeeds(db, {
        siteId: SITE, childToken: THEO(), actor: null, now: NOW,
        panel: { wheelchair: false, carSeat: false, oxygen: false },
      });
      const answer = await setChildNeedsRequest(
        SITE,
        { userId: undefined },
        THEO(),
        {
          date: DATE,
          direction: "PM",
          wheelchair: flag === "wheelchair",
          carSeat: flag === "carSeat",
          oxygen: flag === "oxygen",
          version: 0,
        },
        NOW,
        store,
        { DATABASE_URL: "configured" },
        db,
        source(),
      );
      expect({ flag, status: answer.status }).toEqual({ flag, status: 200 });
      if (answer.status !== 200) continue;

      // The flag came back on the rider…
      expect({ flag, on: answer.body.needs[flag] }).toEqual({ flag, on: true });
      // …and the van they were re-planned into is counting it.
      const view = answer.body.view;
      const vanId = view.plan[THEO()]?.vanId ?? "";
      expect({ flag, placed: vanId !== "" }).toEqual({ flag, placed: true });
      const used = usedInVan(view.day, view.plan, vanId);
      expect({ flag, used: used[counter] > 0 }).toEqual({ flag, used: true });
    }
  });
});
