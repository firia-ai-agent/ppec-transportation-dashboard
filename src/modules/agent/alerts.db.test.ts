import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/db/exec";
import { saveAutoPlan } from "@/test/save-plan";
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
import { readAgentThread } from "./ask/thread";
import { confirmCards } from "@/modules/actions/confirm-cards";
import { agentBubble, confirmCopy, fill } from "@/ui/copy";
import { askAgent } from "./ask/staff-ask";
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
  // Vans leave at 3:40, tight against the families' windows, so a re-plan that moves a child can
  // make them late and the texts are exercised (ledger #76: lateness is computed, never assumed).
  expect((await saveAutoPlan(ctx(people.director, "DIRECTOR"), DATE, "PM", "15:40")).status).toBe(200);
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
          fakeProvider([toolCall("get_plan", { leg: "PM" }), toolCall("propose_plan_change", { leg: "PM", replan: true, note: "Van 1 came back short, so one child moves." })]),
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
    // The alert run may read and propose; a plan change is a card (ledger #77), not a save.
    expect(calls.rows.map((c) => [c.tool, c.status])).toEqual([["get_plan", "EXECUTED"], ["propose_plan_change", "PROPOSED"]]);
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

describe("the bubble shows what the agent heard, and how it ended (ledger #75 b — C2, C4)", () => {
  const confirmSeats = (seats: number) =>
    ACTIONS.confirm_van_setup.run(ctx(people.frontDesk, "FRONT_DESK"), {
      ...defaultsOfSlot(1), seats, vanId: vanIdOfSlot(1), date: DATE, state: "CHECKED" as const,
    });
  const latestAlert = async () =>
    (await db.query<{ task_id: string; run_id: string; summary: string }>(
      `SELECT t.id::text AS task_id, r.id AS run_id, t.summary FROM ops.agent_run r JOIN ops.task t ON t.id::text = r.trigger_id
        WHERE r.trigger_type = $1 ORDER BY r.created_at DESC LIMIT 1`, [ALERT_TRIGGER],
    )).rows[0];
  const drive = (runId: string, script: Parameters<typeof fakeProvider>[0]) => {
    const execDeps = { db, scheduler: new VercelQueueScheduler(db, new FakeTransport(), () => NOW), transport: outbox };
    return driveRun({
      db,
      gateway: createGateway(fakeProvider(script), loadAgentConfig(ENV), { now: () => NOW.getTime() }),
      assemble: dbContextAssembler(db, { env: ENV }),
      executors: liveExecutors(execDeps),
      proposals: liveProposalWriter(execDeps),
      scheduler: execDeps.scheduler,
      now: () => NOW,
    }, runId);
  };
  const itemsFor = async (taskId: string) =>
    (await readAgentThread(db, SITE)).items.filter((i) => "id" in i && i.id.startsWith(taskId));

  it("names who no longer fits, by the ramp's own rule", async () => {
    expect((await confirmSeats(1)).status).toBe(200);
    expect((await latestAlert()).summary).toMatch(/^Van 1 no longer fits .+ this afternoon$/);
    expect((await latestAlert()).summary).not.toContain("its riders");
  });

  it("says it is working while the run is queued", async () => {
    const a = await latestAlert();
    expect((await itemsFor(a.task_id)).map((i) => ("id" in i ? i.id : ""))).toEqual([`${a.task_id}:alert`, `${a.task_id}:working`]);
  });

  it("shows only the model's own words when it answers instead of proposing", async () => {
    const a = await latestAlert();
    const words = "Van 1 is down to one seat, but every other van is full this afternoon, so nobody can move yet.";
    const r = await drive(a.run_id, [toolCall("get_plan", { date: DATE, leg: "PM" }), toolCall("reply_to_staff", { summary: words })]);
    expect(r.state, JSON.stringify(r)).toBe("SUCCEEDED");
    expect(await itemsFor(a.task_id)).toEqual([{ kind: "agent", id: `${a.task_id}:answer`, text: words }]);
  });

  it("puts the model's sentence on the card it drafts", async () => {
    expect((await confirmSeats(0)).status).toBe(200);
    const a = await latestAlert();
    const note = "Van 1 has no seats now, so re-planning the afternoon moves its riders to the other vans.";
    const r = await drive(a.run_id, [toolCall("propose_plan_change", { leg: "PM", replan: true, note })]);
    expect(r.state, JSON.stringify(r)).toBe("SUCCEEDED");
    expect((await itemsFor(a.task_id)).map((i) => ("id" in i ? i.id : ""))).toEqual([`${a.task_id}:alert`]);
    const cards = await confirmCards(db, SITE);
    expect(cards.at(-1)).toMatchObject({ summary: expect.stringMatching(/afternoon/), note });
  });

  it("says what is wrong and links the board when the run ended with nothing", async () => {
    const a = await latestAlert();
    await db.query("UPDATE ops.agent_tool_call SET status = 'FAILED' WHERE run_id = $1", [a.run_id]);
    // …and no re-plan of the leg is waiting for anybody either.
    await db.query("UPDATE ops.approval_request SET decided_at = now(), decision = 'DECLINED' WHERE decided_at IS NULL", []);
    const [line] = await itemsFor(a.task_id);
    expect(line).toEqual({
      kind: "agent",
      id: `${a.task_id}:no-fix`,
      text: fill(agentBubble.couldNotFix, { situation: a.summary }),
      link: { href: `/plan-routes?date=${DATE}&leg=pm&van=${encodeURIComponent(vanIdOfSlot(1))}`, label: agentBubble.replanLink },
    });
  });
});

