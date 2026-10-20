import { beforeEach, afterAll, beforeAll, describe, expect, it } from "vitest";
import { uuidv7 } from "uuidv7";
import type { Db } from "@/db/exec";
import { plannedStopTimes, hhmmOf } from "@/domain/plan/arrivals";
import { ridersInVan } from "@/domain/plan/board";
import { actionDepsFor } from "@/modules/actions/deps";
import { ACTIONS, type ActionCtx } from "@/modules/actions/registry";
import { openAssistantAlerts } from "@/modules/agent/staff-alert";
import type { IdentityGateway } from "@/modules/identity/gateway";
import { decideApproval } from "@/modules/approvals/decide";
import { boardPlacementPort } from "@/modules/approvals/plan-placement-port";
import { proposalWriter } from "@/modules/agent/run/exec/proposals";
import type { AgentWake, AgentWakeTransport } from "@/modules/agent/run/wake";
import { simulateParentText } from "@/modules/demo/parent-text";
import { seedStandardScenario } from "@/modules/demo/seed";
import { childTokenOf, demoLegId } from "@/modules/demo/fixtures/standard";
import { FakeTransport } from "@/modules/jobs/fake-transport";
import { VercelQueueScheduler } from "@/modules/jobs/scheduler";
import { FakeOutboxTransport } from "@/modules/outbox/transport";
import { sqlPlanStoreIn } from "@/modules/plan/sql";
import { loadBoard } from "@/modules/plan/store";
import { sqlDaySource } from "@/modules/roster/sql";
import { defaultsOfSlot } from "@/test/board-day";
import { saveAutoPlan } from "@/test/save-plan";
import { seedStaff } from "@/test/messaging";
import { freshPlanDb, SITE } from "@/test/pglite";

/**
 * THE AGENT REHEARSES BEFORE IT PROMISES, AND ASKS FOR HELP WHEN IT CAN'T (ledger #80).
 *
 * On a seeded afternoon, through the real proposal writer and the real Approve:
 *  - a van over its counts that can be put right: the family's card puts it right too, and one
 *    Approve saves both (no card is drafted that Approve would refuse);
 *  - nothing the board would take: no card, no drafted reply — a "needs a person" card that says
 *    what is in the way and links the van to fix;
 *  - the board moves after the card was drafted: Approve is refused in the board's own words, a
 *    person is told, and approving once it is fixed answers that too.
 */
let db: Db;
let close: () => Promise<void>;
let director = "";
const saved = { ...process.env };
const ENV = { APP_DATA_CLASS: "SYNTHETIC", DEMO_MODE: "1", HMAC_PEPPER: "syn-pepper-0123456789", DATA_KEY: "k" };
const NOW = new Date("2026-10-16T17:45:00.000Z"); // 1:45 PM ET, before the afternoon leaves
const DATE = "2026-10-16";
const woken: AgentWake[] = [];
const wake: AgentWakeTransport = { publish: async (m) => void woken.push(m) };
const outbox = new FakeOutboxTransport();
const names: IdentityGateway = { namesForContacts: async () => new Map() } as unknown as IdentityGateway;

const ctx = (): ActionCtx => ({ siteId: SITE, caller: { userId: director, role: "DIRECTOR" }, now: NOW, deps: actionDepsFor(db, SITE) });
const board = () => loadBoard(actionDepsFor(db, SITE).store!, SITE, DATE, "PM", actionDepsFor(db, SITE).source!);
const sqlPort = boardPlacementPort({ store: (tx) => sqlPlanStoreIn(tx), source: (tx, s) => sqlDaySource(tx, s) });

/** A van's seats, as the ramp would count them. */
async function seats(slot: number, n: number) {
  const view = await board();
  const van = view.day.vans.find((v) => v.slot === slot)!;
  expect((await ACTIONS.confirm_van_setup.run(ctx(), { ...defaultsOfSlot(slot), seats: n, vanId: van.id, date: DATE, state: "CHECKED" })).status).toBe(200);
}

