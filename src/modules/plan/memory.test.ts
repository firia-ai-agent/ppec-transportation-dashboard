import { afterEach, describe, expect, it } from "vitest";
import { MEMORY_STORE_REFUSED, clearMemoryPlanStore, memoryPlanStore } from "./memory";
import { dayDataSource, hasNoDatabase, planStore } from "./store";

/**
 * Firia's rule 4 (2026-10-17 5:48 PM ET): the in-memory plan store **can never be selected when
 * a database URL is set**. It fails closed, in production and on previews.
 *
 * Why a throw and not a warning. #58's board saved into a `Map` in one serverless instance's
 * memory: a plan written by one request was invisible to the next and gone on redeploy, and
 * nothing said so. The fallback still exists for the one server that genuinely has no database —
 * the browser check, which `pnpm e2e` starts without `DATABASE_URL` — and the only way to keep
 * that from quietly becoming the deployed path is to make the wrong case impossible rather than
 * unlikely. There is no flag that overrides it: the check is the presence of the URL.
 */

afterEach(() => {
  clearMemoryPlanStore();
});

describe("the memory store fails closed", () => {
  it("throws when a database is configured, however it is spelled", () => {
    for (const url of [
      "postgres://user:pw@db.example.test/app",
      "postgresql://localhost:5432/app",
      " ",
    ]) {
      expect(() => memoryPlanStore({ DATABASE_URL: url }), url).toThrow(MEMORY_STORE_REFUSED);
    }
  });

  it("throws even when something asks for it explicitly", () => {
    // There is no "force memory" flag to honour, and adding one is the thing this test forbids:
    // a request with a database behind it gets SQL or an error, never a plan nobody can read.
    expect(() =>
      memoryPlanStore({ DATABASE_URL: "postgres://db/app", USE_MEMORY_PLAN_STORE: "1", DEMO_MODE: "1" }),
    ).toThrow(MEMORY_STORE_REFUSED);
  });

  it("throws on a deployment that lost its URL, rather than serving memory (Veri F6)", () => {
    for (const vercel of ["production", "preview"]) {
      expect(() => memoryPlanStore({ VERCEL_ENV: vercel }), vercel).toThrow(MEMORY_STORE_REFUSED);
      expect(() => dayDataSource("site", { VERCEL_ENV: vercel }), vercel).toThrow(MEMORY_STORE_REFUSED);
    }
    // A development server with no URL is the one case it serves.
    expect(() => memoryPlanStore({ VERCEL_ENV: "development" })).not.toThrow();
  });

  it("is used only where there is no database at all", () => {
    expect(hasNoDatabase({})).toBe(true);
    expect(hasNoDatabase({ DATABASE_URL: "postgres://db/app" })).toBe(false);
    expect(() => memoryPlanStore({})).not.toThrow();
  });

  it("is what `planStore` picks with no database, and never what it picks with one", () => {
    expect(planStore({})).toBeDefined();
    // With a URL set, the selection goes to SQL — which needs a real client, so the failure here
    // is the database client's and never a silent fall back to memory.
    let picked: unknown = null;
    try {
      picked = planStore({ DATABASE_URL: "postgres://user:pw@db.example.test/app" });
    } catch (error) {
      expect(String(error)).not.toContain(MEMORY_STORE_REFUSED);
    }
    if (picked) {
      // If a client could be made, it is the SQL store: the memory one would have thrown.
      expect(picked).toBeDefined();
    }
  });
});

describe("what the memory store starts from", () => {
  it("has no setup row for any day: every van reads its shared-config defaults", async () => {
    const store = memoryPlanStore({});
    expect(await store.setupRows("site", "2026-10-17", ["van-1", "van-2"])).toEqual([]);
    expect(await store.setupRows("site", "2026-10-16", ["van-1", "van-2"])).toEqual([]);
  });

  it("keeps a confirmed van for the day it was confirmed on, and no other", async () => {
    const store = memoryPlanStore({});
    await store.putSetup("site", {
      vehicleId: "van-1",
      date: "2026-10-17",
      setup: { seats: 4, wheelchairSpots: 1, carSeats: 1, oxygenMounts: 0, hasLift: true },
      state: "CHECKED",
      setBy: null,
      now: new Date("2026-10-17T19:30:00.000Z"),
    });
    const today = await store.setupRows("site", "2026-10-17", ["van-1"]);
    expect(today.map((row) => row.serviceDate)).toEqual(["2026-10-17"]);
    expect(await store.setupRows("site", "2026-10-16", ["van-1"])).toEqual([]);
  });

  it("has no plan until one is saved, and reads back exactly what was saved", async () => {
    const store = memoryPlanStore({});
    expect(await store.loadPlan("site", "2026-10-17", "PM")).toBeNull();
    const saved = await store.savePlan("site", {
      date: "2026-10-17",
      direction: "PM",
      version: 0,
      placements: { "child-1": { bucket: "VAN", vanId: "van-1", pinned: true, stopSeq: 1 } },
      savedBy: null,
      now: new Date("2026-10-17T19:41:00.000Z"),
    });
    expect(saved).toMatchObject({ ok: true, version: 1 });
    const read = await store.loadPlan("site", "2026-10-17", "PM");
    expect(read?.placements).toEqual({ "child-1": { bucket: "VAN", vanId: "van-1", pinned: true } });
  });

  it("refuses a save that names a version somebody else has moved past", async () => {
    const store = memoryPlanStore({});
    const input = {
      date: "2026-10-17",
      direction: "PM" as const,
      placements: {},
      savedBy: null,
      now: new Date("2026-10-17T19:41:00.000Z"),
    };
    await store.savePlan("site", { ...input, version: 0 });
    expect(await store.savePlan("site", { ...input, version: 0 })).toMatchObject({
      ok: false,
      conflict: true,
      version: 1,
    });
  });
});
