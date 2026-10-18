/**
 * **Two coordinators saving at the same instant, on a real Postgres.**
 *
 * Lifted from Veri's own two-connection race (2026-10-17 11:05 PM ET, Athena's ask) and kept as
 * a test this branch runs: `pnpm test:db` with `TEST_DATABASE_URL` pointed at the throwaway
 * local Postgres. PGlite cannot prove any of this — it is one process with one connection, so
 * two "concurrent" saves are simply two sequential ones — which is why the whole file skips
 * itself when the URL is absent rather than passing on an engine that cannot lose the race.
 *
 * What it proves, 25 rounds at a time (Firia's option A; DATA-MODEL §1 `plan_run.version`):
 *  - two sessions holding version N: exactly one commits and the other is a 409 CHANGED;
 *  - the day ends at version N + 1, never N + 2 and never two runs;
 *  - the rows are the winner's moves only, and the loser's child is left where they were;
 *  - the **first** save of a day, where two sessions both hold version 0 and no `plan_run` row
 *    exists yet, is the same 409 — not a duplicate-key error surfacing as a 503 (S2 F1);
 *  - nobody reading the board while a save is in flight ever sees a bumped version with the
 *    assignments missing, which is the half-written plan the transaction exists to prevent.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { VANS } from "@/config/vans";
import type { Db } from "@/db/exec";
import { freshPlanDb, LOCAL_DB_URL, SITE } from "@/test/pglite";
import { vehicleIdOf } from "@/modules/demo/fixtures/standard";
import { seedStandardScenario } from "@/modules/demo/seed";
import { sqlDaySource } from "@/modules/roster/sql";
import { applyPendingMoves } from "./place";
import { loadBoard } from "./store";
import { sqlPlanStore } from "./sql";
import type { PlanStore } from "./types";

const NOW = new Date("2026-10-16T17:45:00.000Z");
const DATE = "2026-10-16";
/** Enough rounds that a lost race shows up every run, not once a week. */
const ROUNDS = 25;

let db: Db;
let close: () => Promise<void>;
let store: PlanStore;
let engine = "";

const source = () => sqlDaySource(db, SITE);
const board = () => loadBoard(store, SITE, DATE, "PM", source());
type Move = { childToken: string; bucket: "VAN"; vanId: string };
const save = (moves: Move[], version: number) =>
  applyPendingMoves(
    { siteId: SITE, serviceDate: DATE, direction: "PM", moves, expectedVersion: version, actor: null, now: NOW },
    store,
    source(),
  );

async function clearPlan(): Promise<void> {
  await db.query("DELETE FROM ops.plan_assignment", []);
  await db.query("DELETE FROM ops.plan_run", []);
}

