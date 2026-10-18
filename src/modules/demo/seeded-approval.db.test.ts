/**
 * THE DEMO SEEDS A REAL APPROVAL ROW — Firia's S1-2, 2026-10-17 11:00 PM ET: "Demo data seeds real
 * approval rows via the demo adapter (src/modules/demo/…), not UI fixtures."
 *
 * On PGlite over the real migrations, because the claim is about *rows*: that
 * `seedStandardScenario` leaves an `ops.approval_request` the screen's own query reads back, with
 * the shape `decideApproval` can act on, under the real constraints (`task_id` is NOT NULL with an
 * FK to `ops.task`; `proposal` is the one jsonb column every `propose_*` tool shares).
 *
 * Four things it holds:
 *
 *  1. the seed writes exactly one undecided `DROPOFF_CHANGE` row, and `pendingApprovals` — the
 *     query behind the For you badge and the card — returns it;
 *  2. the row names a leg that exists, a child the day has, and the stop the roster gives that
 *     child, so nothing on the card is reconstructed from an id scheme;
 *  3. `plan_run_version_basis` is the board's counter read at seed time (`0` on a day with no
 *     saved plan), read the way `propose_dropoff_change` reads it rather than chosen — see below;
 *  4. re-seeding is "Restart demo day": one row again, not two.
 *
 * ## The basis is recorded, and the row stays decidable either way
 *
 * The seed writes no `plan_run` (§9.1: the map stays locked until the ramp is confirmed), so the
 * board's counter is `0` and that is what the row records. On a freshly restarted day approving
 * writes `plan_run` version 1 through `setChildPlacement` and queues the family's text, which is
 * the demo's own path and the last suite below. And after somebody has saved a plan it does the
 * same thing against the version the plan then holds: Firia's PR #75 ruling removed the
 * plan-version check from `decideApproval`, so the demo's own next step — staff pressing Auto-plan
 * and Save — no longer turns the one seeded card into a `409` nobody can clear.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@/db/exec";
import { DROPOFF_CHANGE_KIND } from "@/modules/agent/run/exec/proposals";
import { decideApproval, pendingApprovals } from "@/modules/approvals/decide";
import {
  boardPlacementPort,
  type PlanPlacementPortFor,
} from "@/modules/approvals/plan-placement-port";
import { FakeOutboxTransport } from "@/modules/outbox/transport";
import { setChildPlacement } from "@/modules/plan/place";
import { sqlPlanStore, sqlPlanStoreIn } from "@/modules/plan/sql";
import { loadBoard } from "@/modules/plan/store";
import { sqlDaySource } from "@/modules/roster/sql";
import { VANS } from "@/config/vans";
import { seedStaff } from "@/test/messaging";
import { freshPlanDb, SITE } from "@/test/pglite";
import { seedDemoChangeRequest } from "./approval-seed";
import { demoChangeRequests } from "./change-request";
import { childByKey, childTokenOf, stopByKey, vehicleIdOf } from "./fixtures/standard";
import { seedStandardScenario } from "./seed";

const NOW = new Date("2026-10-16T17:45:00.000Z");
const SERVICE_DATE = "2026-10-16";
const ENV = { APP_DATA_CLASS: "SYNTHETIC", DEMO_MODE: "1", HMAC_PEPPER: "p", DATA_KEY: "k" };

let db: Db;
let close: () => Promise<void>;
let coordinator: string;

const board = (): PlanPlacementPortFor =>
  boardPlacementPort({
    store: (tx) => sqlPlanStoreIn(tx),
    source: (tx, siteId) => sqlDaySource(tx, siteId),
  });

beforeAll(async () => {
  ({ db, close } = await freshPlanDb());
  coordinator = await seedStaff(db, "COORDINATOR", SITE);
}, 180_000);

afterAll(async () => {
  await close();
});

beforeEach(async () => {
  await seedStandardScenario(db, { now: NOW, siteId: SITE, env: ENV });
}, 120_000);

/** The one change request the day has — the request the seeded row is about. */
const request = () => demoChangeRequests()[0];

