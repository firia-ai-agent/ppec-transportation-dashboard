/**
 * **Firia's gap-5 ruling, wired: an approved change or cancel saves a new plan version through the
 * board's own writer** — and if that writer refuses, the whole decision rolls back.
 *
 * This file runs the real `setChildPlacement` (`@/modules/plan/place.ts`) against the real
 * migrations on PGlite, over the seeded standard scenario, because the thing being proved is
 * *rows*: a fake that records its arguments can only show that this module called something.
 *
 *  1. **a change** — the time or the stop moves, the child rides the van they already rode — saves
 *     a new `plan_run` version with the child's `plan_assignment` row still in that van;
 *  2. **a cancel** puts the child in bucket `ABSENT` for that leg, in `plan_assignment`, through
 *     the same exported function the board uses and not a bucket writer of this module's own;
 *  3. **a refusal from the board** (a plan somebody else saved first; a day nobody started; a
 *     writer that throws) leaves the proposal **PENDING**, the ride where it was, and **nothing**
 *     in the outbox: the coordinator reads "Couldn't update the plan" and the family is told
 *     nothing. Never a fake success, and never a text about a change the plan does not hold.
 *
 * The last suite is the rule about *where absence is read*: `plan_assignment`, and nowhere else.
 * `attendance_day` keeps its own record — the front desk's actual-attendance row is a different
 * fact, recorded by a different person — but no screen reads absence from it, and that is a grep
 * rather than a behaviour because it is a rule about the whole tree.
 *
 * Sources: Firia's gap-5 ruling (2026-10-17) and docs/DATA-MODEL.md §9.1 (`plan_run`,
 * `plan_assignment`, one writer) — the same contract `src/modules/plan/place.db.test.ts` holds
 * from the board's side.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { uuidv7 } from "uuidv7";
import { VANS } from "@/config/vans";
import type { Db } from "@/db/exec";
import { DROPOFF_CHANGE_KIND } from "@/modules/agent/run/exec/proposals";
import { decideApproval } from "@/modules/approvals/decide";
import {
  boardPlacementPort,
  type PlanPlacementPortFor,
  type SetChildPlacementInput,
} from "@/modules/approvals/plan-placement-port";
import { childTokenOf, demoLegId, vehicleIdOf } from "@/modules/demo/fixtures/standard";
import { seedStandardScenario } from "@/modules/demo/seed";
import { setChildPlacement } from "@/modules/plan/place";
import { sqlPlanStore, sqlPlanStoreIn } from "@/modules/plan/sql";
import { loadBoard } from "@/modules/plan/store";
import { sqlDaySource } from "@/modules/roster/sql";
import { FakeOutboxTransport } from "@/modules/outbox/transport";
import { seedStaff } from "@/test/messaging";
import { freshPlanDb, SITE } from "@/test/pglite";

/** A file's code with its comments stripped, so a sentence about a write is not read as one. */
function code(file: string): string {
  return readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/(^|\s)\/\/.*$/, "$1"))
    .join("\n");
}

/** The seeded scenario's own day: the clock starts it, which is what the board requires. */
const NOW = new Date("2026-10-16T17:45:00.000Z");
const SERVICE_DATE = "2026-10-16";
/** Theo V. (C8) rides the afternoon and needs nothing, so he fits in any van. */
const CHILD_KEY = "C8";
const childToken = () => childTokenOf(CHILD_KEY);
const legId = () => demoLegId(CHILD_KEY, "PM");
const vanOne = () => vehicleIdOf(VANS[0].vehicleKey);

let db: Db;
let close: () => Promise<void>;
let coordinator: string;
let transport: FakeOutboxTransport;

/**
 * The real board, over the decision's own transaction: the writer the plan-routes board uses,
 * reading and writing where the rest of the decision does (`sqlPlanStoreIn`).
 */
const board = (): PlanPlacementPortFor =>
  boardPlacementPort({
    store: (tx) => sqlPlanStoreIn(tx),
    source: (tx, siteId) => sqlDaySource(tx, siteId),
  });

const view = (direction: "AM" | "PM" = "PM") =>
  loadBoard(sqlPlanStore(db), SITE, SERVICE_DATE, direction, sqlDaySource(db, SITE));

beforeAll(async () => {
  ({ db, close } = await freshPlanDb());
  await seedStandardScenario(db, {
    now: NOW,
    siteId: SITE,
    env: { APP_DATA_CLASS: "SYNTHETIC", DEMO_MODE: "1", HMAC_PEPPER: "p", DATA_KEY: "k" },
  });
  coordinator = await seedStaff(db, "COORDINATOR", SITE);
}, 180_000);

