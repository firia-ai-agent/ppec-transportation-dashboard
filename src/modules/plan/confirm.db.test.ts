/**
 * **RAMP CONFIRM WRITES ONE TABLE** — "Firia ruling 9:45 PM ET".
 *
 * Confirm Van N on the ramp iPad writes `ops.vehicle_setup_day` and **nothing else**. The plan
 * is a coordinator's, not the ramp's: a van being counted may change what the board *says* about
 * a plan, and it may never change the plan itself. So this reads the two plan tables out in
 * full — `SELECT *`, ordered by their primary keys, serialised as JSON — before and after each
 * Confirm, and compares the two strings. A new `plan_run` version, a touched `updated_at`, a
 * re-ordered assignment: any of them is a different string and a failed test.
 *
 * All three roles confirm (REDESIGN-SPEC §2: counting what arrived is the front desk's own job),
 * so all three are walked here, each through the same guard the route takes
 * (`apiOutcome` + `putVanSetupRequest`, which is src/app/api/vans/[id]/setup/route.ts in two
 * lines). A caller with no role is a 403 that writes nothing at all — the setup table is dumped
 * for that one too, because "refused" has to mean no row appeared.
 *
 * On a **real** Postgres under `pnpm test:db` (TEST_DATABASE_URL, loopback only — src/test/pglite.ts
 * refuses any other host), and on PGlite otherwise, so the default suite runs it too.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { API, apiOutcome } from "@/auth/access";
import type { StaffRole } from "@/auth/core";
import { VANS } from "@/config/vans";
import type { Db } from "@/db/exec";
import { autoPlan } from "@/domain/plan/board";
import { freshPlanDb, SITE } from "@/test/pglite";
import { vehicleIdOf } from "@/modules/demo/fixtures/standard";
import { seedStandardScenario } from "@/modules/demo/seed";
import { sqlDaySource } from "@/modules/roster/sql";
import { putVanSetupRequest } from "./api";
import { applyPendingMoves } from "./place";
import { loadBoard } from "./store";
import { sqlPlanStore } from "./sql";
import type { PlanStore } from "./types";

const NOW = new Date("2026-10-16T17:45:00.000Z");
const DATE = "2026-10-16";
/** The counts a ramp would type in: one fewer seat than the van's default, and the rest as read. */
const COUNTED = {
  date: DATE,
  seats: 5,
  wheelchairSpots: 1,
  carSeats: 3,
  oxygenMounts: 1,
  hasLift: true,
  state: "CHECKED",
} as const;

/** One signed-in person per role, so `set_by` is a real user and not a null that hides a bug. */
const STAFF: Record<StaffRole, string> = {
  DIRECTOR: "01900000-0000-7000-8000-00000000a001",
  COORDINATOR: "01900000-0000-7000-8000-00000000a002",
  FRONT_DESK: "01900000-0000-7000-8000-00000000a003",
};

let db: Db;
let close: () => Promise<void>;
let store: PlanStore;

const source = () => sqlDaySource(db, SITE);
const board = () => loadBoard(store, SITE, DATE, "PM", source());

/** One table, every column, in primary-key order, as one string to compare. */
async function dump(table: "plan_run" | "plan_assignment" | "vehicle_setup_day"): Promise<string> {
  const order = {
    plan_run: "id",
    plan_assignment: "plan_run_id, child_token",
    vehicle_setup_day: "vehicle_id, service_date",
  }[table];
  const rows = await db.query<Record<string, unknown>>(
    `SELECT * FROM ops.${table} ORDER BY ${order}`,
    [],
  );
  return JSON.stringify(rows.rows);
}

type SetupBody = Parameters<typeof putVanSetupRequest>[3];

const confirm = (role: StaffRole, vanId: string, body: SetupBody = COUNTED) =>
  putVanSetupRequest(SITE, { userId: STAFF[role], role }, vanId, body, NOW, store);

const callerOf = (role: StaffRole) => ({ kind: "STAFF" as const, role, memberships: [] });

