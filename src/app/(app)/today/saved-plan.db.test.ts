import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultSetupOf, vanConfigOf, vanNameOf } from "@/config/vans";
import type { Db } from "@/db/exec";
import { buildBoard, demoDay, type Board } from "@/domain/board/board";
import { getDayReadiness, legAt, serviceDateAt } from "@/domain/day/day-facts";
import { loadRightNow } from "@/domain/health/right-now-facts";
import { rightNowTiles, vanOnScreen, type RightNowTile } from "@/domain/health/right-now";
import { ridersInVan, type BoardVan } from "@/domain/plan/board";
import { eligibility } from "@/domain/plan/eligibility";
import { isOver, usedBy } from "@/domain/plan/fit";
import { VEHICLES, childTokenOf, vehicleIdOf } from "@/modules/demo/fixtures/standard";
import { seedStandardScenario } from "@/modules/demo/seed";
import { kidsInVan, loadSavedPlan, vansInPlan } from "@/modules/live-map/plan-read";
import { applyPendingMoves, setChildPlacement } from "@/modules/plan/place";
import { putVanSetupRequest } from "@/modules/plan/api";
import { sqlPlanStore } from "@/modules/plan/sql";
import { savedPlacementsForBoard, savedSetupsForBoard } from "@/modules/plan/store";
import { loadBoard } from "@/modules/plan/store";
import { sqlDaySource } from "@/modules/roster/sql";
import { freshPlanDb, SITE } from "@/test/pglite";
import {
  AUTO_PLANNED_VANS,
  MOVED_CHILD,
  MOVED_FROM,
  MOVED_TO,
  REFERENCE_MORNING,
  VERI_FIVE,
} from "@/test/reference-plan";
import type { PlanStore } from "@/modules/plan/types";

/**
 * ONE SAVED PLAN, FOUR READERS, AGAINST A DATABASE.
 *
 * SOURCE: Firia's signed rule of 2026-10-17 6:02 PM ET — "Today, Live map and Health read the
 * saved plan" — the S1 ruling of 2026-10-18 4:45 AM ET, and the scope added at 4:47 and 4:54 AM
 * ET: Health counts the same facts. Veri's prod check had found Today's morning van column
 * disagreeing with the board a director had just saved for five of nine children; two of Health's
 * four tiles are counted *per van*, so the same disagreement was theirs to make.
 *
 * ./saved-plan.test.ts proves the round trip on the memory store — the store a server with no
 * `DATABASE_URL` gets — and so cannot reach a line of SQL. This file is the other half: the same
 * morning (src/test/reference-plan.ts, Firia's 5:09 AM ET prod re-save), saved through the same
 * writers, on **PGlite with every migration in `drizzle/` applied** (src/test/pglite.ts, which is
 * also what `pnpm test:db` points at a throwaway local Postgres). Nothing here touches a shared
 * database: the seed and the reads are this process's own.
 *
 * What it is here to prove, in rows:
 *  - the step strip's Plan step follows the plan (`getDayReadiness`, src/domain/day/day-facts.ts):
 *    Needed before the save, Done and stamped after it, for that date **and** that leg;
 *  - Today's van column and Health's "Kids placed" are the same two numbers — `VAN` placed and
 *    `VAN`+`UNASSIGNED` to place — so the tile and the column cannot read differently;
 *  - Health's "Running late" blames the van the **plan** puts the late child on, not the van the
 *    seeded manifest has them on;
 *  - the board, Today, Health and the Live map agree about all nine children.
 */

/*
 * The Live map's reader opens the server's own database (`getNeonDb`, src/db/exec.ts) rather than
 * taking one, so this is how it is pointed at the migrated PGlite database in front of it. The
 * rest of the module is the real one — `runAfterCommit` included, which the harness itself uses.
 * `DATABASE_URL` is stubbed for the same reason: `hasNoDatabase()` is what sends that reader to
 * the memory store, and the plan under test is in these tables.
 */
let db: Db;
vi.mock("@/db/exec", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/db/exec")>()),
  getNeonDb: () => db,
}));

/** 07:30 at the centre on Friday 2026-10-16: the morning leg of the day the seed writes. */
const NOW = new Date("2026-10-16T11:30:00.000Z");
const DATE = "2026-10-16";
const LEG = "AM" as const;

let close: () => Promise<void>;
let store: PlanStore;

const source = () => sqlDaySource(db, SITE);
const token = (childKey: string) => childTokenOf(childKey);
const vanId = (vehicleKey: string) => vehicleIdOf(vehicleKey);
/** The number painted on this van's door, from the one fleet config (§1.5). */
const slotOf = (vehicleKey: string): number => {
  const config = vanConfigOf(vehicleKey);
  if (!config) throw new Error(`no van config for ${vehicleKey}`);
  return config.slot;
};

beforeAll(async () => {
  ({ db, close } = await freshPlanDb());
  await seedStandardScenario(db, {
    now: NOW,
    siteId: SITE,
    env: { APP_DATA_CLASS: "SYNTHETIC", DEMO_MODE: "1", HMAC_PEPPER: "p", DATA_KEY: "k" },
  });
  store = sqlPlanStore(db);
  vi.stubEnv("DATABASE_URL", "postgres://syn-pglite/never-connected");
}, 180_000);