/** Noah's family texts that they won't be home, and the agent proposes the drop-off change. */
async function noahsFamilyAsks(minutesLater = 40) {
  const view = await board();
  const noah = childTokenOf("C2");
  const later = hhmmOf(Math.round(plannedStopTimes(view.day, view.plan, view.departs).get(noah)!.arrivesAtMinute) + minutesLater);
  const deps = actionDepsFor(db, SITE);
  expect((await simulateParentText(db, { env: ENV, now: NOW, agentTransport: wake, outboxTransport: outbox, store: deps.store!, source: deps.source! }, { siteId: SITE, childKey: "C2" })).sent).toBe(true);
  const messageId = (await db.query<{ id: string }>("SELECT id FROM ops.message WHERE direction = 'IN' ORDER BY received_at DESC LIMIT 1", [])).rows[0].id;
  const execDeps = { db, scheduler: new VercelQueueScheduler(db, new FakeTransport(), () => NOW), transport: outbox };
  const result = await db.tx((tx) =>
    proposalWriter(execDeps)(tx, {
      runId: uuidv7(), callId: uuidv7(), siteId: SITE, seq: 1, tool: "propose_dropoff_change",
      args: {
        leg_id: demoLegId("C2", "PM"), requested_dropoff_time: later, requested_stop_token: null, rationale_code: "PARENT_REQUEST",
        alert_text: "F2 asked to have C2 dropped off later today.", reply: "Hi F2, yes, we can bring C2 then.",
        source_message_id: messageId, expected_version: 1,
      },
      idempotencyKey: uuidv7(), approvalKey: "k", committed: [], trigger: { type: "msg.inbound", id: messageId }, now: NOW,
    }),
  );
  return { result, messageId, later };
}

const cards = () => db.query<{ id: string; proposal: { plan?: { moves: { child_token: string }[] }; lines?: string[] } }>(
  "SELECT id, proposal FROM ops.approval_request WHERE proposal->>'kind' = 'DROPOFF_CHANGE' AND decided_at IS NULL", [],
).then((r) => r.rows);
const needsPerson = () => db.query<{ id: string; state: string; refusal: { reason: string; vanName: string } | null; approval: string | null }>(
  `SELECT id, state::text AS state, completion_evidence -> 'refusal' AS refusal, completion_evidence -> 'locator' ->> 'approval_id' AS approval
     FROM ops.task WHERE category = 'ASSISTANT_UNAVAILABLE' ORDER BY created_at`, [],
).then((r) => r.rows);
const approve = (id: string) =>
  decideApproval(db, outbox, { userId: director, approvalId: id, decision: "APPROVED", now: NOW }, { placement: sqlPort });

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

describe("rehearse before promising (ledger #80)", () => {
  it("puts right a van that no longer fits in the same card, and one Approve saves both", async () => {
    const view = await board();
    const noahsVan = view.plan[childTokenOf("C2")].vanId;
    const other = view.day.vans.find((v) => v.id !== noahsVan && ridersInVan(view.day, view.plan, v.id).length >= 2)!;
    await seats(other.slot, ridersInVan(view.day, view.plan, other.id).length - 1);

    const { result } = await noahsFamilyAsks();
    expect(result).toMatchObject({ approval_request_id: expect.any(String) });
    const [card] = await cards();
    // The card moves somebody else too — the fix for the van that was over — and says every van fits.
    expect(card.proposal.plan!.moves.some((m) => m.child_token !== childTokenOf("C2"))).toBe(true);
    expect(card.proposal.lines).toContain("Every van fits");
    expect(await approve(card.id)).toMatchObject({ status: 200 });
  });

  it("drafts nothing when no route would save, and a person is told what is in the way", async () => {
    const view = await board();
    for (const van of view.day.vans) await seats(van.slot, 1);

    const { result } = await noahsFamilyAsks();
    expect(result).toMatchObject({ proposal_refused: "REFUSED" });
    expect(await cards()).toEqual([]);
    const [alert] = await needsPerson();
    expect(alert.refusal).toMatchObject({ reason: "SEAT", vanName: expect.stringMatching(/^Van \d$/) });

    // For you says it in one plain sentence, with the van to fix.
    const [card] = await openAssistantAlerts(db, [SITE], names);
    expect(card.sentence).toMatch(/I couldn't plan it: Van \d is out of seats\.$/);
    expect(card.fix).toMatchObject({ label: expect.stringMatching(/^Fix Van \d$/), href: expect.stringContaining("/plan-routes?") });
  });

  it("refuses Approve loudly when the board moved, and approving once it is fixed answers that too", async () => {
    await noahsFamilyAsks();
    const [card] = await cards();
    const view = await board();
    const noahsVan = view.day.vans.find((v) => v.id === view.plan[childTokenOf("C2")].vanId)!;
    await seats(noahsVan.slot, 1);

    const sentBefore = outbox.sent.length;
    const refused = await approve(card.id);
    expect(refused).toMatchObject({ status: 409, body: { error: "REFUSED", refusal: { vanName: noahsVan.name } } });
    expect(outbox.sent.length).toBe(sentBefore);
    const [alert] = await needsPerson();
    expect(alert).toMatchObject({ state: "OPEN", approval: card.id });

    await seats(noahsVan.slot, defaultsOfSlot(noahsVan.slot).seats);
    expect(await approve(card.id)).toMatchObject({ status: 200 });
    expect((await needsPerson())[0].state).toMatch(/^RESOLVED/);
  });
});