describe("seedStandardScenario leaves a real approval row (S1-2)", () => {
  it("writes exactly one undecided DROPOFF_CHANGE row, and the screen's query reads it", async () => {
    const rows = await db.query<{ id: string; kind: string; n: string }>(
      `SELECT id, proposal ->> 'kind' AS kind, count(*) OVER ()::text AS n
       FROM ops.approval_request WHERE site_id = $1 AND decided_at IS NULL`,
      [SITE],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].kind).toBe(DROPOFF_CHANGE_KIND);
    expect(rows.rows[0].id).toBe(request().approvalId);

    // `pendingApprovals` is the one query the badge and the card both come from (queue.ts).
    const pending = await pendingApprovals(db, [SITE]);
    expect(pending).toHaveLength(1);
    expect(pending[0].id).toBe(request().approvalId);
    // The child, named off `ops.child_profile` by the query's own join.
    expect(pending[0].childLabel).toBe(childByKey(request().childKey)!.label);
    expect(pending[0].childToken).toBe(childTokenOf(request().childKey));
    expect(pending[0].requestedTime).toBe(request().requestedHhmm);
    // The words come from the row's template and vars through the outbox's own renderer.
    expect(pending[0].templateId).toBe("dropoff.changed");
    // The child in the sentence is their first name: `renderTemplate` shortens a staff label to
    // the name a family reads (src/modules/identity/display-name.ts).
    expect(pending[0].text).toContain(childByKey(request().childKey)!.firstName);
    // `created_at` is readable, which is the card's "Agent · …" line.
    expect(pending[0].draftedAtMs).toBeGreaterThan(0);
  });

  it("names a leg that exists, and the stop the roster gives that child", async () => {
    const proposal = await proposalJson();
    const leg = await db.query<{ n: number }>(
      "SELECT count(*)::int n FROM ops.trip_leg WHERE id = $1 AND site_id = $2 AND direction = 'PM'",
      [proposal.leg_id, SITE],
    );
    expect(leg.rows[0].n).toBe(1);
    expect(proposal.child_token).toBe(childTokenOf(request().childKey));
    expect(proposal.service_date).toBe(SERVICE_DATE);
    expect(proposal.stop_token).toBe(stopByKey(childByKey(request().childKey)!.stopKey!).smsToken);
    // A code, never prose (tools.ts `DROPOFF_CHANGE_REASON_CODES`).
    expect(proposal.rationale_code).toBe("PARENT_REQUEST");
    // And the task it hangs off is a real OPEN row, which the NOT NULL FK requires.
    const task = await db.query<{ state: string }>(
      "SELECT state FROM ops.task WHERE id = (SELECT task_id FROM ops.approval_request WHERE id = $1)",
      [request().approvalId],
    );
    expect(task.rows[0].state).toBe("OPEN");
  });

  it("records plan_run.version as the basis — 0 on a day with no saved plan", async () => {
    const proposal = await proposalJson();
    expect(proposal.plan_run_version_basis).toBe(0);
    const plan = await db.query<{ n: number }>(
      "SELECT count(*)::int n FROM ops.plan_run WHERE site_id = $1 AND service_date = $2",
      [SITE, SERVICE_DATE],
    );
    expect(plan.rows[0].n).toBe(0);
  });

  it("re-seeds rather than stacking: Restart demo day leaves one row, not two", async () => {
    await seedStandardScenario(db, { now: NOW, siteId: SITE, env: ENV });
    const again = await pendingApprovals(db, [SITE]);
    expect(again).toHaveLength(1);
    expect(again[0].id).toBe(request().approvalId);
  });

  it("writes nothing when the leg it would name is not in this database", async () => {
    await db.query("DELETE FROM ops.approval_request WHERE site_id = $1", [SITE]);
    await db.query("DELETE FROM ops.task WHERE site_id = $1", [SITE]);
    await db.query("DELETE FROM ops.manifest_reservation WHERE site_id = $1", [SITE]);
    await db.query("DELETE FROM ops.trip_leg WHERE site_id = $1", [SITE]);
    const wrote = await db.tx((tx) =>
      seedDemoChangeRequest(tx, { siteId: SITE, serviceDate: SERVICE_DATE }),
    );
    expect(wrote).toBeNull();
    expect(await pendingApprovals(db, [SITE])).toEqual([]);
  });
});