afterAll(async () => {
  vi.unstubAllEnvs();
  await close();
});

beforeEach(async () => {
  // Every test starts from the day a reset leaves behind: no plan at all, no arrival estimate,
  // and no van counted — the seed writes no `vehicle_setup_day` row either (seed.ts), so every
  // van is on its configured default until a test has the ramp count one.
  await db.query("DELETE FROM ops.plan_assignment", []);
  await db.query("DELETE FROM ops.plan_run", []);
  await db.query("DELETE FROM ops.eta_estimate", []);
  await db.query("DELETE FROM ops.vehicle_setup_day", []);
});

/** Save Auto-plan's morning, exactly as the board's Save does: every move, one version. */
async function saveTheMorning(): Promise<void> {
  const written = await applyPendingMoves(
    {
      siteId: SITE,
      serviceDate: DATE,
      direction: LEG,
      moves: Object.entries(AUTO_PLANNED_VANS).flatMap(([vehicleKey, childKeys]) =>
        childKeys.map((childKey) => ({
          childToken: token(childKey),
          bucket: "VAN" as const,
          vanId: vanId(vehicleKey),
        })),
      ),
      expectedVersion: 0,
      actor: null,
      now: NOW,
    },
    store,
    source(),
  );
  expect(written.ok, "reason" in written ? written.reason : "saved").toBe(true);
}

/** One child's drag, as the board's own `Move to…` does it. */
async function moveChild(
  childKey: string,
  bucket: "VAN" | "UNASSIGNED" | "FAMILY_DRIVES" | "ABSENT",
  vehicleKey: string | null,
  expectedVersion: number,
): Promise<void> {
  const moved = await setChildPlacement(
    {
      siteId: SITE,
      serviceDate: DATE,
      direction: LEG,
      childToken: token(childKey),
      bucket,
      vehicleId: vehicleKey === null ? null : vanId(vehicleKey),
      expectedVersion,
      actor: null,
      now: NOW,
    },
    store,
    source(),
  );
  expect(moved.ok, "reason" in moved ? moved.reason : "moved").toBe(true);
}

/**
 * ONE VAN COUNTED AT THE RAMP, through the write the iPad's Confirm actually makes:
 * `putVanSetupRequest` (src/modules/plan/api.ts), which is
 * src/app/api/vans/[id]/setup/route.ts in two lines, writing one `ops.vehicle_setup_day` row as
 * `CHECKED` for this date.
 *
 * The caller is the browser check's own shape — a role and no user id — so `set_by` is null and
 * the screens attribute the count to the ramp rather than to an invented person. All three roles
 * may confirm (§2); that the write touches no other table is src/modules/plan/confirm.db.test.ts.
 */
async function countAtRamp(
  vehicleKey: string,
  counts: { seats: number; wheelchairSpots: number; carSeats: number; oxygenMounts: number },
): Promise<void> {
  const answer = await putVanSetupRequest(
    SITE,
    { userId: undefined, role: "FRONT_DESK" },
    vanId(vehicleKey),
    { date: DATE, ...counts, hasLift: true, state: "CHECKED" },
    NOW,
    store,
  );
  expect(answer.status, "reason" in answer.body ? answer.body.reason : "counted").toBe(200);
}

/** Firia's morning, saved: Auto-plan, then Liam D. dragged to Van 2. */
async function saveTheReferenceMorning(): Promise<void> {
  await saveTheMorning();
  await moveChild(MOVED_CHILD, "VAN", MOVED_TO, 1);
}

/**
 * Today, built the way the page builds it: the saved plan **and** what each van is planned on —
 * the `CHECKED` row the ramp wrote, else the van's default — both read through `loadBoard`
 * (src/modules/plan/store.ts). The setups are the second half of the page's read since Firia's
 * S1 of 2026-10-18: this screen's fit check is the board's own counts now, and never the seeded
 * seating layouts.
 */
async function todayBoard(): Promise<Board> {
  const [saved, setups] = await Promise.all([
    savedPlacementsForBoard(SITE, DATE, store, source()),
    savedSetupsForBoard(SITE, DATE, store, source()),
  ]);
  return buildBoard(demoDay(), saved, setups);
}

/** Health's four tiles, read the way the page reads them. */
async function healthTiles(): Promise<readonly RightNowTile[]> {
  return rightNowTiles(await loadRightNow(db, SITE, DATE, LEG));
}

function tile(tiles: readonly RightNowTile[], key: RightNowTile["key"]): RightNowTile {
  const found = tiles.find((t) => t.key === key);
  if (!found) throw new Error(`no ${key}`);
  return found;
}

const morningLegs = (board: Board) => board.legs.filter((leg) => leg.ride.direction === LEG);
const morningRow = (board: Board, childKey: string) => {
  const leg = morningLegs(board).find((l) => l.child.childKey === childKey);
  if (!leg) throw new Error(`no morning row for ${childKey}`);
  return leg;
};

