import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/db/exec";
import { ACTIONS, type ActionCtx } from "@/modules/actions/registry";
import { confirmStaffAction } from "@/modules/actions/confirm";
import { actionDepsFor } from "@/modules/actions/deps";
import { seedStandardScenario } from "@/modules/demo/seed";
import { FakeTransport } from "@/modules/jobs/fake-transport";
import { VercelQueueScheduler } from "@/modules/jobs/scheduler";
import { FakeOutboxTransport } from "@/modules/outbox/transport";
import { vansOver } from "@/modules/plan/place";
import { sendReplanLateNotices } from "@/modules/plan/replan-notices";
import { loadBoard } from "@/modules/plan/store";
import { raiseVanShortAlerts, VAN_SHORT_TASK_CATEGORY } from "@/modules/plan/van-short";
import { defaultsOfSlot, vanIdOfSlot } from "@/test/board-day";
import { seedStaff } from "@/test/messaging";
import { freshPlanDb, SITE } from "@/test/pglite";
import { loadAgentConfig, DEMO_DATA_ONLY_ENV_VAR, DEMO_DATA_ONLY_REQUIRED_VALUE } from "./config";
import { ALERT_TRIGGER, alertAgent } from "./alerts";
import { createGateway } from "./gateway";
import { fakeProvider, toolCall } from "./providers/fake";
import { dbContextAssembler } from "./run/assembler";
import { liveExecutors, liveProposalWriter } from "./run/exec/registry";
import { driveRun } from "./run/loop";
import type { AgentWake, AgentWakeTransport } from "./run/wake";

/**
 * ALERTS REACH THE AGENT, AND IT PROPOSES (ledger #74 e — S8, S9).
 *
 * The founder's afternoon as the system now runs it: the plan is saved, the ramp confirms Van 1
 * with two seats, and nobody has to notice. The confirm raises one VAN_SHORT alert; the alert starts
 * one agent run; the run reads the board and proposes the re-plan as a card — it changes nothing,
 * because nobody asked it to act; a director confirms the card, and the plan is saved as that
 * director, every van fits, and the families the re-plan made late are texted.
 *
 * The scripted model is the only stand-in. The context is the real alert reader, the policy the
 * real engine, the executors and the action layer the real ones over a seeded database.
 */
let db: Db;
let close: () => Promise<void>;
const saved = { ...process.env };
const ENV = {
  APP_DATA_CLASS: "SYNTHETIC", DEMO_MODE: "1", HMAC_PEPPER: "p", DATA_KEY: "k",
  [DEMO_DATA_ONLY_ENV_VAR]: DEMO_DATA_ONLY_REQUIRED_VALUE,
};
const NOW = new Date("2026-10-16T17:45:00.000Z");
const DATE = "2026-10-16";
const people = { director: "", frontDesk: "" };
const woken: AgentWake[] = [];
const wake: AgentWakeTransport = { publish: async (m) => void woken.push(m) };
const routing = { model: "test-model", provider: "openrouter" };
const outbox = new FakeOutboxTransport();

const deps = () => ({
  ...actionDepsFor(db, SITE),
  vanShort: (input: Parameters<typeof raiseVanShortAlerts>[3]) => raiseVanShortAlerts(db, wake, routing, input),
  notify: (input: Parameters<typeof sendReplanLateNotices>[2]) => sendReplanLateNotices(db, outbox, input),
});
const ctx = (userId: string, role: ActionCtx["caller"]["role"]): ActionCtx => ({ siteId: SITE, caller: { userId, role }, now: NOW, deps: deps() });
const board = () => loadBoard(actionDepsFor(db, SITE).store!, SITE, DATE, "PM", actionDepsFor(db, SITE).source);
const confirmShort = () =>
  ACTIONS.confirm_van_setup.run(ctx(people.frontDesk, "FRONT_DESK"), {
    ...defaultsOfSlot(1), seats: 2, vanId: vanIdOfSlot(1), date: DATE, state: "CHECKED" as const,
  });
const alertRows = async () =>
  (await db.query<{ id: string }>("SELECT id FROM ops.task WHERE category = $1", [VAN_SHORT_TASK_CATEGORY])).rows;
const alertRuns = async () =>
  (await db.query<{ id: string; trigger_id: string; state: string }>(
    "SELECT id, trigger_id, state FROM ops.agent_run WHERE trigger_type = $1 ORDER BY created_at", [ALERT_TRIGGER],
  )).rows;

beforeAll(async () => {
  process.env = { ...saved, ...ENV };
  ({ db, close } = await freshPlanDb());
  await seedStandardScenario(db, { now: NOW, siteId: SITE, env: ENV });
  people.director = await seedStaff(db, "DIRECTOR", SITE);
  people.frontDesk = await seedStaff(db, "FRONT_DESK", SITE);
  expect((await ACTIONS.auto_plan.run(ctx(people.director, "DIRECTOR"), { date: DATE, direction: "PM" })).status).toBe(200);
}, 180_000);