describe("one situation, one conversation (ledger #75 — C7)", () => {
  // Counts no earlier test confirmed: an alert is one per van, leg and setup, so a repeat is no news.
  const confirmSeats = (seats: number, oxygenMounts = 0) =>
    ACTIONS.confirm_van_setup.run(ctx(people.frontDesk, "FRONT_DESK"), {
      ...defaultsOfSlot(1), seats, oxygenMounts, vanId: vanIdOfSlot(1), date: DATE, state: "CHECKED" as const,
    });
  const runsOn = async () =>
    (await db.query<{ task_id: string; state: string }>(
      `SELECT r.trigger_id AS task_id, r.state FROM ops.agent_run r JOIN ops.task t ON t.id::text = r.trigger_id
        WHERE r.trigger_type = $1 AND t.category = 'VAN_SHORT' ORDER BY r.created_at`, [ALERT_TRIGGER],
    )).rows;
  const shownAlerts = async () =>
    (await readAgentThread(db, SITE)).items.flatMap((i) => ("id" in i && /:(alert|working|no-fix)$/.test(i.id) ? [i.id] : []));

  it("stands the older run down when the ramp counts the same van again, and shows only the newer", async () => {
    // Van 1 back to fitting first, so the scenario starts from a quiet van.
    expect((await confirmSeats(6, 1)).status).toBe(200);
    expect((await confirmSeats(1)).status).toBe(200);
    const first = (await runsOn()).at(-1)!;
    expect((await confirmSeats(1, 2)).status).toBe(200);
    const [older, newer] = (await runsOn()).slice(-2);
    expect(older).toEqual({ task_id: first.task_id, state: "ABORTED_SUPERSEDED_BY_HUMAN" });
    expect(newer.state).toBe("QUEUED");
    expect(await shownAlerts()).toEqual([`${newer.task_id}:alert`, `${newer.task_id}:working`]);
  });

  it("stands down when the van fits again, and the bubble goes quiet about it", async () => {
    expect((await confirmSeats(6, 1)).status).toBe(200);
    expect((await runsOn()).at(-1)!.state).toBe("ABORTED_SUPERSEDED_BY_HUMAN");
    expect(await shownAlerts()).toEqual([]);
  });
});

describe("a card closes the loop, steps aside when the board moved, and can be talked about (ledger #75 c — C5, C6)", () => {
  const thread = async () => (await readAgentThread(db, SITE)).items;

  it("leaves one line saying how it went where the confirmed card was", async () => {
    const card = (await db.query<{ id: string }>(
      "SELECT id FROM ops.approval_request WHERE proposal->>'kind' = 'STAFF_ACTION' AND decision = 'APPROVED' ORDER BY decided_at LIMIT 1", [],
    )).rows[0];
    const done = (await thread()).find((i) => "id" in i && i.id === `${card.id}:done`);
    expect(done).toMatchObject({ kind: "agent", text: expect.stringMatching(/^Done\. Every van fits(, and \d+ families were texted a new time)?\.$/) });
  });

  it("does not offer a plan card the board was saved past, and says it was handled", async () => {
    // Van 1 short again, and a person presses Re-plan: one draft card waits.
    expect((await ACTIONS.confirm_van_setup.run(ctx(people.frontDesk, "FRONT_DESK"), {
      ...defaultsOfSlot(1), seats: 1, oxygenMounts: 0, vanId: vanIdOfSlot(1), date: DATE, state: "CHECKED" as const,
    })).status).toBe(200);
    expect((await ACTIONS.auto_plan.run(ctx(people.director, "DIRECTOR"), { date: DATE, direction: "PM" })).body).toMatchObject({ drafted: true });
    const pending = (await confirmCards(db, SITE)).map((c) => c.approvalId);
    expect(pending.length).toBeGreaterThan(0);
    // A person re-plans the afternoon on the board before pressing anything.
    expect((await saveAutoPlan(ctx(people.director, "DIRECTOR"), DATE, "PM")).status).toBe(200);
    expect(await confirmCards(db, SITE)).toEqual([]);
    const items = await thread();
    for (const id of pending) {
      expect(items.find((i) => "id" in i && i.id === `${id}:done`)).toMatchObject({ text: confirmCopy.alreadyHandled });
      expect(items.find((i) => "id" in i && i.id === id)).toBeUndefined();
    }
  });

  it("reads an ask typed after an alert as a reply to it", async () => {
    const r = await askAgent(db, { siteId: SITE, text: "why not van 2?", by: `staff:${people.director}` }, {
      env: ENV,
      runner: () => ({ ok: true as const, refused: false, reason: null, deps: {} as never }),
      wake: { publish: async () => {} },
    });
    if (r.outcome !== "working") throw new Error(r.outcome);
    const assembled = await dbContextAssembler(db, { env: ENV })({
      runId: r.runId, trigger: { type: "staff.ask", id: r.taskId, siteId: SITE }, committed: [], now: new Date(),
    });
    expect(JSON.stringify(assembled.prompt)).toMatch(/following_up_on_alert=\\"Van 1 no longer fits/);
    // It is told to look before answering, and is not handed internal leg states to repeat.
    expect(assembled.prompt).toContain("look_first=get_activity");
    expect(assembled.prompt).not.toMatch(/leg=\S+ child=\S+ part=\S+ state=/);
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