beforeAll(async () => {
  ({ db, close } = await freshPlanDb());
  await seedStandardScenario(db, {
    now: NOW,
    siteId: SITE,
    env: { APP_DATA_CLASS: "SYNTHETIC", DEMO_MODE: "1", HMAC_PEPPER: "p", DATA_KEY: "k" },
  });
  store = sqlPlanStore(db);
  for (const [role, id] of Object.entries(STAFF)) {
    await db.query(
      `INSERT INTO ops.app_user (id, email, display_name, password_hash)
       VALUES ($1, $2, $3, 'x') ON CONFLICT (id) DO NOTHING`,
      [id, `${role.toLowerCase()}@example.test`, role],
    );
  }

  // A plan to protect: the board's own Auto-plan, saved, so both plan tables have rows in them.
  const start = await board();
  expect(start.started, "the seeded scenario clock starts the day").toBe(true);
  const planned = autoPlan(start.day, start.plan);
  const saved = await applyPendingMoves(
    {
      siteId: SITE,
      serviceDate: DATE,
      direction: "PM",
      moves: Object.entries(planned)
        .filter(([, placement]) => placement.bucket === "VAN" && placement.vanId)
        .map(([childToken, placement]) => ({
          childToken,
          bucket: "VAN" as const,
          vanId: placement.vanId,
        })),
      expectedVersion: start.version,
      actor: null,
      now: NOW,
    },
    store,
    source(),
  );
  expect(saved.ok).toBe(true);
}, 180_000);

afterAll(async () => {
  await close();
});

describe("Confirm writes vehicle_setup_day and never the plan", () => {
  it("has a saved plan to protect in the first place", async () => {
    expect(JSON.parse(await dump("plan_run"))).toHaveLength(1);
    expect(JSON.parse(await dump("plan_assignment")).length).toBeGreaterThan(0);
  });

  it.each(["FRONT_DESK", "DIRECTOR", "COORDINATOR"] as const)(
    "%s confirms a van: CHECKED is written, and the plan rows are byte-identical",
    async (role) => {
      // The guard the route takes first: all three roles hold this endpoint's row (§2).
      expect(apiOutcome(callerOf(role), API.vanSetup)).toBe("ALLOW");

      const vanId = vehicleIdOf(VANS[["FRONT_DESK", "DIRECTOR", "COORDINATOR"].indexOf(role)].vehicleKey);
      const runsBefore = await dump("plan_run");
      const assignmentsBefore = await dump("plan_assignment");

      const answer = await confirm(role, vanId);
      expect(answer.status).toBe(200);

      // The one row it is allowed to write, with this person's name on it.
      const setup = await db.query<{ state: string; seats: number; set_by: string | null }>(
        `SELECT state, seats, set_by::text FROM ops.vehicle_setup_day
          WHERE vehicle_id = $1 AND service_date = $2::date`,
        [vanId, DATE],
      );
      expect(setup.rows).toEqual([{ state: "CHECKED", seats: COUNTED.seats, set_by: STAFF[role] }]);

      // And the plan, in full, exactly as it was.
      expect(await dump("plan_run")).toBe(runsBefore);
      expect(await dump("plan_assignment")).toBe(assignmentsBefore);
    },
  );

  it("leaves the plan untouched across all three confirms together", async () => {
    const runs = JSON.parse(await dump("plan_run")) as { version: number }[];
    expect(runs).toHaveLength(1);
    // Still the one version the save wrote: no confirm bumped it.
    expect(Number(runs[0].version)).toBe(1);
    // Three vans counted, one row each, and no fourth row from anywhere.
    const setups = JSON.parse(await dump("vehicle_setup_day")) as unknown[];
    expect(setups).toHaveLength(3);
  });

  /**
   * A signed-in caller with no role is a 403 at the guard, and a staff caller asking for a state
   * nobody may write is a 403 in the module (Firia's rule 1: `CHECKED` is the only state anything
   * writes). Either way the three tables are the same strings afterwards — a refusal is not a
   * write, not even of the row it was refused for.
   */
  it("refuses any other caller with a 403, and writes nothing at all", async () => {
    const before = {
      runs: await dump("plan_run"),
      assignments: await dump("plan_assignment"),
      setups: await dump("vehicle_setup_day"),
    };

    expect(apiOutcome({ kind: "NO_ROLE", userId: STAFF.DIRECTOR }, API.vanSetup)).toBe("FORBIDDEN");
    expect(apiOutcome({ kind: "ANONYMOUS" }, API.vanSetup)).toBe("UNAUTHENTICATED");

    // The states that are nobody's to write, asked for by a role that may confirm.
    for (const state of ["PLANNED", "DEFAULT"] as const) {
      const refused = await confirm("DIRECTOR", vehicleIdOf(VANS[0].vehicleKey), {
        ...COUNTED,
        state,
      });
      expect(refused).toEqual({ status: 403, body: { ok: false, reason: "NOT_A_STATE" } });
    }

    expect(await dump("plan_run")).toBe(before.runs);
    expect(await dump("plan_assignment")).toBe(before.assignments);
    expect(await dump("vehicle_setup_day")).toBe(before.setups);
  });
});
