/**
 * THE SAVED PLAN IS THE ONE SOURCE, AND THE LIVE MAP ONLY READS IT.
 *
 * Layer 2 (behaviour), per /workspace/ppec-redesign/MOCKUP-TEST-CONTRACT.md: the rule decides,
 * not the mockup, and every assertion names the rule it is holding.
 *
 * The rules:
 *  - **docs/DATA-MODEL.md, "One source for the plan"** — `ops.plan_run` + `ops.plan_assignment`
 *    are where a saved board lives, and every screen that wants to know who rides where reads
 *    those two tables rather than keeping an answer of its own. The Live map is a reader.
 *  - **REDESIGN-SPEC §9.1** — "Plan saved → Live map" is a **hard** gate: "No saved plan = no
 *    routes". §9.5 says what that looks like: the centre pin and a "No routes yet" card over the
 *    map, never a blank map.
 *  - **Firia's rule 4, 2026-10-17 5:48 PM ET** — the in-memory store is never selectable while a
 *    database is configured. It fails closed, because a plan served out of one serverless
 *    instance's memory is invisible to the next request (the exact fault #58's plan-store had).
 *  - **Firia's goal-5 brief** — this screen is read-only: no save path, no writes to the preview
 *    database.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEMO_ACCOUNTS } from "@/auth/demo-accounts";
import { demoId, KIND, VEHICLES } from "@/modules/demo/fixtures/standard";
import { DEFAULT_DEMO_SITE } from "@/modules/demo/seed";
import { clearSavedPlans, putSavedPlan } from "@/modules/demo/plan-store";
import {
  assertMemoryAllowed,
  demoVehicleId,
  hasNoDatabase,
  isUnlocked,
  kidsInVan,
  kidsPerVan,
  loadSavedPlan,
  MEMORY_STORE_REFUSED,
  siteOf,
  type SavedPlan,
} from "./plan-read";

const VAN_1 = demoId(KIND.vehicle, VEHICLES.findIndex((v) => v.key === "V1"));
const VAN_2 = demoId(KIND.vehicle, VEHICLES.findIndex((v) => v.key === "V2"));

function planWith(
  placements: SavedPlan["placements"],
  savedBy: string | null = null,
): SavedPlan {
  return { version: 1, savedAt: "2026-10-17T20:41:00.000Z", savedBy, placements };
}

describe("locked until a plan is saved (REDESIGN-SPEC §9.1, the hard gate)", () => {
  it("is locked when nothing is saved for this date and leg", () => {
    expect(isUnlocked(null)).toBe(false);
  });

  it("unlocks the moment a plan_run exists", () => {
    expect(isUnlocked(planWith({}))).toBe(true);
  });

  /*
   * The gate is the `plan_run` row, not the assignments on it. A plan that puts every child in
   * "away today" is still a day a coordinator decided and saved, and the map is theirs to watch.
   */
  it("unlocks on an empty saved plan too: the run is the decision, not its rows", () => {
    const plan = planWith({ C1: { bucket: "ABSENT", vanId: null, stopSeq: null } });
    expect(isUnlocked(plan)).toBe(true);
    expect(kidsPerVan(plan)).toEqual({});
  });
});