describe.skipIf(!LOCAL_DB_URL)("two sessions, one plan, a real Postgres", () => {
  beforeAll(async () => {
    ({ db, close, engine } = await freshPlanDb());
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

  beforeEach(clearPlan);

  it("runs on a real local Postgres, not on PGlite", () => {
    expect(LOCAL_DB_URL).toBeTruthy();
    expect(engine).toBe("postgres");
  });

  it("two sessions at version N: exactly one commits, the other 409s, rows are the winner's", async () => {
    const vanOne = vehicleIdOf(VANS[0].vehicleKey);
    const vanTwo = vehicleIdOf(VANS[1].vehicleKey);
    const riders = (await board()).day.riders.filter((r) => !r.needs.wheelchair && !r.needs.oxygen);
    expect(riders.length).toBeGreaterThanOrEqual(4);
    const tally = { a: 0, b: 0 };

    for (let round = 0; round < ROUNDS; round += 1) {
      await clearPlan();
      const base = await save([{ childToken: riders[0].token, bucket: "VAN", vanId: vanOne }], 0);
      expect(base.ok).toBe(true);
      const n = (await board()).version;

      const a: Move[] = [
        { childToken: riders[1].token, bucket: "VAN", vanId: vanOne },
        { childToken: riders[2].token, bucket: "VAN", vanId: vanOne },
      ];
      const b: Move[] = [
        { childToken: riders[1].token, bucket: "VAN", vanId: vanTwo },
        { childToken: riders[3].token, bucket: "VAN", vanId: vanTwo },
      ];
      const [ra, rb] = await Promise.all([save(a, n), save(b, n)]);

      expect([ra, rb].filter((r) => r.ok)).toHaveLength(1);
      const lost = [ra, rb].find((r) => !r.ok);
      expect(lost).toMatchObject({ ok: false, status: 409, reason: "CHANGED" });

      const winner = ra.ok ? a : b;
      const loser = ra.ok ? b : a;
      if (ra.ok) tally.a += 1;
      else tally.b += 1;

      // One run for the day, one version on, whoever won.
      const runs = await db.query<{ version: number }>(
        "SELECT version FROM ops.plan_run WHERE site_id = $1 AND service_date = $2::date AND direction = 'PM'",
        [SITE, DATE],
      );
      expect(runs.rows.map((r) => Number(r.version))).toEqual([n + 1]);

      // The rows are the winner's moves, and nothing of the loser's got in with them.
      const after = await board();
      for (const move of winner) {
        expect(after.plan[move.childToken]).toMatchObject({ bucket: "VAN", vanId: move.vanId });
      }
      const loserOnly = loser.find((m) => !winner.some((w) => w.childToken === m.childToken));
      expect(loserOnly).toBeDefined();
      expect(after.plan[loserOnly!.childToken]?.bucket).not.toBe("VAN");
      // And the move both of them were building on is still there.
      expect(after.plan[riders[0].token]).toMatchObject({ bucket: "VAN", vanId: vanOne });
    }
    // Printed, not asserted: which session wins is the database's business, not a rule.
    console.log("RACE tally (A wins, B wins):", JSON.stringify(tally));
  }, 180_000);

  it("the first save of a day, raced at version 0, is a 409 and never a duplicate-key error", async () => {
    const vanOne = vehicleIdOf(VANS[0].vehicleKey);
    const vanTwo = vehicleIdOf(VANS[1].vehicleKey);
    const riders = (await board()).day.riders.filter((r) => !r.needs.wheelchair && !r.needs.oxygen);

    for (let round = 0; round < ROUNDS; round += 1) {
      await clearPlan();
      const settled = await Promise.allSettled([
        save([{ childToken: riders[1].token, bucket: "VAN", vanId: vanOne }], 0),
        save([{ childToken: riders[1].token, bucket: "VAN", vanId: vanTwo }], 0),
      ]);

      // Nothing throws: a lost first save is an answer, not an exception the route turns into 503.
      const thrown = settled.filter((r) => r.status === "rejected");
      expect(thrown.map((r) => String((r as PromiseRejectedResult).reason))).toEqual([]);
      const answers = settled.map((r) => (r as PromiseFulfilledResult<Awaited<ReturnType<typeof save>>>).value);
      expect(answers.filter((r) => r.ok)).toHaveLength(1);
      expect(answers.find((r) => !r.ok)).toMatchObject({ ok: false, status: 409, reason: "CHANGED" });

      const runs = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM ops.plan_run", []);
      expect(Number(runs.rows[0].n)).toBe(1);
      expect((await board()).version).toBe(1);
    }
  }, 180_000);

  it("a board read during a save never sees a version with its plan missing", async () => {
    const vanOne = vehicleIdOf(VANS[0].vehicleKey);
    const vanTwo = vehicleIdOf(VANS[1].vehicleKey);
    const riders = (await board()).day.riders.filter((r) => !r.needs.wheelchair && !r.needs.oxygen);
    await clearPlan();
    await save(
      [
        { childToken: riders[0].token, bucket: "VAN", vanId: vanOne },
        { childToken: riders[1].token, bucket: "VAN", vanId: vanOne },
      ],
      0,
    );

    /*
     * A save rewrites the day's assignments — delete, then insert. Inside one transaction a
     * reader sees the plan before or after, never the gap between the two statements; without
     * it, a reader lands on a run whose children have been deleted and not yet written back.
     */
    let reads = 0;
    let torn = 0;
    let saving = true;
    const reader = (async () => {
      while (saving) {
        const run = await db.query<{ id: string; version: number }>(
          "SELECT id::text AS id, version FROM ops.plan_run WHERE site_id = $1 AND service_date = $2::date AND direction = 'PM'",
          [SITE, DATE],
        );
        const row = run.rows[0];
        if (row) {
          const rows = await db.query<{ n: number }>(
            "SELECT count(*)::int AS n FROM ops.plan_assignment WHERE plan_run_id = $1",
            [row.id],
          );
          reads += 1;
          if (Number(rows.rows[0].n) === 0) torn += 1;
        }
      }
    })();

    for (let round = 0; round < ROUNDS; round += 1) {
      const version = (await board()).version;
      const target = round % 2 === 0 ? vanTwo : vanOne;
      const done = await save(
        [
          { childToken: riders[0].token, bucket: "VAN", vanId: target },
          { childToken: riders[1].token, bucket: "VAN", vanId: target },
        ],
        version,
      );
      expect(done.ok).toBe(true);
    }
    saving = false;
    await reader;

    expect(reads).toBeGreaterThan(0);
    expect(torn, `${torn} of ${reads} reads saw a plan_run with no assignments`).toBe(0);
  }, 180_000);
});