/** What the saved rows themselves say, counted in the database and in no other way. */
async function savedBuckets(): Promise<Record<string, number>> {
  const rows = await db.query<{ bucket: string; n: number }>(
    `SELECT a.bucket::text AS bucket, count(*)::int AS n
       FROM ops.plan_assignment a
       JOIN ops.plan_run r ON r.id = a.plan_run_id
      WHERE r.site_id = $1 AND r.service_date = $2::date AND r.direction::text = $3
      GROUP BY a.bucket`,
    [SITE, DATE, LEG],
  );
  return Object.fromEntries(rows.rows.map((r) => [r.bucket, Number(r.n)]));
}

/**
 * A late arrival for one child's morning ride, on the manifest the **seed** put them on.
 *
 * The seed writes today's manifests and trip legs but no estimate (src/modules/demo/seed.ts §8),
 * so this is the one row the scenario does not have. It is deliberately hung off the seeded
 * manifest: that is the van the old query named, and the test below is that the plan's van is
 * named instead.
 */
async function runningLate(childKey: string): Promise<void> {
  const leg = await db.query<{ id: string }>(
    `SELECT id::text AS id FROM ops.trip_leg
      WHERE site_id = $1 AND child_token = $2 AND service_date = $3::date AND direction::text = $4`,
    [SITE, token(childKey), DATE, LEG],
  );
  expect(leg.rows[0], `${childKey} has a seeded morning leg`).toBeTruthy();
  await db.query(
    `INSERT INTO ops.eta_estimate
       (id, site_id, trip_leg_id, computed_at, eta_at, uncertainty_sec, window_start, window_end,
        created_by, updated_by)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, 60, $5, $6, 'test', 'test')`,
    [
      SITE,
      leg.rows[0].id,
      "2026-10-16T11:00:00Z",
      "2026-10-16T11:45:00Z",
      "2026-10-16T11:10:00Z",
      "2026-10-16T11:30:00Z",
    ],
  );
}

describe("the day's three steps follow the saved plan", () => {
  /**
   * REDESIGN-SPEC §9.4, and the scope added 2026-10-18 4:47 AM ET: the step strip above the board
   * and the board itself are about one day. `getDayReadiness` reads whether a `plan_run` exists
   * for this date and leg, so saving the morning through the real writer is what finishes the
   * step — there is no second notion of "saved" anywhere.
   */
  it("is Needed before the save and Done, stamped, after it", async () => {
    const asked = { siteId: SITE, now: NOW, exec: db };
    const before = await getDayReadiness(asked);
    expect(before.date, "the fixed now is the demo date").toBe(DATE);
    expect(before.leg, "…and the matching leg").toBe(LEG);
    expect(before.plan.state).toBe("NEEDED");
    expect(before.plan.savedAt).toBeNull();
    // §9.1's one hard arrow: no saved plan for this leg, no live map.
    expect(before.live.blockedBy).toBe("PLAN");

    await saveTheReferenceMorning();

    const after = await getDayReadiness(asked);
    expect(after.plan.state).toBe("DONE");
    expect(after.plan.savedAt).toBeInstanceOf(Date);
    expect(after.live.blockedBy).toBeNull();
  }, 60_000);

  /** A plan is per date **and** per leg: a saved morning does not finish the afternoon's step. */
  it("leaves the afternoon's step Needed when only the morning is saved", async () => {
    await saveTheReferenceMorning();
    const afternoon = new Date("2026-10-16T17:30:00.000Z"); // 13:30 at the centre
    expect(serviceDateAt(afternoon)).toBe(DATE);
    expect(legAt(afternoon)).toBe("PM");

    const pm = await getDayReadiness({ siteId: SITE, now: afternoon, exec: db });
    expect(pm.plan.state).toBe("NEEDED");
    expect(pm.plan.savedAt).toBeNull();
  }, 60_000);
});