describe("reading plan_assignment (DATA-MODEL.md, \"One source for the plan\")", () => {
  it("counts the children the plan puts in each van, by vehicle id", () => {
    const plan = planWith({
      C1: { bucket: "VAN", vanId: VAN_1, stopSeq: 1 },
      C2: { bucket: "VAN", vanId: VAN_1, stopSeq: 2 },
      C3: { bucket: "VAN", vanId: VAN_2, stopSeq: 1 },
    });
    expect(kidsPerVan(plan)).toEqual({ [VAN_1]: 2, [VAN_2]: 1 });
  });

  /*
   * The three buckets that are not a van are not in anybody's van. A child whose family drives
   * them, one nobody has placed yet and one who is away today are each a real decision, and none
   * of them is a seat on a run.
   */
  it("counts only the VAN bucket: unassigned, family-drives and away are nobody's riders", () => {
    const plan = planWith({
      C1: { bucket: "VAN", vanId: VAN_1, stopSeq: 1 },
      C2: { bucket: "UNASSIGNED", vanId: null, stopSeq: null },
      C3: { bucket: "FAMILY_DRIVES", vanId: null, stopSeq: null },
      C4: { bucket: "ABSENT", vanId: null, stopSeq: null },
    });
    expect(kidsPerVan(plan)).toEqual({ [VAN_1]: 1 });
  });

  it("says nothing rather than zero when no plan is saved", () => {
    expect(kidsPerVan(null)).toEqual({});
    expect(kidsInVan(null, "V1")).toBeNull();
  });

  /* The join between the saved plan's `ops.vehicle.id` and the simulated run's own van key. */
  it("maps a fixture van key onto the id the seed wrote, and rejects one it does not have", () => {
    expect(demoVehicleId("V1")).toBe(VAN_1);
    expect(demoVehicleId("V99")).toBeNull();
    expect(kidsInVan(planWith({ C1: { bucket: "VAN", vanId: VAN_1, stopSeq: 1 } }), "V1")).toBe(1);
  });

  it("says 0 for a van the saved plan puts nobody in — which is a fact, not a missing answer", () => {
    expect(kidsInVan(planWith({ C1: { bucket: "VAN", vanId: VAN_1, stopSeq: 1 } }), "V2")).toBe(0);
  });
});

describe("the memory store fails closed (Firia's rule 4, 5:48 PM ET)", () => {
  it("refuses outright when a database URL is configured", () => {
    expect(() => assertMemoryAllowed({ DATABASE_URL: "postgres://x" })).toThrow(
      MEMORY_STORE_REFUSED,
    );
  });

  it("allows it only when there is no database at all", () => {
    expect(() => assertMemoryAllowed({})).not.toThrow();
    expect(hasNoDatabase({})).toBe(true);
    expect(hasNoDatabase({ DATABASE_URL: "postgres://x" })).toBe(false);
  });

  /* The check is the URL's presence, never a flag somebody can set to get the old behaviour. */
  it("has no override: a flag does not buy the memory store back", () => {
    expect(() =>
      assertMemoryAllowed({ DATABASE_URL: "postgres://x", DEMO_MODE: "1", ALLOW_MEMORY: "1" }),
    ).toThrow(MEMORY_STORE_REFUSED);
  });
});

