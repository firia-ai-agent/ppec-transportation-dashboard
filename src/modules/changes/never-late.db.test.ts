import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { uuidv7 } from "uuidv7";
import type { Db } from "@/db/exec";
import { notifyGateConfig } from "@/config/live";
import { hhmmOf, minuteOfDay, plannedStopTimes } from "@/domain/plan/arrivals";
import { ridersInVan } from "@/domain/plan/board";
import { actionDepsFor } from "@/modules/actions/deps";
import { type ActionCtx } from "@/modules/actions/registry";
import { decideApproval } from "@/modules/approvals/decide";
import { boardPlacementPort } from "@/modules/approvals/plan-placement-port";
import { proposalWriter } from "@/modules/agent/run/exec/proposals";
import type { AgentWakeTransport } from "@/modules/agent/run/wake";
import { simulateParentText } from "@/modules/demo/parent-text";
import { seedStandardScenario } from "@/modules/demo/seed";
import { CHILDREN, childTokenOf, demoLegId } from "@/modules/demo/fixtures/standard";
import { FakeTransport } from "@/modules/jobs/fake-transport";
import { VercelQueueScheduler } from "@/modules/jobs/scheduler";
import { FakeOutboxTransport } from "@/modules/outbox/transport";
import { sqlPlanStoreIn } from "@/modules/plan/sql";
import { loadBoard } from "@/modules/plan/store";
import { sqlDaySource } from "@/modules/roster/sql";
import { saveAutoPlan } from "@/test/save-plan";
import { seedStaff } from "@/test/messaging";
import { freshPlanDb, SITE } from "@/test/pglite";

/**
 * A FAMILY'S LATER TIME, END TO END (ledger #90). Prod: "bring them at 4:00 instead" became a card
 * that parked a van at the child's stop with two other children aboard (+17, +18 min), and both of
 * their families were texted a later time. Through the real proposal writer, rehearsal and Approve
 * over a seeded afternoon: the card keeps everybody else on time, the stop's place is saved, the live
 * map reads the same order, and only the family who asked hears back. With nothing that would keep
 * everybody on time, a person decides — no card, no reply, no slot.
 */
let db: Db;
let close: () => Promise<void>;
let director = "";
const saved = { ...process.env };
const ENV = { APP_DATA_CLASS: "SYNTHETIC", DEMO_MODE: "1", HMAC_PEPPER: "syn-pepper-0123456789", DATA_KEY: "k" };
const NOW = new Date("2026-10-16T17:45:00.000Z"); // 1:45 PM ET, before the afternoon leaves
const DATE = "2026-10-16";
const LATE = notifyGateConfig.shiftSeconds / 60;
const wake: AgentWakeTransport = { publish: async () => {} };
const outbox = new FakeOutboxTransport();

const ctx = (): ActionCtx => ({ siteId: SITE, caller: { userId: director, role: "DIRECTOR" }, now: NOW, deps: actionDepsFor(db, SITE) });
const board = () => loadBoard(actionDepsFor(db, SITE).store!, SITE, DATE, "PM", actionDepsFor(db, SITE).source!);
const sqlPort = boardPlacementPort({ store: (tx) => sqlPlanStoreIn(tx), source: (tx, s) => sqlDaySource(tx, s) });
const eta = (view: Awaited<ReturnType<typeof board>>, token: string) =>
  plannedStopTimes(view.day, view.plan, view.departs).get(token)!.arrivesAtMinute;

/** A child with somebody after them in their van — the shape a wait would delay. */
async function childWithCompany() {
  const view = await board();
  for (const child of CHILDREN) {
    const token = childTokenOf(child.key);
    const vanId = view.plan[token]?.vanId;
    if (!vanId) continue;
    const order = ridersInVan(view.day, view.plan, vanId).map((r) => r.token);
    if (order.indexOf(token) >= 0 && order.indexOf(token) < order.length - 1) return { key: child.key, token, vanId, view };
  }
  throw new Error("no child with company");
}

/** Their family texts; the agent proposes the change for `asked`. */
async function familyAsks(key: string, asked: string) {
  const deps = actionDepsFor(db, SITE);
  expect((await simulateParentText(db, { env: ENV, now: NOW, agentTransport: wake, outboxTransport: outbox, store: deps.store!, source: deps.source! }, { siteId: SITE, childKey: key })).sent).toBe(true);
  const messageId = (await db.query<{ id: string }>("SELECT id FROM ops.message WHERE direction = 'IN' ORDER BY received_at DESC LIMIT 1", [])).rows[0].id;
  const execDeps = { db, scheduler: new VercelQueueScheduler(db, new FakeTransport(), () => NOW), transport: outbox };
  return db.tx((tx) =>
    proposalWriter(execDeps)(tx, {
      runId: uuidv7(), callId: uuidv7(), siteId: SITE, seq: 1, tool: "propose_dropoff_change",
      args: {
        leg_id: demoLegId(key, "PM"), requested_dropoff_time: asked, requested_stop_token: null, rationale_code: "PARENT_REQUEST",
        alert_text: "The family asked for a later drop-off today.", reply: "Hi, yes, we can bring them then.",
        source_message_id: messageId, expected_version: 1,
      },
      idempotencyKey: uuidv7(), approvalKey: "k", committed: [], trigger: { type: "msg.inbound", id: messageId }, now: NOW,
    }),
  );
}