describe("Today's van column and Health's Kids placed are the same two numbers", () => {
  /**
   * The scope added 2026-10-18 4:54 AM ET: "Kids placed" must count exactly what Today and the
   * board show for the leg. Both sides are counted here from the one saved plan — Today through
   * `savedPlacementsForBoard` and `buildBoard`, the tile through #76's own `PLACED` statement —
   * and the saved rows' own buckets are counted a third time, in SQL, as the arbiter.
   */
  it("counts the rides on a van, and the saved VAN rows, as one number", async () => {
    await saveTheReferenceMorning();

    const buckets = await savedBuckets();
    const facts = await loadRightNow(db, SITE, DATE, LEG);
    const onAVan = morningLegs(await todayBoard()).filter(
      (leg) => leg.ride.vanNumber !== null,
    ).length;

    expect(buckets.VAN, "nine of nine placed (Firia, 5:09 AM ET)").toBe(9);
    expect(buckets.UNASSIGNED ?? 0).toBe(0);
    expect(facts.placed).toBe(buckets.VAN);
    expect(facts.toPlace).toBe((buckets.VAN ?? 0) + (buckets.UNASSIGNED ?? 0));
    expect(onAVan, "Today's morning rides on a van").toBe(facts.placed);

    const kids = tile(rightNowTiles(facts), "KIDS_PLACED");
    expect(kids.count).toBe(9);
    expect(kids.outOf).toBe(9);
  }, 60_000);

  /**
   * And with one child out of a van, which is the shape the tile's fraction is actually for. Ivy
   * H. (C8) is *seeded* on Van 1, so "no van" is a different answer from the fixture's: a Today
   * that ignored the plan would still count nine on a van here.
   */
  it("drops one from both sides when a child is left unassigned", async () => {
    await saveTheReferenceMorning();
    await moveChild("C8", "UNASSIGNED", null, 2);

    const buckets = await savedBuckets();
    const facts = await loadRightNow(db, SITE, DATE, LEG);
    const legs = morningLegs(await todayBoard());
    const onAVan = legs.filter((leg) => leg.ride.vanNumber !== null).length;
    const findingAVan = legs.filter((leg) => leg.nextStep === "FIND_VAN").length;

    expect(buckets.VAN).toBe(8);
    expect(buckets.UNASSIGNED).toBe(1);
    expect(facts.placed).toBe(8);
    expect(facts.toPlace).toBe(9);
    expect(onAVan, "Today's morning rides on a van").toBe(facts.placed);
    expect(findingAVan, "…and the rows still looking for one").toBe(
      facts.toPlace - facts.placed,
    );
    expect(morningRow(await todayBoard(), "C8").ride.vanNumber).toBeNull();

    const kids = tile(rightNowTiles(facts), "KIDS_PLACED");
    expect(kids.count).toBe(8);
    expect(kids.outOf).toBe(9);
    expect(kids.pill, "8 of 9 is not All").toBeNull();
  }, 60_000);

  /**
   * The three children the day's roster has but this leg does not carry are Family drives, and a
   * family driving is not somebody waiting for a van (docs/DATA-MODEL.md: the buckets are VAN,
   * UNASSIGNED, FAMILY_DRIVES, ABSENT). Nine is the leg's cohort, twelve is the census.
   */
  it("does not count the three the family drives among the nine to place", async () => {
    await saveTheReferenceMorning();
    const buckets = await savedBuckets();
    const facts = await loadRightNow(db, SITE, DATE, LEG);
    expect(buckets.FAMILY_DRIVES).toBe(3);
    expect(facts.toPlace).toBe(9);
  }, 60_000);
});

describe("Health's Running late blames the van the plan put the child on", () => {
  /**
   * The scope added 2026-10-18 4:54 AM ET. Ava N. (C4) is **seeded** on Van 3 (standard.ts
   * `RUNS`, R3) and Firia's saved morning puts her on **Van 1**. Her ride is the one running late,
   * so the pill has to say Van 1 — the van she is sitting on, on Today, on the board and on the
   * live map. Reading the van off `ops.manifest` is how a director saw Today and Health blame two
   * different vans for one late child.
   */
  it("names the planned van, not the seeded manifest's van", async () => {
    await runningLate("C4");

    // With nothing saved, the seeded manifest is all there is to go on: Van 3, unchanged.
    const seeded = await loadRightNow(db, SITE, DATE, LEG);
    expect(seeded.lateVans).toEqual([vanOnScreen(vanNameOf(slotOf("V3")))]);

    await saveTheReferenceMorning();

    const planned = await loadRightNow(db, SITE, DATE, LEG);
    expect(planned.lateVans).toEqual([vanNameOf(slotOf(REFERENCE_MORNING.C4))]);
    expect(planned.lateVans, "not the van she was seeded on").not.toContain(
      vanNameOf(slotOf("V3")),
    );
    // And the tile says the same thing, with the one van named on its pill.
    const late = tile(rightNowTiles(planned), "RUNNING_LATE");
    expect(late.count).toBe(1);
    expect(late.pill?.text).toBe(vanNameOf(1));
    // The child is on that van everywhere else, too.
    expect(morningRow(await todayBoard(), "C4").ride.vehicleLabel).toBe(vanNameOf(1));
  }, 60_000);

  /**
   * A late ride the plan has taken off a van is not a van running late. "Her family drives her
   * today" is a decision, and no van is behind on a ride it is not driving.
   */
  it("names no van when the plan has taken that child off one", async () => {
    await runningLate("C4");
    await saveTheReferenceMorning();
    await moveChild("C4", "FAMILY_DRIVES", null, 2);

    const facts = await loadRightNow(db, SITE, DATE, LEG);
    expect(facts.lateVans).toEqual([]);
    expect(tile(rightNowTiles(facts), "RUNNING_LATE").count).toBe(0);
  }, 60_000);

  /**
   * Two late children the plan puts on one van is one van, and the latest estimate is still the
   * one that counts (#76). Liam D. (C3) is dragged onto Van 2, where Noah O. (C2) already is.
   */
  it("counts one van once, however many of its rides are late", async () => {
    await saveTheReferenceMorning();
    await runningLate(MOVED_CHILD);
    await runningLate("C2");

    const facts = await loadRightNow(db, SITE, DATE, LEG);
    expect(facts.lateVans).toEqual([vanNameOf(slotOf(MOVED_TO))]);
  }, 60_000);
});

