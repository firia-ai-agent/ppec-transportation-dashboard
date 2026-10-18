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
 *  3. **a refusal from the board** (a plan somebody else saved first *between this decision's read
 *     and its write*; a day nobody started; a writer that throws) leaves the proposal **PENDING**,
 *     the ride where it was, and **nothing** in the outbox: the coordinator reads "Couldn't update
 *     the plan" and the family is told nothing. Never a fake success, and never a text about a
 *     change the plan does not hold. A plan saved before the decision opens is *not* a refusal —
 *     Firia, PR #75: there is no check of the proposal's recorded basis.
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
import type { Db, Exec } from "@/db/exec";
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

/**
 * One undecided proposal. `cancel` makes it the cancel flavour rather than a stop change.
 *
 * `basis` is `plan_run.version` — the counter the board guards (0009), recorded on the row and
 * not checked by `decideApproval` (Firia, PR #75). It defaults to the version the plan actually
 * holds right now, which is what `propose_dropoff_change` records, so a test that does not care
 * about the basis never has to know the number.
 */
async function seedProposal(over: { cancel?: boolean; basis?: number } = {}): Promise<string> {
  const basis = over.basis ?? (await planRunVersion()) ?? 0;
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
        plan_run_version_basis: basis,
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

/** The whole leg row, so "untouched" is the whole row and not one column of it. */
const legRow = async () =>
  (
    await db.query<Record<string, unknown>>(
      "SELECT * FROM ops.trip_leg WHERE id = $1",
      [legId()],
    )
  ).rows[0];

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

  it("and writes nothing to ops.trip_leg: the board owns where a child is", async () => {
    /*
     * WHAT THIS TEST IS NOW, AND WHY IT CHANGED. There used to be an `UPDATE ops.trip_leg` in
     * `decide.ts` setting `window_start` **and** `plan_version`, and Firia's S1-3 (2026-10-17
     * 11:00 PM ET) took it out: it was a second writer of the plan and it guarded a different
     * counter from the board's (`trip_leg.plan_version` vs `plan_run.version`, Veri S1-3.2). This
     * test then held the leg row whole.
     *
     * Firia's 11:11 AM ET ruling of 2026-10-18 — "the plan must really change, not just the text"
     * — put the *time* back, and only the time. `plan_run` has no time column at all (0009), so
     * the agreed drop-off's one home in this schema is the leg's window; it is written by a named
     * function in the plan module through the port (`plan/leg-write.ts`), not by SQL here.
     *
     * So what this test holds is the part of S1-3 that still stands, which is the part that
     * mattered: **`plan_version` is not this decision's counter.** The outbox compares a queued
     * message's `plan_version_basis` to it at drain, so a bump here would cancel this decision's
     * own text. Where the child rides is still the board's alone — the leg's van and child columns
     * are untouched — and the full-row assertion lives next door for the one decision that writes
     * no time (`apply-dropoff.db.test.ts`, "Don't send changes nothing").
     */
    await savedPlanWithChildInVanOne();
    const before = await legRow();
    const id = await seedProposal();
    expect((await approve(id, board())).status).toBe(200);
    const after = await legRow();
    expect(after.plan_version).toBe(before.plan_version);
    expect(after.child_token).toBe(before.child_token);
    expect(after.vehicle_id).toBe(before.vehicle_id);
    expect(after.direction).toBe(before.direction);
    expect(after.service_date).toEqual(before.service_date);
    // The one column it does move, to the instant 17:00 at the centre falls on (EDT in October).
    // Asserted as the value and not as "different from before", because this file seeds once and
    // an earlier decision in it has already agreed the same time on the same leg.
    expect(new Date(after.window_start as string).toISOString()).toBe("2026-10-16T21:00:00.000Z");
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
    /*
     * Comments stripped: prose about updating the plan is not a query (as in `no-network.test.ts`).
     *
     * The tables are named the way the schema names them — `ops.plan_run`, `ops.plan_assignment`
     * — rather than by the bare word, because the proposal JSON now carries a field called
     * `plan_run_version_basis` (the version the board guards, S1-3) and a bare-word match would
     * read that as a table. Every query in this tree qualifies its schema, so this is the form
     * that catches a real one.
     */
    expect(code(path.join(__dirname, "decide.ts"))).not.toMatch(/\bops\.plan_(run|assignment)\b/i);
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

/**
 * A PLAN SAVED AFTER THE PROPOSAL IS STILL APPROVABLE — Firia, PR #75: no plan-version check in
 * `decideApproval`.
 *
 * The proposal records the version the plan held when it was written, and for a while this
 * decision compared that number to the plan's current version and 409'd on a mismatch. That rule
 * is gone. It made the ordinary sequence unapprovable: staff press Auto-plan and Save after the
 * day's proposals are drafted (the demo's own row is seeded with the basis of a day that has no
 * `plan_run` at all — `demo/approval-seed.ts:123`), so the one card the walked demo opens on died
 * of the very save the demo asks for.
 *
 * What guards the write instead is the write itself: `currentPlacement` reads the plan inside this
 * transaction and `setChildPlacement` is handed that version as `expectedVersion`, so a Save that
 * lands *between* the read and the write is still the board's own refusal — the suite below holds
 * that, and it is the race that can actually corrupt a plan. A proposal drafted earlier is simply
 * applied to the plan as it now is.
 */
describe("a plan saved after the proposal is still approvable (Firia, PR #75)", () => {
  it("applies the change on top of the newer version, and texts the family", async () => {
    const started = await savedPlanWithChildInVanOne();
    // The proposal is computed against the version the plan has now.
    const id = await seedProposal({ basis: started });

    // Somebody else's Save, landing before the coordinator presses Approve. A different child,
    // through the board's own writer, so the plan really is at `started + 1`.
    const saved = await setChildPlacement(
      { ...elsewhere(), expectedVersion: started, now: NOW },
      sqlPlanStore(db),
      sqlDaySource(db, SITE),
    );
    expect(saved.ok).toBe(true);
    expect(await planRunVersion()).toBe(started + 1);

    const answer = await approve(id, board());
    expect(answer, JSON.stringify(answer.body)).toMatchObject({ status: 200 });

    // Decided, and the board took one more version on top of the other Save's — not a version
    // written against the stale number the proposal carries.
    expect(await decisionOf(id)).toMatchObject({ decision: "APPROVED" });
    expect(await planRunVersion()).toBe(started + 2);
    expect(await assignmentRow()).toMatchObject({ bucket: "VAN", vehicle_id: vanOne() });
    // Still no second writer of the leg (S1-3), and the family was told.
    expect(await legVersion()).toBe(1);
    expect((await outbox()).length).toBeGreaterThan(0);
  });

  it("approves a proposal written before the rule, which carries no basis at all", async () => {
    // A row from before the `plan_run_version_basis` rename holds `plan_version_basis` (the leg's
    // counter) and no `plan_run_version_basis`. Nothing reads either one to decide, so it goes
    // through on the plan the board holds now.
    const started = await savedPlanWithChildInVanOne();
    const id = await seedProposal();
    await db.query(
      `UPDATE ops.approval_request
       SET proposal = (proposal - 'plan_run_version_basis') || '{"plan_version_basis": 1}'::jsonb
       WHERE id = $1`,
      [id],
    );
    expect((await approve(id, board())).status).toBe(200);
    expect(await decisionOf(id)).toMatchObject({ decision: "APPROVED" });
    expect(await planRunVersion()).toBe(started + 1);
    expect((await outbox()).length).toBeGreaterThan(0);
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
      setDropoffWindow: board()(tx).setDropoffWindow,
      recordReceiver: board()(tx).recordReceiver,
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
      setDropoffWindow: board()(tx).setDropoffWindow,
      recordReceiver: board()(tx).recordReceiver,
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
      setDropoffWindow: board()(tx).setDropoffWindow,
      recordReceiver: board()(tx).recordReceiver,
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
      setDropoffWindow: board()(tx).setDropoffWindow,
      recordReceiver: board()(tx).recordReceiver,
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

/* ─────────────────────── S1-3b: a later failure rolls the plan save back ─────────────────────── */

/**
 * **THE PLAN SAVE SUCCEEDS, THEN A LATER STEP OF THE APPROVAL TRANSACTION FAILS** — Veri, 3:19 AM
 * ET 2026-10-18, required for the merge gate.
 *
 * The suite above covers every way the *board* refuses: a plan somebody saved first, a day nobody
 * started, a writer that throws. All of them fail before anything is written, which is the easy
 * half. This is the hard half, and it is the one a reviewer cannot take on trust: `setChildPlacement`
 * has already written a new `plan_run` and its `plan_assignment` rows when something *after* it
 * goes wrong. If that write were not a step of the same transaction — a store bound to the pool
 * instead of to `tx`, an `enqueue(db)` instead of `enqueue(tx)` — the plan would keep a version
 * nobody approved, and the proposal would still read PENDING on the screen. A coordinator would
 * then approve it again, against a plan that had already moved: either a second change on top of a
 * phantom first one, or a 409 for a reason they cannot see.
 *
 * Two injection points, one for each thing that happens after the save (decide.ts step 3):
 *
 *  a. the **leg lookup** — the `SELECT … FROM ops.trip_leg` that reads `plan_version` for the
 *     message's staleness basis;
 *  b. the **enqueue** of the family's text, failed at the `DRAFTED → … → QUEUED` transition, so
 *     the outbound row has already been INSERTed when it breaks. That is deliberate: a failure
 *     *before* the insert would roll back to the same place whether or not the insert was
 *     transactional, and would prove nothing.
 *
 * The injection is a wrapper around `Db` (`dbFailingAt`) and not an edit to `decide.ts`: the code
 * under test is the shipped code, and what is substituted is the database's answer to one
 * statement. Both the transactional handle and the top-level one are wrapped, so the only
 * difference between the real module and a mis-bound one is *which* handle the write went to —
 * which is exactly the thing being proved.
 *
 * Each case asserts the three things Veri named, against a snapshot taken before the approve call:
 * `plan_run.version`, the `plan_assignment` rows, and the outbox rows are all unchanged, and the
 * proposal is still PENDING.
 */
class Injected extends Error {}

/**
 * `db`, with one statement replaced by a throw.
 *
 * Wraps `tx` *and* the top-level `query`, so a write that went to the wrong handle still hits the
 * same injected failure and the test can see the difference in the rows rather than in the error.
 */
function dbFailingAt(real: Db, matches: (sql: string, params: unknown[]) => boolean): Db {
  const guard: Exec["query"] = async (sql, params) => {
    if (matches(sql, params)) throw new Injected(`injected failure at: ${sql.slice(0, 48)}`);
    return { rows: [] };
  };
  const wrap = (inner: Exec): Exec => ({
    query: async (sql, params) => (matches(sql, params) ? guard(sql, params) : inner.query(sql, params)),
  });
  return {
    query: (sql, params) => wrap(real).query(sql, params),
    tx: (fn) => real.tx((tx, afterCommit) => fn(wrap(tx), afterCommit)),
  };
}

/** The leg read decide.ts makes after the plan is saved, to carry the message's staleness basis. */
const IS_LEG_LOOKUP = (sql: string) =>
  /SELECT id, child_token, plan_version\s+FROM ops\.trip_leg/.test(sql);

/**
 * The outbound message's move to `QUEUED` — `outbox.move`, the step after the INSERT.
 *
 * Matched on the parameter rather than on the SQL, because `move` builds one statement for every
 * transition and only this one must break: the row exists by then, so a rollback has something to
 * undo.
 */
const IS_ENQUEUE_QUEUED = (sql: string, params: unknown[]) =>
  /UPDATE ops\.outbound_message SET state/.test(sql) && params[0] === "QUEUED";

/** Everything the failure must leave alone, read straight out of the tables. */
async function planSnapshot() {
  const assignments = await db.query<Record<string, unknown>>(
    `SELECT a.child_token, a.bucket, a.vehicle_id, a.plan_run_id, r.version
     FROM ops.plan_assignment a JOIN ops.plan_run r ON r.id = a.plan_run_id
     WHERE r.site_id = $1 AND r.service_date = $2
     ORDER BY a.child_token, r.direction`,
    [SITE, SERVICE_DATE],
  );
  const messages = await db.query<Record<string, unknown>>(
    "SELECT id, state, template_id FROM ops.outbound_message ORDER BY id",
    [],
  );
  const runs = await db.query<Record<string, unknown>>(
    "SELECT direction, version FROM ops.plan_run WHERE site_id = $1 AND service_date = $2 ORDER BY direction",
    [SITE, SERVICE_DATE],
  );
  return { version: await planRunVersion(), runs: runs.rows, assignments: assignments.rows, messages: messages.rows };
}

describe("a later failure in the approval transaction rolls the plan save back (S1-3b)", () => {
  it("(a) fails at the leg lookup after the save: plan_run, plan_assignment and the outbox are all unchanged", async () => {
    const started = await savedPlanWithChildInVanOne();
    const id = await seedProposal();
    const before = await planSnapshot();
    // The starting state is a real saved plan with real rows in it, or "unchanged" means nothing.
    expect(before.version).toBe(started);
    expect(before.assignments.length).toBeGreaterThan(0);

    const failing = dbFailingAt(db, IS_LEG_LOOKUP);
    await expect(
      decideApproval(
        failing,
        transport,
        { userId: coordinator, approvalId: id, decision: "APPROVED", now: NOW },
        { placement: board() },
      ),
    ).rejects.toThrow(Injected);

    // The save happened and was undone with everything else: same version, same rows.
    expect(await planSnapshot()).toEqual(before);
    expect(await planRunVersion()).toBe(started);
    // And the proposal is still there to decide, which is the coordinator-visible half.
    expect(await decisionOf(id)).toMatchObject({ decision: null, decided_at: null });
    expect(await outbox()).toEqual([]);
  });

  it("(b) fails at the enqueue of the family text, after its row was inserted: nothing survives", async () => {
    const started = await savedPlanWithChildInVanOne();
    const id = await seedProposal();
    const before = await planSnapshot();
    expect(before.version).toBe(started);
    expect(before.messages).toEqual([]);

    const failing = dbFailingAt(db, IS_ENQUEUE_QUEUED);
    await expect(
      decideApproval(
        failing,
        transport,
        { userId: coordinator, approvalId: id, decision: "APPROVED", now: NOW },
        { placement: board() },
      ),
    ).rejects.toThrow(Injected);

    /*
     * This case is the one that holds `enqueue(tx)` in place, and it was mutation-proven: changing
     * decide.ts's `enqueue(tx, …)` to `enqueue(db, …)` turns it RED, and restoring it turns it
     * green again. Worth knowing *how* it goes red, because the shape is particular to this
     * harness: PGlite serves one connection, so a top-level statement issued while the decision's
     * transaction is open does not commit beside it — it waits on it, forever, and the mutation
     * hangs the test rather than leaving a stray row behind. On the pool that production uses it
     * would be the stray row. Either way the binding is what the test is standing on; a failure
     * here means the enqueue is no longer a step of the decision.
     */
    expect(await outbox()).toEqual([]);
    expect(await planSnapshot()).toEqual(before);
    expect(await planRunVersion()).toBe(started);
    expect(await decisionOf(id)).toMatchObject({ decision: null, decided_at: null });
    // Nothing was handed to the transport either: `afterCommit` hooks run only after COMMIT.
    expect(transport.sent).toEqual([]);
  });
});