afterAll(async () => {
  await close();
});

beforeEach(async () => {
  transport = new FakeOutboxTransport();
  // Each test starts from no plan and no decision, which is what a demo reset leaves behind.
  await db.query("DELETE FROM ops.plan_assignment", []);
  await db.query("DELETE FROM ops.plan_run", []);
  await db.query("DELETE FROM ops.outbound_message", []);
  await db.query("DELETE FROM ops.approval_request", []);
  await db.query("DELETE FROM ops.task", []);
  await db.query("UPDATE ops.trip_leg SET plan_version = 1 WHERE id = $1", [legId()]);
}, 60_000);

/**
 * A saved plan with this child in Van 1, as a coordinator's Save leaves it.
 *
 * Through the board's own writer, so the starting state of every test below is one the board
 * itself could have produced — a plan hand-written in SQL here could be a plan the board would
 * never save. Answers the version it left behind.
 */
async function savedPlanWithChildInVanOne(): Promise<number> {
  const before = await view();
  expect(before.started, "the seeded scenario clock starts this day").toBe(true);
  const saved = await setChildPlacement(
    {
      siteId: SITE,
      serviceDate: SERVICE_DATE,
      direction: "PM",
      childToken: childToken(),
      bucket: "VAN",
      vehicleId: vanOne(),
      expectedVersion: before.version,
      // `plan_run.saved_by` is an `app_user` id or null; the demo seed writes null.
      actor: null,
      now: NOW,
    },
    sqlPlanStore(db),
    sqlDaySource(db, SITE),
  );
  expect(saved.ok, JSON.stringify(saved)).toBe(true);
  return saved.ok ? saved.version : 0;
}

/** One undecided proposal. `cancel` makes it the cancel flavour rather than a time change. */
async function seedProposal(over: { cancel?: boolean } = {}): Promise<string> {
  const taskId = uuidv7();
  await db.query(
    `INSERT INTO ops.task (id, site_id, category, severity, state, summary, next_step, completion_predicate,
       created_by, updated_by, source_mode)
     VALUES ($1, $2, 'PLAN_CHANGE', 'AMBER', 'OPEN', 'A family asked for a different drop-off',
       'Read the text, then decide', 'the drop-off approved or declined', 'test', 'test', 'SIMULATED')`,
    [taskId, SITE],
  );
  const id = uuidv7();
  await db.query(
    `INSERT INTO ops.approval_request (id, site_id, task_id, proposal, created_by, updated_by, source_mode)
     VALUES ($1, $2, $3, $4::jsonb, 'test', 'test', 'SIMULATED')`,
    [
      id,
      SITE,
      taskId,
      JSON.stringify({
        kind: DROPOFF_CHANGE_KIND,
        leg_id: legId(),
        child_token: childToken(),
        service_date: SERVICE_DATE,
        direction: "PM",
        plan_version_basis: 1,
        requested_dropoff_time: over.cancel ? null : "17:00",
        ...(over.cancel ? { cancel: true } : {}),
        stop_token: "OKEE-PARK",
        rationale_code: "PARENT_REQUEST",
        template_id: over.cancel ? "leg.canceled" : "dropoff.changed",
        vars: over.cancel
          ? { legDate: SERVICE_DATE, reasonCode: "FAMILY_REQUEST" }
          : { legDate: SERVICE_DATE, eta: "17:00", stopLabel: "OKEE-PARK" },
        approval_key: "a-key",
      }),
    ],
  );
  return id;
}

const approve = (approvalId: string, placement: PlanPlacementPortFor) =>
  decideApproval(
    db,
    transport,
    { userId: coordinator, approvalId, decision: "APPROVED", now: NOW },
    { placement },
  );

const decisionOf = async (id: string) =>
  (
    await db.query<{ decision: string | null; decided_at: Date | null }>(
      "SELECT decision, decided_at FROM ops.approval_request WHERE id = $1",
      [id],
    )
  ).rows[0];

const outbox = async () =>
  (await db.query<{ id: string }>("SELECT id FROM ops.outbound_message", [])).rows;

const legVersion = async () =>
  (await db.query<{ plan_version: number }>("SELECT plan_version FROM ops.trip_leg WHERE id = $1", [legId()]))
    .rows[0].plan_version;

/** The child's own `plan_assignment` row for a leg, straight out of the table. */
const assignmentRow = async (direction = "PM") =>
  (
    await db.query<{ bucket: string; vehicle_id: string | null; direction: string }>(
      `SELECT a.bucket, a.vehicle_id, r.direction
       FROM ops.plan_assignment a JOIN ops.plan_run r ON r.id = a.plan_run_id
       WHERE a.child_token = $1 AND r.service_date = $2 AND r.direction = $3`,
      [childToken(), SERVICE_DATE, direction],
    )
  ).rows[0] ?? null;