describe("the board, Today, Health and the Live map agree about all nine", () => {
  /**
   * Firia's prod re-save of 2026-10-18 5:09 AM ET, child by child, through four readers: the plan
   * board (`loadBoard`), Today (`buildBoard` over `savedPlacementsForBoard`), Health
   * (`loadRightNow`) and the Live map (its own `loadSavedPlan` / `kidsInVan`). Veri's five are
   * named explicitly, because those are the five a director saw two different answers for.
   */
  it("puts every child on one van, and counts each van the same way four times", async () => {
    await saveTheReferenceMorning();

    const board = await loadBoard(store, SITE, DATE, LEG, source());
    const today = await todayBoard();
    const live = await loadSavedPlan(SITE, DATE, LEG);
    const facts = await loadRightNow(db, SITE, DATE, LEG);
    expect(live, "the live map reads the same rows").not.toBeNull();

    for (const [childKey, vehicleKey] of Object.entries(REFERENCE_MORNING)) {
      const where = `${childKey} → ${vehicleKey}`;
      // The board: the plan as the screen it was saved on reads it.
      expect(board.plan[token(childKey)], where).toMatchObject({
        bucket: "VAN",
        vanId: vanId(vehicleKey),
      });
      // Today: the van number and the van's name on the morning row, which is what Veri compared.
      const row = morningRow(today, childKey);
      expect(row.ride.vanNumber, where).toBe(slotOf(vehicleKey));
      expect(row.ride.vehicleLabel, where).toBe(vanNameOf(slotOf(vehicleKey)));
      // The live map: the same child in the same van, through its own read of the same two tables.
      expect(live?.placements[token(childKey)]?.vanId, where).toBe(vanId(vehicleKey));
    }

    // Veri's five, named — every one of which was showing the seeded run and not the saved plan.
    for (const [childKey, vehicleKey] of Object.entries(VERI_FIVE)) {
      expect(morningRow(today, childKey).ride.vanNumber, childKey).toBe(slotOf(vehicleKey));
    }

    // Van by van: 2, 4, 3 — the same three counts off all four readers.
    let placed = 0;
    for (const vehicleKey of ["V1", "V2", "V3"]) {
      const onBoard = ridersInVan(board.day, board.plan, vanId(vehicleKey)).length;
      const onToday = morningLegs(today).filter(
        (leg) => leg.ride.vanNumber === slotOf(vehicleKey),
      ).length;
      expect(onBoard, vehicleKey).toBe(REFERENCE_MORNING_COUNTS[vehicleKey]);
      expect(onToday, vehicleKey).toBe(onBoard);
      expect(kidsInVan(live, vehicleKey), vehicleKey).toBe(onBoard);
      placed += onBoard;
    }
    // Health counts the same nine, as one fraction rather than per van.
    expect(facts.placed).toBe(placed);
    expect(facts.toPlace).toBe(placed);
    expect(vansInPlan(live).sort()).toEqual([vanId("V1"), vanId("V2"), vanId("V3")].sort());
  }, 60_000);

  /**
   * The one child, the one move — the bug as a director made it. Liam D. (C3) is *seeded* on
   * Van 2, so the half that proves this is a test of the fix rather than of the fixture is the
   * first one: on Van 1, where Auto-plan put him, the fixture and the plan give different answers.
   */
  it("follows Liam D. from Van 1 to Van 2, on every screen", async () => {
    await saveTheMorning();
    expect(morningRow(await todayBoard(), MOVED_CHILD).ride.vanNumber).toBe(slotOf(MOVED_FROM));

    await moveChild(MOVED_CHILD, "VAN", MOVED_TO, 1);

    const today = await todayBoard();
    const live = await loadSavedPlan(SITE, DATE, LEG);
    expect(morningRow(today, MOVED_CHILD).ride.vanNumber).toBe(slotOf(MOVED_TO));
    expect(morningRow(today, MOVED_CHILD).ride.vehicleLabel).toBe(vanNameOf(slotOf(MOVED_TO)));
    expect(live?.placements[token(MOVED_CHILD)]?.vanId).toBe(vanId(MOVED_TO));
    expect(kidsInVan(live, MOVED_TO)).toBe(4);
    expect(kidsInVan(live, MOVED_FROM)).toBe(2);
  }, 60_000);
});

/** Firia's layout, as three counts: Van 1 carries two, Van 2 four, Van 3 three. */
const REFERENCE_MORNING_COUNTS: Record<string, number> = Object.entries(
  REFERENCE_MORNING,
).reduce<Record<string, number>>((counts, [, vehicleKey]) => {
  counts[vehicleKey] = (counts[vehicleKey] ?? 0) + 1;
  return counts;
}, {});