describe("the seeded proposal is a real decision, before and after a plan is saved", () => {
  it("APPROVES on a fresh day: the plan is saved through the board and the family is queued", async () => {
    /*
     * This is the demo's own path. A restarted day has no `plan_run`, so the board's counter is
     * `0` — which is the basis the seed recorded, because it read the same counter the same way.
     * `setChildPlacement` writes version 1 with the child in the van the day already has them in,
     * and the text is queued through the outbox.
     */
    const transport = new FakeOutboxTransport();
    const r = await decideApproval(
      db,
      transport,
      { userId: coordinator, approvalId: request().approvalId, decision: "APPROVED", now: NOW },
      { placement: board() },
    );
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    // One plan write, through the board's own writer, inside the approval's transaction (S1-3).
    const plan = await db.query<{ version: number }>(
      "SELECT version FROM ops.plan_run WHERE site_id = $1 AND service_date = $2 AND direction = 'PM'",
      [SITE, SERVICE_DATE],
    );
    expect(plan.rows[0].version).toBe(1);
    // Decided, and the family's text is in the outbox rather than sent from here.
    expect(await pendingApprovals(db, [SITE])).toEqual([]);
    expect(await queuedCount()).toBeGreaterThan(0);
  });

  it("still APPROVES once a plan has been saved, against the version the plan then holds (PR #75)", async () => {
    const before = await loadBoard(sqlPlanStore(db), SITE, SERVICE_DATE, "PM", sqlDaySource(db, SITE));
    expect(before.started, "the seeded clock starts this day").toBe(true);
    const saved = await setChildPlacement(
      {
        siteId: SITE,
        serviceDate: SERVICE_DATE,
        direction: "PM",
        childToken: childTokenOf(request().childKey),
        bucket: "VAN",
        vehicleId: vehicleIdOf(VANS[0].vehicleKey),
        expectedVersion: before.version,
        actor: null,
        now: NOW,
      },
      sqlPlanStore(db),
      sqlDaySource(db, SITE),
    );
    expect(saved.ok, JSON.stringify(saved)).toBe(true);

    const transport = new FakeOutboxTransport();
    const r = await decideApproval(
      db,
      transport,
      { userId: coordinator, approvalId: request().approvalId, decision: "APPROVED", now: NOW },
      { placement: board() },
    );
    /*
     * This is the demo's actual order of operations — seed, then Auto-plan + Save, then decide the
     * card — and it used to be a `409 PLAN_MOVED` here. Firia's PR #75: the basis is not checked.
     * The decision reads the plan it is about to write and is guarded on that read, so the save
     * above becomes the version this write builds on.
     */
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(await pendingApprovals(db, [SITE])).toEqual([]);
    expect(await queuedCount()).toBeGreaterThan(0);
    const after = await db.query<{ version: number }>(
      "SELECT version FROM ops.plan_run WHERE site_id = $1 AND service_date = $2 AND direction = 'PM'",
      [SITE, SERVICE_DATE],
    );
    expect(after.rows[0].version).toBe(saved.ok ? saved.version + 1 : -1);
  });
});

async function proposalJson(): Promise<Record<string, string | number | null>> {
  const r = await db.query<{ proposal: Record<string, string | number | null> }>(
    "SELECT proposal FROM ops.approval_request WHERE id = $1",
    [request().approvalId],
  );
  return r.rows[0].proposal;
}

async function queuedCount(): Promise<number> {
  const r = await db.query<{ n: number }>(
    "SELECT count(*)::int n FROM ops.outbound_message WHERE site_id = $1",
    [SITE],
  );
  return r.rows[0].n;
}
