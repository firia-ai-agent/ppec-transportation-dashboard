import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { VANS } from "@/config/vans";
import type { Db } from "@/db/exec";
import { autoPlan } from "@/domain/plan/board";
import { freshPlanDb, SITE } from "@/test/pglite";
import { vehicleIdOf } from "@/modules/demo/fixtures/standard";
import { seedStandardScenario } from "@/modules/demo/seed";
import { sqlDaySource } from "@/modules/roster/sql";
import { applyPendingMoves } from "./place";
import { loadBoard, savedPlacementsForBoard } from "./store";
import { sqlPlanStore } from "./sql";
import type { PlanStore } from "./types";

/**
 * Morning and afternoon are two plans (plan_run unique on site, service date and leg,
 * src/db/schema.ts plan_run_site_date_dir_uq). Saving one leg must never touch the other, and
 * each reloads as it was saved. Throwaway PGlite with every migration applied (src/test/pglite.ts).
 */

let db: Db;
let close: () => Promise<void>;
let store: PlanStore;

const NOW = new Date("2026-10-16T17:45:00.000Z");
const DATE = "2026-10-16";
const van = (i: number) => vehicleIdOf(VANS[i].vehicleKey);
const source = () => sqlDaySource(db, SITE);
const board = (leg: "AM" | "PM") => loadBoard(store, SITE, DATE, leg, source());

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
  await db.query("DELETE FROM ops.plan_assignment", []);
  await db.query("DELETE FROM ops.plan_run", []);
});

/** Auto-plan this leg, as the board does, and save every move it proposes. */
async function autoPlanAndSave(leg: "AM" | "PM", expectedVersion: number) {
  const view = await board(leg);
  const planned = autoPlan(view.day, view.plan);
  const moves = Object.entries(planned).map(([childToken, p]) => ({
    childToken,
    bucket: p.bucket,
    vanId: p.vanId,
  }));
  const written = await applyPendingMoves(
    { siteId: SITE, serviceDate: DATE, direction: leg, moves, expectedVersion, actor: null, now: NOW },
    store,
    source(),
  );
  expect(written.ok, `save ${leg}: ${JSON.stringify(written)}`).toBe(true);
  return planned;
}

const vansOf = (plan: Record<string, { vanId: string | null; bucket: string }>) =>
  Object.fromEntries(Object.entries(plan).map(([t, p]) => [t, `${p.bucket}:${p.vanId}`]));

describe("Morning and afternoon save and reload on their own", () => {
  it("save AM, save PM, reload: AM is unchanged and each leg has its own plan_run", async () => {
    expect((await board("AM")).started).toBe(true);
    await autoPlanAndSave("AM", 0);
    const amSaved = vansOf((await board("AM")).plan);

    // A different PM plan: Auto-plan, then move one PM rider to another van.
    await autoPlanAndSave("PM", 0);
    const pm = await board("PM");
    const rider = pm.day.riders.find((r) => pm.plan[r.token]?.bucket === "VAN" && !r.needs.wheelchair)!;
    const other = [van(0), van(1), van(2)].find((v) => v !== pm.plan[rider.token].vanId)!;
    const moved = await applyPendingMoves(
      { siteId: SITE, serviceDate: DATE, direction: "PM",
        moves: [{ childToken: rider.token, bucket: "VAN", vanId: other }],
        expectedVersion: pm.version, actor: null, now: NOW },
      store,
      source(),
    );
    expect(moved.ok).toBe(true);

    // Reload both legs from the database.
    const amAfter = await board("AM");
    const pmAfter = await board("PM");
    expect(vansOf(amAfter.plan)).toEqual(amSaved);
    expect(amAfter.version).toBe(1);
    expect(pmAfter.version).toBe(2);
    expect(pmAfter.plan[rider.token].vanId).toBe(other);

    const runs = await db.query<{ direction: string; version: number; n: number }>(
      `SELECT r.direction::text AS direction, r.version, count(a.*)::int AS n
         FROM ops.plan_run r LEFT JOIN ops.plan_assignment a ON a.plan_run_id = r.id
        GROUP BY r.id ORDER BY r.direction`,
      [],
    );
    expect(runs.rows.map((r) => [r.direction, Number(r.version)])).toEqual([["AM", 1], ["PM", 2]]);
    expect(runs.rows.every((r) => r.n > 0)).toBe(true);
  });

  it("a PM save with the AM version is its own leg: it does not 409 on, or bump, AM", async () => {
    await autoPlanAndSave("AM", 0);
    await autoPlanAndSave("PM", 0); // version 0 for PM even though AM is at 1
    expect((await board("AM")).version).toBe(1);
    expect((await board("PM")).version).toBe(1);
  });

  it("Today's reader returns each leg's own saved plan, and leaves out an unsaved leg", async () => {
    await autoPlanAndSave("AM", 0);
    const onlyAm = await savedPlacementsForBoard(SITE, DATE, store, source());
    expect(Object.keys(onlyAm)).toEqual(["AM"]);
    await autoPlanAndSave("PM", 0);
    const both = await savedPlacementsForBoard(SITE, DATE, store, source());
    expect(Object.keys(both).sort()).toEqual(["AM", "PM"]);
    expect(both.AM).toEqual(onlyAm.AM);
  });
});