describe("Today's fit check reads the saved van's riders", () => {
  /**
   * SOURCE: Firia, 2026-10-18 6:23 AM ET, with the 5:09 AM morning saved and every van
   * fit-checked — Today's Needs action still read "Move Mia R. / Owen C. / Theo V. to a van that
   * fits". The van on each of those rows was already the saved plan's (Van 3), but the seating
   * question behind it was still asked about the **seeded** manifest: `solveRun` handed the
   * solver `run.childKeys`, which for Van 3 is Mia R., Ava N. and Eli N. — three car-seat riders
   * in a layout with two tether seats, infeasible about a manifest the save had replaced.
   *
   * So the three below are about one thing: which riders the solver is asked about. The warning
   * itself is untouched — the second test saves a van that genuinely cannot hold what the plan
   * put in it and Today says so, in the same words, with the same step.
   */
  const misfits = (board: Board): string[] =>
    morningLegs(board)
      .filter((leg) => leg.needsActionReasons.includes("DOES_NOT_FIT"))
      .map((leg) => leg.child.childKey);

  /** The rides of one saved van, which all have to come back with the one same verdict. */
  const ridesOnVan = (board: Board, vehicleKey: string) =>
    morningLegs(board).filter((leg) => leg.ride.vanNumber === slotOf(vehicleKey));

  /**
   * (a) Firia's morning, fit-checked: Van 3 carries Mia R., Owen C. and Theo V. — one car seat
   * and one harness in two tether seats — so nobody is asked to move, and no other van's riders
   * are either. Nine rides, nine seating verdicts, not one of them a warning.
   */
  it("warns about none of the nine when every saved van holds its riders", async () => {
    await saveTheReferenceMorning();
    const today = await todayBoard();

    expect(misfits(today), "nobody is asked to move to a van that fits").toEqual([]);
    for (const childKey of ["C1", "C7", "C9"]) {
      const row = morningRow(today, childKey);
      expect(row.ride.vanNumber, `${childKey} is on Van 3`).toBe(slotOf("V3"));
      expect(row.ride.solver, childKey).toBe("FEASIBLE");
      expect(row.nextStep, childKey).not.toBe("MOVE_TO_FITTING_VAN");
    }

    // All nine, van by van: one solve per (van, leg), so a van's riders cannot disagree.
    const placed = morningLegs(today).filter((leg) => leg.ride.vanNumber !== null);
    expect(placed).toHaveLength(9);
    for (const leg of placed) {
      expect(leg.ride.solver, `${leg.child.childKey} fits the van the plan put them on`).toBe(
        "FEASIBLE",
      );
    }
    for (const vehicleKey of ["V1", "V2", "V3"]) {
      const verdicts = new Set(ridesOnVan(today, vehicleKey).map((leg) => leg.ride.solver));
      expect(verdicts.size, `${vehicleKey}: one verdict for the whole van`).toBe(1);
    }
  }, 60_000);

  /**
   * (b) And a saved van that really does not hold its riders still says so — which, now that the
   * board and this screen read **one** set of counts, is a van the ramp counted *down* under a
   * plan somebody had already saved. The front desk reaches Van 1 and finds one seat and no car
   * seat where the plan has Zoe B. (her nurse rides in a seat) and Ava N. (a booster): the plan
   * is untouched, nobody is un-saved, and Today says the van no longer holds them (§1.3's "Over
   * capacity"; boarding is what the ramp check stops, not planning).
   *
   * This is the half that proves nothing is being suppressed: the reason, the step and the
   * verdict are the same three the bug was reported as.
   *
   * It used to build that state by **dragging three more children onto Van 1** and leaning on
   * the disagreement this commit removes: the board's save accepted five riders because the van's
   * counts said six seats, and the seat-level solver refused them because the seeded layout said
   * `1WC/3A`. The drag is now refused at the board (src/domain/plan/eligibility.ts) — which is
   * the fix — so the over-filled van has to come from the one place that can still produce one.
   */
  it("still warns when the ramp counts a saved van down under its riders", async () => {
    await saveTheReferenceMorning();
    const before = await todayBoard();
    expect(misfits(before), "the saved plan fits before anybody counts the van").toEqual([]);

    await countAtRamp("V1", { seats: 1, wheelchairSpots: 1, carSeats: 0, oxygenMounts: 1 });

    const today = await todayBoard();
    const crowded = ridesOnVan(today, "V1");
    expect(crowded.map((leg) => leg.child.childKey).sort()).toEqual(["C4", "C6"].sort());
    for (const leg of crowded) {
      expect(leg.ride.solver, leg.child.childKey).toBe("INFEASIBLE");
      expect(leg.needsActionReasons, leg.child.childKey).toContain("DOES_NOT_FIT");
      expect(leg.nextStep, leg.child.childKey).toBe("MOVE_TO_FITTING_VAN");
      expect(leg.group, leg.child.childKey).toBe("NEEDS_ACTION");
    }
    // Every rider of the counted-down van, and only them: Van 2's four are not dragged in too.
    expect(misfits(today).sort()).toEqual(["C4", "C6"].sort());
    // And the plan itself is untouched by the count (src/modules/plan/confirm.db.test.ts holds
    // that in rows): the two are still on Van 1, which is why the row has something to say.
    for (const leg of crowded) expect(leg.ride.vanNumber).toBe(slotOf("V1"));
  }, 60_000);

  /**
   * (c) With nothing saved for the leg there is no plan to read, and the seeded run is still the
   * manifest: Van 3's own three (Mia R., Ava N., Eli N.) do not fit it and Today says so, exactly
   * as it did before this fix. The whole board is compared both ways, so "unchanged" is the
   * output of `buildBoard` and not a fit verdict picked out of it.
   */
  it("falls back to the seeded run when nothing is saved for the leg", async () => {
    const nothing = await savedPlacementsForBoard(SITE, DATE, store, source());
    expect(nothing, "a reset day has no plan for either leg").toEqual({});

    const today = buildBoard(demoDay(), nothing);
    expect(today, "byte for byte the seeded board").toEqual(buildBoard(demoDay()));
    expect(misfits(today), "the seeded Van 3's own riders, as before").toEqual(["C1", "C4", "C5"]);
    for (const childKey of ["C1", "C4", "C5"]) {
      expect(morningRow(today, childKey).ride.solver, childKey).toBe("INFEASIBLE");
    }
  }, 60_000);
});
/* ─────────────────── one stored setup, two screens (S1, 2026-10-18) ─────────────────── */