describe("read-only: this screen never writes the plan (Firia's goal-5 brief)", () => {
  const source = readFileSync(path.join(__dirname, "plan-read.ts"), "utf8");
  // Comments say "no INSERT here"; the rule is about statements, so they are stripped first.
  const statements = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

  it.each(["INSERT", "UPDATE", "DELETE", "TRUNCATE", "UPSERT", "ON CONFLICT"])(
    "contains no %s",
    (verb) => {
      expect(statements.toUpperCase()).not.toContain(verb);
    },
  );

  it("touches only the two plan tables, and only to select from them", () => {
    const froms = [...statements.matchAll(/FROM\s+(ops\.[a-z_]+)/g)].map((m) => m[1]);
    expect([...new Set(froms)].sort()).toEqual(["ops.plan_assignment", "ops.plan_run"]);
  });

  /*
   * And every statement is parameterised and site-scoped. A reader is still a query somebody can
   * aim at another centre's day if the site is not in the WHERE clause.
   */
  it("scopes the plan_run lookup to one site, with parameters and never interpolation", () => {
    expect(statements).toContain("WHERE site_id = $1");
    expect(statements).not.toMatch(/\$\{/);
  });
});

describe("which site a caller's plan belongs to", () => {
  it("is their own membership when they have one", () => {
    expect(siteOf({ memberships: [{ siteId: "site-a" }, { siteId: "site-b" }] })).toBe("site-a");
  });

  /* The browser check's synthetic session is a role and no identity, so it has no membership. */
  it("falls back to the one demo centre for a session with no membership (PRD §18.1)", () => {
    expect(siteOf({})).toBe(DEFAULT_DEMO_SITE);
  });
});

describe("who saved it, in the words a screen may print", () => {
  /* src/modules/plan/staff.ts is #73's file, byte-identical: one name rule for the whole app. */
  it("turns a user id into the frame's own short name, and null into null", async () => {
    const { staffLabel } = await import("@/modules/plan/staff");
    expect(staffLabel(null)).toBeNull();
    expect(staffLabel("nobody")).toBeNull();
    const account = DEMO_ACCOUNTS[0];
    expect(staffLabel(account.id)).toMatch(/^\S+( [A-Z]\.)?$/);
  });
});

/**
 * THE GATE ON A SERVER WITH NO DATABASE.
 *
 * The browser check builds the app and starts it with no `DATABASE_URL` at all
 * (playwright.config.ts: "The run touches no database"). The §9.1 gate has to mean the same
 * thing there as on a deployment, or the Live map is a screen nobody can ever walk past its
 * locked state — so it reads what IS the saved plan on that server: the one the Plan routes
 * board kept when somebody pressed Save (src/modules/demo/plan-store.ts).
 *
 * A real save by a real click, never a fixture standing in for one. These tests say both halves:
 * nothing saved is locked, and a save unlocks.
 */
describe("with no database, the board's own saved plan is the gate", () => {
  afterEach(() => clearSavedPlans());

  it("is locked when nobody has saved anything in this process", async () => {
    clearSavedPlans();
    expect(isUnlocked(await loadSavedPlan("site", "2026-10-17", "AM"))).toBe(false);
  });

  it("unlocks once a plan is saved, and reads its children into their vans", async () => {
    putSavedPlan({
      scenario: "EVERY_RIDER_FITS",
      direction: "AM",
      stages: { L1: { vehicleKey: "V1", arrival: "NOT_CHECKED" }, L2: { vehicleKey: "V2", arrival: "NOT_CHECKED" } },
      measured: [],
      assignment: { L1: ["C6", "C7"], L2: ["C2"] },
      savedAt: "2026-10-17T12:41:00.000Z",
    });
    const plan = await loadSavedPlan("site", "2026-10-17", "AM");
    expect(isUnlocked(plan)).toBe(true);
    expect(kidsInVan(plan, "V1")).toBe(2);
    expect(kidsInVan(plan, "V2")).toBe(1);
    expect(kidsInVan(plan, "V3")).toBe(0);
  });

  /* The leg is part of the gate (§9.1): a morning plan does not unlock the afternoon. */
  it("gates per leg: saving the morning leaves the afternoon locked", async () => {
    putSavedPlan({
      scenario: "EVERY_RIDER_FITS",
      direction: "AM",
      stages: { L1: { vehicleKey: "V1", arrival: "NOT_CHECKED" } },
      measured: [],
      assignment: { L1: ["C6"] },
      savedAt: "2026-10-17T12:41:00.000Z",
    });
    expect(isUnlocked(await loadSavedPlan("site", "2026-10-17", "AM"))).toBe(true);
    expect(isUnlocked(await loadSavedPlan("site", "2026-10-17", "PM"))).toBe(false);
  });

  /*
   * `plan_assignment` constrains "is in a van" and "names a van" to be the same thing. A lane
   * whose van the fixtures do not know must not become a child in a van called null.
   */
  it("keeps the table's own invariant when it cannot name the van", async () => {
    putSavedPlan({
      scenario: "EVERY_RIDER_FITS",
      direction: "PM",
      stages: { L1: { vehicleKey: "NOT-A-VAN", arrival: "NOT_CHECKED" } },
      measured: [],
      assignment: { L1: ["C6"] },
      savedAt: "2026-10-17T12:41:00.000Z",
    });
    const plan = await loadSavedPlan("site", "2026-10-17", "PM");
    expect(plan?.placements.C6).toEqual({ bucket: "UNASSIGNED", vanId: null, stopSeq: null });
    expect(kidsPerVan(plan)).toEqual({});
  });
});