const cards = () => db.query<{ id: string; proposal: { plan?: { moves: { child_token: string; drop_after?: string }[] }; lines?: string[] } }>(
  "SELECT id, proposal FROM ops.approval_request WHERE proposal->>'kind' = 'DROPOFF_CHANGE' AND decided_at IS NULL", [],
).then((r) => r.rows);
const needsPerson = () => db.query<{ refusal: { reason: string } | null }>(
  "SELECT completion_evidence -> 'refusal' AS refusal FROM ops.task WHERE category = 'ASSISTANT_UNAVAILABLE' ORDER BY created_at", [],
).then((r) => r.rows);

beforeAll(async () => {
  process.env = { ...saved, ...ENV };
  ({ db, close } = await freshPlanDb());
  director = await seedStaff(db, "DIRECTOR", SITE);
}, 180_000);

beforeEach(async () => {
  await seedStandardScenario(db, { now: NOW, siteId: SITE, env: ENV });
  expect((await saveAutoPlan(ctx(), DATE, "PM")).status).toBe(200);
}, 180_000);

afterAll(async () => {
  process.env = saved;
  await close();
});

describe("a family's later time, end to end (ledger #90)", () => {
  it("keeps everybody else on time, saves where the stop goes, and only the family who asked hears back", async () => {
    const { key, token, view: before } = await childWithCompany();
    const asked = hhmmOf(Math.round(eta(before, token)) + 33);

    expect(await familyAsks(key, asked)).toMatchObject({ approval_request_id: expect.any(String) });
    const [card] = await cards();
    expect(card.proposal.lines?.join(" ")).not.toMatch(/texted the new time/);
    expect(card.proposal.plan?.moves.find((m) => m.child_token === token)?.drop_after).toEqual(expect.any(String));

    const sentBefore = (await db.query<{ n: number }>("SELECT count(*)::int AS n FROM ops.outbound_message", [])).rows[0].n;
    expect(await decideApproval(db, outbox, { userId: director, approvalId: card.id, decision: "APPROVED", now: NOW }, { placement: sqlPort }))
      .toMatchObject({ status: 200 });

    const after = await board();
    const at = eta(after, token);
    expect(at).toBeGreaterThanOrEqual(minuteOfDay(asked)! - 0.01);
    for (const rider of after.day.riders.filter((r) => r.token !== token && after.plan[r.token]?.bucket === "VAN")) {
      const now = eta(after, rider.token);
      const late = now - minuteOfDay(rider.window)! >= LATE && now - eta(before, rider.token) >= LATE;
      expect(late, `${rider.name} made late`).toBe(false);
    }

    // The place is saved, and the stop sequence every other reader uses (the live map) is that order.
    const row = await db.query<{ drop_after: string | null; vehicle_id: string }>(
      `SELECT a.drop_after, a.vehicle_id::text AS vehicle_id FROM ops.plan_assignment a JOIN ops.plan_run r ON r.id = a.plan_run_id
        WHERE r.site_id = $1 AND r.service_date = $2 AND r.direction = 'PM' AND a.child_token = $3`,
      [SITE, DATE, token],
    );
    expect(row.rows[0].drop_after).toEqual(after.plan[token].dropAfter);
    const seq = await db.query<{ child_token: string }>(
      `SELECT a.child_token::text AS child_token FROM ops.plan_assignment a JOIN ops.plan_run r ON r.id = a.plan_run_id
        WHERE r.site_id = $1 AND r.service_date = $2 AND r.direction = 'PM' AND a.vehicle_id = $3 AND a.stop_seq IS NOT NULL
        ORDER BY a.stop_seq, a.child_token`,
      [SITE, DATE, row.rows[0].vehicle_id],
    );
    const drives = ridersInVan(after.day, after.plan, row.rows[0].vehicle_id).map((r) => r.token);
    expect(seq.rows.map((r) => r.child_token).filter((t) => drives.includes(t))).toEqual(drives.filter((t) => seq.rows.some((r) => r.child_token === t)));

    // Texts from this Approve: the asking family's reply, and nobody else's "new time".
    const texts = await db.query<{ child_token: string | null }>(
      "SELECT child_token::text AS child_token FROM ops.outbound_message ORDER BY created_at OFFSET $1", [sentBefore],
    );
    expect(texts.rows.length).toBeGreaterThan(0);
    expect(texts.rows.every((t) => t.child_token === token)).toBe(true);
  });

  it("asks a person when no route keeps everybody on time — no card, no reply, no slot", async () => {
    const { key } = await childWithCompany();
    // 2:00 PM: no van has left the centre by then, so no route gets there inside 2:00–2:30.
    const slots = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM ops.availability", []);
    expect(await familyAsks(key, "14:00")).toMatchObject({ proposal_refused: "REFUSED" });
    expect(await cards()).toEqual([]);
    const [alert] = await needsPerson();
    expect(alert.refusal?.reason).toBe("WOULD_MAKE_LATE");
    expect((await db.query<{ n: number }>("SELECT count(*)::int AS n FROM ops.availability", [])).rows[0].n).toBe(slots.rows[0].n);
  });
});
