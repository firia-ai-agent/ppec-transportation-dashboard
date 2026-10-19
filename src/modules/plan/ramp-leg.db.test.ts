import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@/db/exec";
import { autoPlan } from "@/domain/plan/board";
import { arrivalVans } from "@/app/ramp-ipad/arrival/view";
import { childTokenOf, vehicleIdOf } from "@/modules/demo/fixtures/standard";
import { seedStandardScenario } from "@/modules/demo/seed";
import { sqlDaySource } from "@/modules/roster/sql";
import { freshPlanDb, SITE } from "@/test/pglite";
import { REFERENCE_VANS } from "@/test/reference-plan";
import { applyPendingMoves } from "./place";
import { loadBoard } from "./store";
import { sqlPlanStore } from "./sql";
import { resolveLeg } from "./when";
import type { PlanStore } from "./types";

/**
 * THE RAMP READS THE SAVED PLAN, FOR THE LEG THE ADDRESS NAMES.
 *
 * The bug this file is about: /ramp-ipad loaded the board with a constant `"PM"`
 * (src/app/ramp-ipad/arrival/when.ts `RAMP_DIRECTION`, now deleted) and never looked at `?leg=`,
 * even though the board's own Ramp links pass one. So a front desk who followed the morning
 * board's link to Van 1 was shown the **afternoon's** riders — Ava N., Liam D. and Zoe B. —
 * while the morning plan the director had just saved has Liam D. on Van 2.
 *
 * It is proved here, against a database, because that is where a plan is: the 5:09 AM ET
 * reference morning (src/test/reference-plan.ts) saved through the board's own writer
 * (`applyPendingMoves`), then read back the way the page composes it — `resolveLeg` on the
 * address, `loadBoard` for that leg, `arrivalVans` over what came out. PGlite with every
 * migration in `drizzle/` applied (src/test/pglite.ts); no shared database is touched.
 *
 * `./legs.db.test.ts` is the other half: that the two legs are two plan runs and save
 * independently of each other.
 */

let db: Db;
let close: () => Promise<void>;
let store: PlanStore;

const NOW = new Date("2026-10-16T17:45:00.000Z");
const DATE = "2026-10-16";

const source = () => sqlDaySource(db, SITE);
const token = (childKey: string) => childTokenOf(childKey);
const vanId = (vehicleKey: string) => vehicleIdOf(vehicleKey);

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
  // Every test starts from the day a reset leaves behind: no plan at all, on either leg.
  await db.query("DELETE FROM ops.plan_assignment", []);
  await db.query("DELETE FROM ops.plan_run", []);
});

/**
 * The ramp screen, composed exactly as src/app/ramp-ipad/page.tsx composes it: the leg out of
 * the address, the board for that leg, and the vans the arrival view draws.
 */
async function ramp(legParam: string | undefined) {
  const leg = resolveLeg(legParam);
  const view = await loadBoard(store, SITE, DATE, leg, source());
  return {
    leg,
    savedAt: view.savedAt,
    vans: arrivalVans(view.day, view.plan, view.departs),
  };
}

/** Child token → the name on screen, per van, keyed by the number on the van's door. */
function ridersBySlot(vans: Awaited<ReturnType<typeof ramp>>["vans"]): Record<number, string[]> {
  return Object.fromEntries(
    vans.map((arrival) => [arrival.van.slot, arrival.riders.map((rider) => rider.token).sort()]),
  );
}

/** Save a whole leg the way the board's Save does: every placement, one version. */
async function save(
  leg: "AM" | "PM",
  byVan: Readonly<Record<string, readonly string[]>>,
  expectedVersion = 0,
) {
  const written = await applyPendingMoves(
    {
      siteId: SITE,
      serviceDate: DATE,
      direction: leg,
      moves: Object.entries(byVan).flatMap(([vehicleKey, childKeys]) =>
        childKeys.map((childKey) => ({
          childToken: token(childKey),
          bucket: "VAN" as const,
          vanId: vanId(vehicleKey),
        })),
      ),
      expectedVersion,
      actor: null,
      now: NOW,
    },
    store,
    source(),
  );
  expect(written.ok, `save ${leg}: ${JSON.stringify(written)}`).toBe(true);
}

describe("the ramp's riders are the saved plan's riders", () => {
  it("lists Firia's 5:09 morning van by van, with Liam D. on Van 2 and not on Van 1", async () => {
    await save("AM", REFERENCE_VANS);

    const screen = await ramp("am");
    expect(screen.savedAt).not.toBeNull();
    expect(ridersBySlot(screen.vans)).toEqual({
      1: REFERENCE_VANS.V1.map(token).sort(),
      2: REFERENCE_VANS.V2.map(token).sort(),
      3: REFERENCE_VANS.V3.map(token).sort(),
    });

    // The one drag the reference morning is about, said in the direction the bug was read in.
    const liam = token("C3");
    const onVan = (slot: number) =>
      screen.vans.find((arrival) => arrival.van.slot === slot)!.riders.map((r) => r.token);
    expect(onVan(2)).toContain(liam);
    expect(onVan(1)).not.toContain(liam);
  });
});

describe("two legs saved, and the address picks between them", () => {
  /**
   * Two different mornings and afternoons: the morning is the reference plan, the afternoon is
   * Auto-plan's own answer for the afternoon roster. They are different sets of children, so a
   * screen reading the wrong one cannot accidentally be right.
   */
  async function saveBothLegs(): Promise<{ am: Record<number, string[]>; pm: Record<number, string[]> }> {
    await save("AM", REFERENCE_VANS);

    const pmView = await loadBoard(store, SITE, DATE, "PM", source());
    const planned = autoPlan(pmView.day, pmView.plan);
    const written = await applyPendingMoves(
      {
        siteId: SITE,
        serviceDate: DATE,
        direction: "PM",
        moves: Object.entries(planned).map(([childToken, placement]) => ({
          childToken,
          bucket: placement.bucket,
          vanId: placement.vanId,
        })),
        expectedVersion: 0,
        actor: null,
        now: NOW,
      },
      store,
      source(),
    );
    expect(written.ok, `save PM: ${JSON.stringify(written)}`).toBe(true);

    return {
      am: ridersBySlot((await ramp("am")).vans),
      pm: ridersBySlot((await ramp("pm")).vans),
    };
  }

  it("shows the morning for ?leg=am and the afternoon for ?leg=pm", async () => {
    const { am, pm } = await saveBothLegs();
    expect(am).not.toEqual(pm);

    expect(ridersBySlot((await ramp("am")).vans)).toEqual(am);
    expect(ridersBySlot((await ramp("pm")).vans)).toEqual(pm);
  });

  it("shows the morning when the address names no leg at all", async () => {
    const { am } = await saveBothLegs();
    const noParam = await ramp(undefined);
    expect(noParam.leg).toBe("AM");
    expect(ridersBySlot(noParam.vans)).toEqual(am);
  });
});

describe("a leg with nothing saved", () => {
  it("has no saved plan and no riders — the ramp invents none", async () => {
    await save("AM", REFERENCE_VANS);

    const afternoon = await ramp("pm");
    expect(afternoon.savedAt).toBeNull();
    expect(afternoon.vans).toHaveLength(3);
    expect(afternoon.vans.flatMap((arrival) => arrival.riders)).toEqual([]);
  });
});