afterAll(async () => {
  process.env = saved;
  await close();
});

describe("a van confirmed short at the ramp is an alert, and the agent hears it (S8)", () => {
  it("raises one VAN_SHORT alert and starts one agent run on it", async () => {
    expect((await confirmShort()).status).toBe(200);
    const [alert] = await alertRows();
    expect(alert).toBeDefined();
    const runs = await alertRuns();
    expect(runs.map((r) => [r.trigger_id, r.state])).toEqual([[alert.id, "QUEUED"]]);
    expect(woken.map((w) => w.runId)).toEqual([runs[0].id]);
  });

  it("proposes the re-plan as a card, and changes nothing itself", async () => {
    const [run] = await alertRuns();
    const execDeps = { db, scheduler: new VercelQueueScheduler(db, new FakeTransport(), () => NOW), transport: outbox };
    const result = await driveRun(
      {
        db,
        gateway: createGateway(
          fakeProvider([toolCall("get_plan", { date: DATE, leg: "PM" }), toolCall("auto_plan", { date: DATE, leg: "PM" })]),
          loadAgentConfig(ENV),
          { now: () => NOW.getTime() },
        ),
        assemble: dbContextAssembler(db, { env: ENV }),
        executors: liveExecutors(execDeps),
        proposals: liveProposalWriter(execDeps),
        scheduler: execDeps.scheduler,
        now: () => NOW,
      },
      run.id,
    );
    expect(result.state, JSON.stringify(result)).toBe("SUCCEEDED");
    const calls = await db.query<{ tool: string; status: string }>(
      "SELECT tool, status FROM ops.agent_tool_call WHERE run_id = $1 ORDER BY seq", [run.id],
    );
    // The alert run may read and propose; its auto_plan is a proposal (policy proposeOnly), not a save.
    expect(calls.rows.map((c) => [c.tool, c.status])).toEqual([["get_plan", "EXECUTED"], ["auto_plan", "PROPOSED"]]);
    const view = await board();
    expect(vansOver(view, view.plan)).toEqual([vanIdOfSlot(1)]);
  });

  it("re-plans as the director who confirms the card: every van fits, and the late families are texted", async () => {
    const card = (
      await db.query<{ id: string; summary: string }>(
        "SELECT id, proposal->>'summary' AS summary FROM ops.approval_request WHERE proposal->>'kind' = 'STAFF_ACTION' AND decided_at IS NULL",
        [],
      )
    ).rows[0];
    expect(card.summary).toMatch(/Re-plan the afternoon/);
    const before = await board();
    const answer = await confirmStaffAction(
      db,
      { userId: people.director, approvalId: card.id, decision: "APPROVED", now: NOW },
      { notify: deps().notify },
    );
    expect(answer).toEqual({ status: 200, body: { ok: true, decision: "APPROVED" } });
    const after = await board();
    expect(vansOver(after, after.plan)).toEqual([]);
    expect(after.version).toBe(before.version + 1);
    const late = await db.query("SELECT 1 FROM ops.outbound_message WHERE template_id = 'dropoff.late_eta'", []);
    expect(late.rows.length).toBeGreaterThan(0);
  });
});

describe("alerts cannot loop, repeat or flood (S9)", () => {
  it("raises nothing new for the same counts confirmed again", async () => {
    const [alerts, runs] = [await alertRows(), await alertRuns()];
    expect((await confirmShort()).status).toBe(200);
    expect(await alertRows()).toHaveLength(alerts.length);
    expect(await alertRuns()).toHaveLength(runs.length);
  });

  it("starts no run for a task the agent wrote, or for the ask path's own rows", async () => {
    const noop = () => undefined;
    expect(await alertAgent(db, noop, wake, { id: "00000000-0000-7000-8000-00000000e001", siteId: SITE, category: "VAN_SHORT", by: "agent:run-1" }, routing))
      .toBe("agent-wrote-it");
    expect(await alertAgent(db, noop, wake, { id: "00000000-0000-7000-8000-00000000e002", siteId: SITE, category: "NEEDS_PERSON", by: "staff:x" }, routing))
      .toBe("not-for-the-agent");
    expect(await alertAgent(db, noop, wake, { id: "00000000-0000-7000-8000-00000000e003", siteId: SITE, category: "AGENT_POLICY_STAFF_REVIEW", by: "system" }, routing))
      .toBe("not-for-the-agent");
  });

  it("stops at the hourly cap", async () => {
    const noop = () => undefined;
    let last = "";
    for (let i = 0; i < 25; i += 1) {
      last = await alertAgent(db, noop, wake, { id: `00000000-0000-7000-8000-0000000f${String(i).padStart(4, "0")}`, siteId: SITE, category: "VAN_SHORT", by: "staff:x" }, routing);
    }
    expect(last).toBe("over-the-hourly-cap");
    expect((await alertRuns()).length).toBeLessThanOrEqual(20);
  });
});