const planRunVersion = async (direction = "PM") =>
  (
    await db.query<{ version: number }>(
      "SELECT version FROM ops.plan_run WHERE site_id = $1 AND service_date = $2 AND direction = $3",
      [SITE, SERVICE_DATE, direction],
    )
  ).rows[0]?.version ?? null;

describe("an approved change saves a new plan version, through the board's own writer", () => {
  it("bumps plan_run.version and leaves the child in the van they already rode", async () => {
    const started = await savedPlanWithChildInVanOne();
    const id = await seedProposal();

    const answer = await approve(id, board());
    expect(answer, JSON.stringify(answer)).toMatchObject({ status: 200 });

    // DATA-MODEL §9.1: a plan write is a new version of `plan_run`, never an edit in place.
    expect(await planRunVersion()).toBe(started + 1);
    // Nothing re-seated: a drop-off change moves the time, not the child ("Same van", the card's
    // own check chip in mockups/approvals.html `.checks`).
    expect(await assignmentRow()).toMatchObject({ bucket: "VAN", vehicle_id: vanOne(), direction: "PM" });
  });

  it("moves the ride too, to the version after the one the proposal was computed against", async () => {
    await savedPlanWithChildInVanOne();
    const id = await seedProposal();
    await approve(id, board());
    expect(await legVersion()).toBe(2);
  });

  it("and texts the family, once the plan holds the change", async () => {
    await savedPlanWithChildInVanOne();
    const id = await seedProposal();
    const answer = await approve(id, board());
    expect(answer.status).toBe(200);
    expect(answer.body.ok && answer.body.queued).toBeGreaterThan(0);
    expect((await outbox()).length).toBeGreaterThan(0);
  });
});

