import { afterEach, describe, expect, it } from "vitest";
import { vanConfigOf, vanNameOf } from "@/config/vans";
import { buildBoard, demoDay, type Board } from "@/domain/board/board";
import { ridersInVan } from "@/domain/plan/board";
import { driverFor } from "@/domain/plan/day";
import { demoDaySource } from "@/modules/demo/day-source";
import {
  DEMO_SITE_ID,
  childTokenOf,
  vehicleIdOf,
  vehicleKeyOfId,
} from "@/modules/demo/fixtures/standard";
import { kidsInVan, loadSavedPlan, vansInPlan } from "@/modules/live-map/plan-read";
import { clearMemoryPlanStore, memoryPlanStore } from "@/modules/plan/memory";
import { applyPendingMoves, setChildPlacement } from "@/modules/plan/place";
import {
  loadBoard,
  savedPlacementsForBoard,
  savedSpotsFrom,
} from "@/modules/plan/store";
import {
  AUTO_PLANNED_VANS,
  MOVED_CHILD,
  MOVED_FROM,
  MOVED_TO,
  REFERENCE_MORNING,
  VERI_FIVE,
} from "@/test/reference-plan";
import { shortName } from "@/ui/display-name";

/**
 * TODAY READS THE SAVED PLAN — end to end, through the save path Plan routes uses.
 *
 * SOURCE: Veri's GET-only prod check on a34ce49. The director saved the morning plan — nine of
 * nine placed, Liam D. moved from Van 1 to Van 2 — and Today's morning van column disagreed with
 * the board it was saved on for **five of nine children**: Ava N. on Van 3 against the board's
 * Van 1, Eli N. Van 3 against Van 2, Ivy H. Van 1 against Van 2, Owen C. Van 1 against Van 3,
 * Theo V. Van 2 against Van 3. Today computed the van from the demo scenario's own runs; the
 * plan was in `ops.plan_run` / `ops.plan_assignment` and nothing on that screen read it.
 *
 * So this file does the whole round trip rather than asserting about a shape:
 *
 *  1. a plan is **saved through the real writer** — `applyPendingMoves` and `setChildPlacement`
 *     (src/modules/plan/place.ts), the same two functions the board's Save and a drag go
 *     through, with the server's own fit re-check and version bump;
 *  2. it is read back through **`loadBoard`** (src/modules/plan/store.ts), the one read path, the
 *     same call the Plan routes page makes;
 *  3. Today's rows are built from it, and the three screens are compared child by child.
 *
 * It runs on the memory store and the synthetic day — the store a server with no `DATABASE_URL`
 * gets (src/modules/plan/memory.ts) — so the whole walk is one process and no migration. What
 * the memory store cannot prove is the SQL, and the SQL is proved directly against the real
 * migrations elsewhere (src/modules/plan/sql.test.ts, place.db.test.ts); the ids this file joins
 * on are the fixtures' own deterministic formula, which is the one the seed inserts with.
 *
 * Reproducing the day exactly, rather than trusting Auto-plan to land on it: the morning is
 * Firia's own prod re-save of 2026-10-18 5:09 AM ET, written down once in
 * src/test/reference-plan.ts and mirrored by the seeded-database half of this file's story
 * (./saved-plan.db.test.ts).
 */

const SITE = DEMO_SITE_ID;
const DATE = "2026-10-18";
const NOW = new Date("2026-10-18T11:30:00.000Z");

/** The store a server with no database gets, asked for with no database in so many words. */
const store = () => memoryPlanStore({});
const source = () => demoDaySource();

const token = (childKey: string) => childTokenOf(childKey);
const vanId = (vehicleKey: string) => vehicleIdOf(vehicleKey);
/** The number painted on this van's door, from the one fleet config (§1.5). */
const slotOf = (vehicleKey: string): number => {
  const config = vanConfigOf(vehicleKey);
  if (!config) throw new Error(`no van config for ${vehicleKey}`);
  return config.slot;
};

const moves = () =>
  Object.entries(AUTO_PLANNED_VANS).flatMap(([vehicleKey, childKeys]) =>
    childKeys.map((childKey) => ({
      childToken: token(childKey),
      bucket: "VAN" as const,
      vanId: vanId(vehicleKey),
    })),
  );

/** Save the auto-planned morning, exactly as the board's Save does: every move, one version. */
async function saveTheMorning(): Promise<void> {
  const written = await applyPendingMoves(
    {
      siteId: SITE,
      serviceDate: DATE,
      direction: "AM",
      moves: moves(),
      expectedVersion: 0,
      actor: null,
      now: NOW,
    },
    store(),
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
      direction: "AM",
      childToken: token(childKey),
      bucket,
      vehicleId: vehicleKey === null ? null : vanId(vehicleKey),
      expectedVersion,
      actor: null,
      now: NOW,
    },
    store(),
    source(),
  );
  expect(moved.ok, "reason" in moved ? moved.reason : "moved").toBe(true);
}