/**
 * WHAT THIS VAN HOLDS IS ONE ANSWER, AND IT IS THE STORED ONE.
 *
 * SOURCE: Firia's S1 of 2026-10-18. The board planned a van on today's `CHECKED`
 * `ops.vehicle_setup_day` row else the shared default (src/domain/plan/setup.ts), and Today
 * checked the same van against the **seeded seating layouts** of
 * src/modules/demo/fixtures/standard.ts — so the board let a coordinator put six children and a
 * wheelchair in a van whose layout is one chair space and three seats, and Today reported the
 * plan the board had just accepted as not fitting.
 *
 * Both screens read one shared resolution now (`resolveSetups` / `setupFor`), and these are the
 * rows that hold it: a real `vehicle_setup_day` row, written through the **ramp's own write
 * path** (`putVanSetupRequest`, which is src/app/api/vans/[id]/setup/route.ts in two lines), on
 * PGlite with every migration in `drizzle/` applied. Each read below is a fresh `loadBoard` /
 * `buildBoard` — which is what a reload is — so "after a reload" is the thing being asserted and
 * not a cache being trusted.
 */
describe("one stored setup, two screens", () => {
  const vanOnBoard = (view: { day: { vans: readonly BoardVan[] } }, vehicleKey: string): BoardVan => {
    const found = view.day.vans.find((van) => van.id === vanId(vehicleKey));
    if (!found) throw new Error(`the day does not run ${vehicleKey}`);
    return found;
  };
  const boardView = () => loadBoard(store, SITE, DATE, LEG, source());
  const misfits = (today: Board): string[] =>
    morningLegs(today)
      .filter((leg) => leg.needsActionReasons.includes("DOES_NOT_FIT"))
      .map((leg) => leg.child.childKey);
  const ridesOnVan = (today: Board, vehicleKey: string) =>
    morningLegs(today).filter((leg) => leg.ride.vanNumber === slotOf(vehicleKey));

  /**
   * (b) THE OXYGEN COUNTER. Zoe B. travels with oxygen and the plan has her on Van 1, which
   * carries one mount by default. The front desk reaches the ramp and finds the mount gone: one
   * row written, and after a reload the board plans Van 1 on no mount and refuses her, and Today
   * says the same about the same van — in the same breath, because it is the same number.
   */
  it("(b) both screens follow the Oxygen counter the ramp changed", async () => {
    await saveTheReferenceMorning();
    const before = vanOnBoard(await boardView(), "V1");
    expect(before.setup.oxygenMounts, "the default mount").toBe(
      defaultSetupOf("V1").oxygenMounts,
    );
    expect(before.setupState, "nobody has counted it yet").toBe("DEFAULT");
    expect(misfits(await todayBoard()), "and nothing to warn about").toEqual([]);

    await countAtRamp("V1", { seats: 3, wheelchairSpots: 1, carSeats: 2, oxygenMounts: 0 });

    const counted = await boardView();
    const vanOne = vanOnBoard(counted, "V1");
    expect(vanOne.setup.oxygenMounts, "the counted mount, after a reload").toBe(0);
    expect(vanOne.setupState).toBe("CHECKED");
    expect(vanOne.setupSource).toBe("CHECKED");
    expect(
      eligibility(counted.day, counted.plan, token("C6"), vanOne.id),
      "the board names the counter that ran out",
    ).toEqual({ ok: false, reason: "OXYGEN" });

    const today = await todayBoard();
    expect(misfits(today).sort(), "and Today warns about that van's riders").toEqual(
      ["C4", "C6"].sort(),
    );
    for (const leg of ridesOnVan(today, "V1")) {
      expect(leg.ride.solver, leg.child.childKey).toBe("INFEASIBLE");
      expect(leg.nextStep, leg.child.childKey).toBe("MOVE_TO_FITTING_VAN");
    }

    // And counted back up — the mount was behind the seat — both screens let go of it.
    await countAtRamp("V1", { seats: 3, wheelchairSpots: 1, carSeats: 2, oxygenMounts: 1 });
    const again = await boardView();
    expect(vanOnBoard(again, "V1").setup.oxygenMounts).toBe(1);
    expect(eligibility(again.day, again.plan, token("C6"), vanId("V1"))).toEqual({ ok: true });
    expect(misfits(await todayBoard())).toEqual([]);
  }, 60_000);

  /**
   * (b) AND THE CAR SEATS. Van 3 carries Mia R. (a car seat) and Owen C. (a vest, which is one of
   * the same seats) in the two the van has. The ramp finds one: both screens follow it down.
   */
  it("(b) both screens follow the car-seat counter the ramp changed", async () => {
    await saveTheReferenceMorning();
    expect(misfits(await todayBoard())).toEqual([]);

    await countAtRamp("V3", { seats: 3, wheelchairSpots: 1, carSeats: 1, oxygenMounts: 1 });

    const counted = await boardView();
    const vanThree = vanOnBoard(counted, "V3");
    expect(vanThree.setup.carSeats).toBe(1);
    expect(usedBy(ridersInVan(counted.day, counted.plan, vanThree.id)).carSeats).toBe(2);
    expect(isOver(vanThree.setup, ridersInVan(counted.day, counted.plan, vanThree.id))).toBe(true);
    expect(eligibility(counted.day, counted.plan, token("C1"), vanThree.id)).toEqual({
      ok: false,
      reason: "CAR_SEAT",
    });

    const today = await todayBoard();
    expect(misfits(today).sort()).toEqual(["C1", "C7", "C9"].sort());
    for (const leg of ridesOnVan(today, "V3")) {
      expect(leg.ride.solver, leg.child.childKey).toBe("INFEASIBLE");
    }
    // Van 1 and Van 2 are nobody's warning: one row was written, about one van.
    expect(vanOnBoard(counted, "V1").setupState).toBe("DEFAULT");
    for (const vehicleKey of ["V1", "V2"]) {
      for (const leg of ridesOnVan(today, vehicleKey)) {
        expect(leg.ride.solver, leg.child.childKey).toBe("FEASIBLE");
      }
    }
  }, 60_000);

  /**
   * (c) THE TEST THAT FAILS IF EITHER SCREEN GOES BACK TO THE LAYOUTS.
   *
   * The stored counts are ones **no layout of Van 1 has**: eight seats where its largest seating
   * plan has six ambulatory places, five car seats where the most tether-capable of them has two,
   * and two oxygen mounts, which no layout anywhere models at all. Seven children are then saved
   * onto it — one more than any layout of that van holds — and both screens have to say it fits,
   * because that is what the front desk counted.
   *
   * Point either screen back at `standard.ts` and this goes red: the seat-level solver over
   * Van 1's layouts cannot seat seven, and it has never heard of an oxygen mount.
   */
  it("(c) both screens follow stored counts the seeded layouts do not have", async () => {
    const SEVEN = ["C1", "C3", "C4", "C5", "C7", "C8", "C9"];
    const vehicle = VEHICLES.find((v) => v.key === "V1");
    if (!vehicle) throw new Error("no seeded Van 1");
    const mostSeats = Math.max(
      ...vehicle.layouts.map((l) => l.positions.filter((p) => p.kind === "AMB").length),
    );
    const mostTethered = Math.max(
      ...vehicle.layouts.map(
        (l) => l.positions.filter((p) => p.kind === "AMB" && p.tetherCapable).length,
      ),
    );
    expect(mostSeats, "no layout of Van 1 seats these seven").toBeLessThan(SEVEN.length);
    expect(mostTethered, "nor holds their car seats").toBeLessThan(4);

    await countAtRamp("V1", { seats: 8, wheelchairSpots: 1, carSeats: 5, oxygenMounts: 2 });
    for (const [i, childKey] of SEVEN.entries()) await moveChild(childKey, "VAN", "V1", i);

    const counted = await boardView();
    const vanOne = vanOnBoard(counted, "V1");
    expect(vanOne.setup).toMatchObject({ seats: 8, carSeats: 5, oxygenMounts: 2 });
    const aboard = ridersInVan(counted.day, counted.plan, vanOne.id);
    expect(aboard, "all seven are on it").toHaveLength(SEVEN.length);
    expect(usedBy(aboard).carSeats, "four car seats, in the five counted").toBe(4);
    expect(isOver(vanOne.setup, aboard), "the board is content").toBe(false);

    const today = await todayBoard();
    expect(ridesOnVan(today, "V1"), "Today puts all seven on it too").toHaveLength(SEVEN.length);
    for (const leg of ridesOnVan(today, "V1")) {
      expect(leg.ride.solver, leg.child.childKey).toBe("FEASIBLE");
      expect(leg.needsActionReasons, leg.child.childKey).not.toContain("DOES_NOT_FIT");
    }
    expect(misfits(today), "and warns about nobody").toEqual([]);
  }, 60_000);
});