describe("an approved cancel puts the child in ABSENT for that leg, in plan_assignment", () => {
  it("writes bucket ABSENT with no van, through the same exported function", async () => {
    await savedPlanWithChildInVanOne();
    const id = await seedProposal({ cancel: true });

    expect((await approve(id, board())).status).toBe(200);

    // Firia, 7:17 PM ET: away is a placement on this day's plan, per leg, with no vehicle.
    expect(await assignmentRow()).toMatchObject({ bucket: "ABSENT", vehicle_id: null, direction: "PM" });
  });

  it("leaves the other leg's plan alone: a cancel is one leg, not a day", async () => {
    await savedPlanWithChildInVanOne();
    const id = await seedProposal({ cancel: true });
    await approve(id, board());
    // The morning was never planned here, so there is no AM run to have been touched.
    expect(await planRunVersion("AM")).toBeNull();
  });

  it("writes no bucket itself: there is no plan table in this module's own SQL", () => {
    // Comments stripped: prose about updating the plan is not a query (as in `no-network.test.ts`).
    expect(code(path.join(__dirname, "decide.ts"))).not.toMatch(/plan_assignment|plan_run/i);
    // And the port holds no SQL of its own to drift from the board's.
    expect(code(path.join(__dirname, "plan-placement-port.ts"))).not.toMatch(/\bINSERT\b|\bUPDATE\b|\.query\(/i);
  });

  it("is the board's function and not a copy of it", () => {
    // The port imports `setChildPlacement` from the board's module. A second implementation here
    // is exactly how two code paths end up disagreeing about what a plan version means.
    expect(code(path.join(__dirname, "plan-placement-port.ts"))).toMatch(
      /import \{[\s\S]*setChildPlacement as boardSetChildPlacement[\s\S]*\} from "@\/modules\/plan\/place"/,
    );
  });
});

describe("when the plan cannot be saved, the approval fails safe", () => {
  it("refuses a plan somebody else saved first, and claims nothing", async () => {
    const started = await savedPlanWithChildInVanOne();
    const id = await seedProposal();

    /*
     * The board's own 409: this port reads the plan, then somebody saves before the write lands.
     * `currentPlacement` answers the version it read, and the write is guarded on it.
     */
    const stale: PlanPlacementPortFor = (tx) => ({
      currentPlacement: async (query) => {
        const current = await board()(tx).currentPlacement(query);
        // Somebody else's Save, landing between this decision's read and its write. It takes the
        // version `currentPlacement` just answered, so the write below is guarded on a version
        // the plan no longer has — the board's own 409, not a fake of one.
        await setChildPlacement(
          { ...elsewhere(), expectedVersion: started, now: NOW },
          sqlPlanStoreIn(tx),
          sqlDaySource(tx, SITE),
        );
        return current;
      },
      setChildPlacement: board()(tx).setChildPlacement,
    });

    expect(await approve(id, stale)).toEqual({
      status: 503,
      body: { ok: false, error: "PLAN_NOT_SAVED" },
    });
    expect(await decisionOf(id)).toEqual({ decision: null, decided_at: null });
    expect(await legVersion()).toBe(1);
    expect(await outbox()).toEqual([]);
    expect(transport.sent).toEqual([]);
  });

  it("refuses a day nobody has started: the board has no plan to write", async () => {
    const id = await seedProposal();
    // No plan saved and the proposal names a date this scenario's clock has not started.
    const unstarted: PlanPlacementPortFor = (tx) => ({
      currentPlacement: async () => ({ bucket: "VAN", vehicleId: vanOne(), version: 0 }),
      setChildPlacement: (input) =>
        board()(tx).setChildPlacement({ ...input, serviceDate: "2026-11-30" }),
    });
    expect((await approve(id, unstarted)).status).toBe(503);
    expect(await decisionOf(id)).toEqual({ decision: null, decided_at: null });
    expect(await outbox()).toEqual([]);
  });

  it("refuses a writer that throws, and still sends the family nothing", async () => {
    await savedPlanWithChildInVanOne();
    const id = await seedProposal();
    const broken: PlanPlacementPortFor = (tx) => ({
      currentPlacement: board()(tx).currentPlacement,
      setChildPlacement: async () => {
        throw new Error("the board is unreachable");
      },
    });
    // A throw is not a refusal with a reason, so it is not dressed up as one: it surfaces, and
    // the transaction it was inside rolls back with it.
    await expect(approve(id, broken)).rejects.toThrow();
    expect(await decisionOf(id)).toEqual({ decision: null, decided_at: null });
    expect(await legVersion()).toBe(1);
    expect(await outbox()).toEqual([]);
    expect(transport.sent).toEqual([]);
  });

  it("refuses a child this day's plan does not have", async () => {
    await savedPlanWithChildInVanOne();
    const id = await seedProposal();
    const nobody: PlanPlacementPortFor = (tx) => ({
      currentPlacement: async () => null,
      setChildPlacement: board()(tx).setChildPlacement,
    });
    expect((await approve(id, nobody)).status).toBe(503);
    expect(await decisionOf(id)).toEqual({ decision: null, decided_at: null });
    expect(await outbox()).toEqual([]);
  });

  it("is production's own wiring: the call site passes no writer of its own", () => {
    const action = readFileSync(
      path.join(__dirname, "..", "..", "app", "(app)", "family-texts", "actions.ts"),
      "utf8",
    );
    // No `{ placement: ... }` at the call site: `decideApproval`'s default is the real board, so
    // there is one writer and the screen cannot pass a different one.
    expect(code(path.join(__dirname, "..", "..", "app", "(app)", "family-texts", "actions.ts")))
      .not.toMatch(/placement:/);
    expect(action).toMatch(/decideApproval\(/);
  });
});

/** A different child's placement: somebody else's Save, for the conflict above. */
function elsewhere(): SetChildPlacementInput {
  return {
    siteId: SITE,
    serviceDate: SERVICE_DATE,
    direction: "PM",
    childToken: childTokenOf("C2"),
    bucket: "VAN",
    vehicleId: vanOne(),
    expectedVersion: 0,
    actor: null,
  };
}

describe("absence is read from plan_assignment and from nowhere else", () => {
  const SRC = path.join(__dirname, "..", "..");

  function walk(dir: string): string[] {
    return readdirSync(dir).flatMap((entry) => {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) return walk(full);
      return /\.(ts|tsx)$/.test(full) && !/\.test\.tsx?$/.test(full) ? [full] : [];
    });
  }

  it("has no screen that reads attendance_day", () => {
    const screens = walk(path.join(SRC, "app")).concat(walk(path.join(SRC, "ui")));
    const offenders = screens.filter((f) => /attendance_day/i.test(readFileSync(f, "utf8")));
    expect(offenders.map((f) => path.relative(SRC, f))).toEqual([]);
  });

  it("and the record itself is still kept, by the module that owns it", () => {
    // Not a screen: somewhere under `modules/` or `domain/` writes it, which is the point — the
    // row survives, nothing renders from it.
    const owners = walk(path.join(SRC, "modules"))
      .concat(walk(path.join(SRC, "domain")))
      .filter((f) => /attendance_day/i.test(readFileSync(f, "utf8")));
    expect(owners.length).toBeGreaterThan(0);
  });
});