/** Today, built the way the page builds it: the saved plan, read through `loadBoard`. */
async function todayBoard(): Promise<Board> {
  return buildBoard(demoDay(), await savedPlacementsForBoard(SITE, DATE, store(), source()));
}

/** The van number Today's morning row shows for a child, or null when it shows no van. */
const vanNumberOf = (board: Board, childKey: string): number | null => {
  const leg = board.legs.find((l) => l.child.childKey === childKey && l.ride.direction === "AM");
  if (!leg) throw new Error(`no morning row for ${childKey}`);
  return leg.ride.vanNumber;
};

const morningRow = (board: Board, childKey: string) => {
  const leg = board.legs.find((l) => l.child.childKey === childKey && l.ride.direction === "AM");
  if (!leg) throw new Error(`no morning row for ${childKey}`);
  return leg;
};

afterEach(() => {
  clearMemoryPlanStore();
});

describe("a plan saved on the board is the plan Today shows", () => {
  /**
   * **The bug, as one child.** Liam D. is moved from Van 1 to Van 2, which is the move Veri's
   * director made, and Today's morning row follows him both times.
   *
   * The first half is what makes this a test of the fix rather than of the fixture: Liam D. is
   * *seeded* on Van 2 (standard.ts `RUNS`, R2), so a board that ignores the saved plan shows
   * Van 2 whatever the plan says. On Van 1 — where the plan put him — the two answers differ,
   * and that is the assertion the mutation of this fix fails.
   */
  it("follows one child's move from Van 1 to Van 2 (Liam D.)", async () => {
    await saveTheMorning();

    const planned = await todayBoard();
    const before = morningRow(planned, MOVED_CHILD);
    expect(before.ride.vanNumber).toBe(slotOf(MOVED_FROM));
    expect(before.ride.vehicleLabel).toBe(vanNameOf(slotOf(MOVED_FROM)));
    expect(before.ride.driverName).toBe(shortName(driverFor(MOVED_FROM)));

    await moveChild(MOVED_CHILD, "VAN", MOVED_TO, 1);

    const moved = await todayBoard();
    const after = morningRow(moved, MOVED_CHILD);
    expect(after.ride.vanNumber).toBe(slotOf(MOVED_TO));
    expect(after.ride.vehicleLabel).toBe(vanNameOf(slotOf(MOVED_TO)));
    expect(after.ride.driverName).toBe(shortName(driverFor(MOVED_TO)));
  });

  /**
   * **The five children Veri found, and the four around them.** One saved plan, three screens:
   * the plan board (`loadBoard`), Today (`buildBoard` over the same read) and the Live map (its
   * own reader of the same two tables). They agree for all nine, or this test says which one
   * does not.
   */
  it("agrees with the board and the live map for all nine children", async () => {
    await saveTheMorning();
    await moveChild(MOVED_CHILD, "VAN", MOVED_TO, 1);

    const board = await loadBoard(store(), SITE, DATE, "AM", source());
    const today = await todayBoard();
    const live = await loadSavedPlan(SITE, DATE, "AM");
    expect(live).not.toBeNull();

    for (const [childKey, vehicleKey] of Object.entries(REFERENCE_MORNING)) {
      const where = `${childKey} → ${vehicleKey}`;
      // The board: the plan as the screen it was saved on reads it.
      expect(board.plan[token(childKey)], where).toMatchObject({
        bucket: "VAN",
        vanId: vanId(vehicleKey),
      });
      // Today: the van number on the morning row, which is what Veri compared.
      const slot = slotOf(vehicleKey);
      expect(vanNumberOf(today, childKey), where).toBe(slot);
      expect(morningRow(today, childKey).ride.vehicleLabel, where).toBe(vanNameOf(slot));
      // The live map: the same child in the same van, through its own read of the same rows.
      expect(live?.placements[token(childKey)]?.vanId, where).toBe(vanId(vehicleKey));
    }

    // Veri's five, named, against the vans her check found on Today — every one of which was the
    // seeded run and none of which was the saved plan.
    for (const [childKey, vehicleKey] of Object.entries(VERI_FIVE)) {
      expect(vanNumberOf(today, childKey), childKey).toBe(slotOf(vehicleKey));
    }

    // And the counts the three screens would each put on a van: 2, 4, 3.
    for (const vehicleKey of ["V1", "V2", "V3"]) {
      const onBoard = ridersInVan(board.day, board.plan, vanId(vehicleKey)).length;
      const onToday = today.legs.filter(
        (leg) => leg.ride.direction === "AM" && leg.ride.vanNumber === slotOf(vehicleKey),
      ).length;
      expect(onToday, vehicleKey).toBe(onBoard);
      expect(kidsInVan(live, vehicleKey), vehicleKey).toBe(onBoard);
    }
    expect(vansInPlan(live).sort()).toEqual([vanId("V1"), vanId("V2"), vanId("V3")].sort());
  });

  /**
   * The three places that are not a van. A plan is a record of a decision, and "nobody has given
   * her a van yet", "her family drives her today" and "she is not here today" are three
   * different decisions — none of which may show as the van the scenario seeded her on.
   */
  it("shows unassigned, family drives and away today as themselves, and on no van", async () => {
    await saveTheMorning();
    let version = 1;
    for (const bucket of ["UNASSIGNED", "FAMILY_DRIVES", "ABSENT"] as const) {
      // Ivy H. is seeded on Van 1, so "no van" is a different answer from the fixture's.
      await moveChild("C8", bucket, null, version);
      version += 1;

      const leg = morningRow(await todayBoard(), "C8");
      expect(leg.ride.vehicleLabel, bucket).toBeNull();
      expect(leg.ride.vanNumber, bucket).toBeNull();
      expect(leg.ride.driverName, bucket).toBeNull();

      if (bucket === "UNASSIGNED") {
        expect(leg.ride.mode, bucket).not.toBe("FAMILY");
        expect(leg.nextStep, bucket).toBe("FIND_VAN");
      }
      if (bucket === "FAMILY_DRIVES") {
        expect(leg.ride.mode, bucket).toBe("FAMILY");
        expect(leg.group, bucket).toBe("NOT_RIDING");
      }
      if (bucket === "ABSENT") {
        expect(leg.ride.state, bucket).toBe("CANCELED_ATTENDANCE");
        expect(leg.group, bucket).toBe("NOT_RIDING");
        expect(leg.nextStep, bucket).toBe("NOTHING");
      }
      // Nobody is in a van they are not in, on any of the three screens.
      expect(kidsInVan(await loadSavedPlan(SITE, DATE, "AM"), "V1"), bucket).toBe(
        ridersInVan(
          (await loadBoard(store(), SITE, DATE, "AM", source())).day,
          (await loadBoard(store(), SITE, DATE, "AM", source())).plan,
          vanId("V1"),
        ).length,
      );
    }
  });

  /** A plan is per date **and** per leg: a saved morning says nothing about the afternoon. */
  it("leaves the afternoon's rows exactly as the seeded day has them", async () => {
    await saveTheMorning();
    await moveChild(MOVED_CHILD, "VAN", MOVED_TO, 1);

    const saved = await savedPlacementsForBoard(SITE, DATE, store(), source());
    expect(saved.AM).toBeDefined();
    expect(saved.PM, "nothing has been saved for the afternoon").toBeUndefined();

    const today = buildBoard(demoDay(), saved);
    const seeded = buildBoard(demoDay());
    /*
     * The afternoon *rides*, and what each row makes of them. Not the whole `LegRow`: a row
     * carries the child's own day — both of their rides — so the morning that did change is
     * reachable from an afternoon row, and comparing rows whole would be comparing the morning
     * again under another name.
     */
    const afternoon = (of: Board) =>
      of.legs
        .filter((l) => l.ride.direction === "PM")
        .map((l) => ({
          key: l.key,
          ride: l.ride,
          group: l.group,
          needsActionReasons: l.needsActionReasons,
          nextStep: l.nextStep,
        }));
    expect(afternoon(today)).toEqual(afternoon(seeded));
  });

  /**
   * **Nothing saved is the seeded day, to the row.** The fallback is not a second code path: it
   * is the same `buildBoard` with nothing handed to it, which is what every other board test in
   * the repo asserts against.
   */
  it("is the seeded board when no plan has been saved for the date", async () => {
    expect(await savedPlacementsForBoard(SITE, DATE, store(), source())).toEqual({});
    expect(await todayBoard()).toEqual(buildBoard(demoDay()));
    // …and for a session with no site at all, which is the browser check's caller (§9.4).
    expect(await savedPlacementsForBoard(null, DATE, store(), source())).toEqual({});
  });

  /**
   * The ids, both ways, through the fixtures' one formula. A second formula here is what showed
   * every van the next van's children (Veri S1, 2026-10-18 3:03 AM ET).
   */
  it("joins the saved rows to the board on the fixtures' own ids", async () => {
    await saveTheMorning();
    const board = await loadBoard(store(), SITE, DATE, "AM", source());
    const spots = savedSpotsFrom(board.plan);

    expect(spots[MOVED_CHILD]).toEqual({ bucket: "VAN", vehicleKey: MOVED_FROM });
    expect(vehicleKeyOfId(vanId(MOVED_FROM))).toBe(MOVED_FROM);
    // Every child of the day is in the plan, and every one of them under a key this board has.
    for (const [childKey, spot] of Object.entries(spots)) {
      expect(token(childKey), childKey).toBeTruthy();
      if (spot.bucket === "VAN") expect(vanId(spot.vehicleKey), childKey).toBeTruthy();
    }
  });
});
