import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/db/exec";
import { askAgent } from "@/modules/agent/ask/staff-ask";
import { familyScope, type PolicyContext } from "@/modules/agent/policy";
import { freeText, toolCall } from "@/modules/agent/providers/fake";
import type { TierFacts } from "@/modules/agent/run/context";
import { liveHarness } from "@/modules/agent/run/exec/live-harness";
import { toolCalls } from "@/modules/agent/run/store";
import { seedStandardScenario } from "@/modules/demo/seed";
import { ridersInVan } from "@/domain/plan/board";
import { CHILDREN } from "@/modules/demo/fixtures/standard";
import { vansOver } from "@/modules/plan/place";
import { loadBoard } from "@/modules/plan/store";
import { defaultsOfSlot, vanIdOfSlot } from "@/test/board-day";
import { seedStaff } from "@/test/messaging";
import { freshPlanDb, SITE } from "@/test/pglite";
import { confirmStaffAction } from "./confirm";
import { confirmCards } from "./confirm-cards";
import { actionDepsFor } from "./deps";
import { saveAutoPlan } from "@/test/save-plan";
import { ACTIONS, type ActionCtx } from "./registry";

/**
 * THE PROD FAILURE, REPLAYED AND FIXED (ledger #74): a director asks the agent to re-plan the
 * afternoon while Van 1 is over its seats. The agent reads the board, re-plans it through the board's
 * own Auto-plan + Save as that director, and says so (S3). A front desk cannot make it re-plan (S4).
 * And an action PRD §11.2 forbids it — Restart — becomes a card that only a director's press runs (S7).
 *
 * A scripted model stands in for the vendor; everything it calls is the real catalog, the real policy
 * engine, the real executors and the real action layer over a seeded database.
 */
let db: Db;
let close: () => Promise<void>;
const saved = { ...process.env };
const ENV = { APP_DATA_CLASS: "SYNTHETIC", DEMO_MODE: "1", HMAC_PEPPER: "p", DATA_KEY: "k" };
const NOW = new Date("2026-10-16T17:45:00.000Z");
const DATE = "2026-10-16";
const people = { director: "", coordinator: "", frontDesk: "" };

const ctx = (userId: string, role: ActionCtx["caller"]["role"]): ActionCtx => ({
  siteId: SITE, caller: { userId, role }, now: NOW, deps: actionDepsFor(db, SITE),
});
const board = () => loadBoard(actionDepsFor(db, SITE).store!, SITE, DATE, "PM", actionDepsFor(db, SITE).source);

const facts: TierFacts = { t1: `site=${SITE}`, t2: `service_date=${DATE}`, t3: [], t4: "channel=SMS_1TO1" };
const policy = (): PolicyContext => ({ scope: familyScope(SITE, [], [], SITE), sendableSubjects: new Set() });

/** Ask the agent as this person, with this scripted model, through the real run loop. */
async function ask(by: string, text: string, script: Parameters<typeof liveHarness>[0]["script"]) {
  const h = liveHarness({ db, script, facts, policy: policy(), now: () => NOW });
  return askAgent(db, { siteId: SITE, text, by: `staff:${by}` }, {
    env: ENV,
    runner: () => ({ ok: true as const, refused: false, reason: null, deps: h.deps(0) }),
  });
}

beforeAll(async () => {
  process.env = { ...saved, ...ENV };
  ({ db, close } = await freshPlanDb());
  await seedStandardScenario(db, { now: NOW, siteId: SITE, env: ENV });
  people.director = await seedStaff(db, "DIRECTOR", SITE);
  people.coordinator = await seedStaff(db, "COORDINATOR", SITE);
  people.frontDesk = await seedStaff(db, "FRONT_DESK", SITE);
  // The morning of the prod failure: the afternoon planned and saved, then Van 1 confirmed short.
  expect((await saveAutoPlan(ctx(people.director, "DIRECTOR"), DATE, "PM")).status).toBe(200);
  const short = { ...defaultsOfSlot(1), seats: 2, vanId: vanIdOfSlot(1), date: DATE, state: "CHECKED" as const };
  expect((await ACTIONS.confirm_van_setup.run(ctx(people.frontDesk, "FRONT_DESK"), short)).status).toBe(200);
}, 180_000);

afterAll(async () => {
  process.env = saved;
  await close();
});

describe("asked to re-plan, the agent re-plans as the person who asked (S3)", () => {
  it("starts from the prod state: a van over its seats", async () => {
    const view = await board();
    expect(vansOver(view, view.plan)).toEqual([vanIdOfSlot(1)]);
  });

  it("previews a move before making it: what would fit, and who would get home late (ledger #75)", async () => {
    const before = await board();
    const [first] = ridersInVan(before.day, before.plan, vanIdOfSlot(1));
    const r = await ask(people.director, "what if one child came off van 1?", [
      toolCall("get_plan", { date: DATE, leg: "PM", moves: [{ child_token: first.token, bucket: "UNASSIGNED" }] }),
      toolCall("reply_to_staff", { summary: "Taking one child off Van 1 would make it fit." }),
    ]);
    if (r.outcome !== "ran") throw new Error(r.outcome);
    const [read] = await toolCalls(db, r.run.runId);
    expect((read.result as { prompt_facts: Record<string, unknown> }).prompt_facts).toMatchObject({
      preview: true,
      preview_van_1_fits: true,
      preview_home_late: expect.any(String),
    });
    // A preview saves nothing.
    expect((await board()).version).toBe(before.version);
  });

  it("reads the board and drafts the re-plan as a card — it saves nothing itself (ledger #76)", async () => {
    const before = await board();
    const r = await ask(people.director, "replan the afternoon", [
      toolCall("get_plan", { date: DATE, leg: "PM" }),
      toolCall("auto_plan", { date: DATE, leg: "PM" }),
      toolCall("reply_to_staff", { summary: "I've drafted a re-plan so every van fits. Approve it to save." }),
    ]);
    expect(r.outcome === "ran" && r.answer).toBe("I've drafted a re-plan so every van fits. Approve it to save.");
    if (r.outcome !== "ran") return;
    const calls = await toolCalls(db, r.run.runId);
    expect(calls.map((c) => [c.tool, c.status])).toEqual([
      ["get_plan", "EXECUTED"],
      ["auto_plan", "EXECUTED"],
      ["reply_to_staff", "EXECUTED"],
    ]);
    // What the model read before acting: Van 1 over its seats, in the board's own numbers.
    const facts = (i: number) => (calls[i].result as { prompt_facts: Record<string, unknown> }).prompt_facts;
    expect(String(facts(0).van_1)).toMatch(/seats=3\/2 .*fits=false/);
    expect(facts(1)).toMatchObject({ action: "auto_plan", ok: true });
    // Nothing saved: the plan is exactly as it was.
    expect((await board()).version).toBe(before.version);

    // The card says what it would do to the day, in lines generated from the plan.
    const [card] = await confirmCards(db, SITE);
    expect(card.summary).toBe("Re-plan the afternoon");
    expect(card.impact.some((line) => /→ Van \d · ≈ \d{1,2}:\d{2} (AM|PM)/.test(line))).toBe(true);
    expect(card.impact).toContain("Every van fits");
  });

  it("saves exactly that draft, as the director who approves it", async () => {
    const before = await board();
    const [card] = await confirmCards(db, SITE);
    expect(await confirmStaffAction(db, { userId: people.director, approvalId: card.approvalId, decision: "APPROVED", now: NOW }))
      .toEqual({ status: 200, body: { ok: true, decision: "APPROVED" } });
    const after = await board();
    expect(vansOver(after, after.plan)).toEqual([]);
    expect(after.version).toBe(before.version + 1);
    const saver = await db.query<{ saved_by: string }>(
      "SELECT saved_by::text AS saved_by FROM ops.plan_run WHERE site_id = $1 AND service_date = $2 AND direction = 'PM'",
      [SITE, DATE],
    );
    expect(saver.rows[0].saved_by).toBe(people.director);
  });
});

describe("asked what was just done, the agent can look (ledger #76)", () => {
  it("reads today's events in time order: the draft, the approval and the save", async () => {
    const r = await ask(people.director, "what was just done?", [
      toolCall("get_activity", {}),
      toolCall("reply_to_staff", { summary: "We moved a child so every van fits, and you approved it." }),
    ]);
    if (r.outcome !== "ran") throw new Error(r.outcome);
    const [read] = await toolCalls(db, r.run.runId);
    const facts = Object.values((read.result as { prompt_facts: Record<string, unknown> }).prompt_facts).map(String).join("\n");
    expect(facts).toMatch(/approved "Re-plan the afternoon"/);
    expect(facts).toMatch(/saved the afternoon plan/);
    expect(facts).not.toMatch(/PROVISIONAL|SCHEDULED/);
    // People reach the model as tokens, never names (PRD; else the reply's own redaction wipes them).
    for (const child of CHILDREN) expect(facts, child.label).not.toContain(child.label);
  });
});

describe("a slip is feedback, not the end of a person's run (ledger #77)", () => {
  const callsOf = async (runId: string) => (await toolCalls(db, runId)).map((c) => [c.tool, c.status, (c.result as { prompt_facts?: Record<string, unknown> } | null)?.prompt_facts?.refused ?? null]);

  it("hears prose instead of a tool call, is told to use reply, and answers", async () => {
    const r = await ask(people.director, "let's plan the afternoon routes", [
      freeText("Sure, let me look at the afternoon."),
      toolCall("reply_to_staff", { summary: "The afternoon is planned and every van fits." }),
    ]);
    expect(r.outcome === "ran" && r.answer).toBe("The afternoon is planned and every van fits.");
    if (r.outcome !== "ran") return;
    expect(await callsOf(r.run.runId)).toEqual([
      ["none", "FAILED", "REJECTED_FREE_TEXT"],
      ["reply_to_staff", "EXECUTED", null],
    ]);
  });

  it("is told which argument was wrong, and tries again", async () => {
    const r = await ask(people.director, "what's on the afternoon plan?", [
      toolCall("get_plan", { date: "tomorrow", leg: "PM" }),
      toolCall("get_plan", { date: DATE, leg: "PM" }),
      toolCall("reply_to_staff", { summary: "Every van fits this afternoon." }),
    ]);
    if (r.outcome !== "ran") throw new Error(r.outcome);
    expect((await callsOf(r.run.runId)).map((c) => c.slice(0, 2))).toEqual([
      ["get_plan", "FAILED"],
      ["get_plan", "EXECUTED"],
      ["reply_to_staff", "EXECUTED"],
    ]);
  });

  it("has room for more than eight steps, and a run that still fails says why", async () => {
    const reads = Array.from({ length: 10 }, () => toolCall("get_activity", {}));
    const ok = await ask(people.director, "look around, then tell me", [...reads, toolCall("reply_to_staff", { summary: "All quiet." })]);
    expect(ok.outcome === "ran" && ok.answer).toBe("All quiet.");

    const slips = Array.from({ length: 20 }, () => freeText("hmm"));
    const failed = await ask(people.director, "keep talking", slips);
    expect(failed.outcome).toBe("unavailable");
    const run = await db.query<{ reason: string | null }>(
      "SELECT reason FROM ops.agent_run WHERE trigger_type = 'staff.ask' AND state = 'FAILED' ORDER BY created_at DESC LIMIT 1", [],
    );
    expect(run.rows[0].reason).toMatch(/step budget of 16/);
  });
});

describe("the agent can only do what the asker's role can (S4)", () => {
  it("refuses the front desk's re-plan exactly as the board does, and saves nothing", async () => {
    const before = await board();
    const r = await ask(people.frontDesk, "replan the afternoon", [toolCall("auto_plan", { date: DATE, leg: "PM" })]);
    expect(r.outcome).toBe("unavailable");
    const calls = await db.query<{ status: string; result: { error_code?: string } }>(
      `SELECT c.status, c.result FROM ops.agent_tool_call c JOIN ops.agent_run r ON r.id = c.run_id
        WHERE r.trigger_type = 'staff.ask' AND c.tool = 'auto_plan' ORDER BY c.created_at DESC LIMIT 1`,
      [],
    );
    expect(calls.rows[0]).toMatchObject({ status: "FAILED", result: { error_code: "NOT_YOUR_ROLE" } });
    expect((await board()).version).toBe(before.version);
  });
});

describe("Restart is a card a person presses, and only a director's press runs it (S7)", () => {
  let cardId = "";

  it("proposes the card and changes nothing", async () => {
    const before = await board();
    const r = await ask(people.director, "restart the day", [toolCall("restart_demo_day", {})]);
    expect(r.outcome === "ran" && r.proposalId).toBeTruthy();
    if (r.outcome !== "ran" || !r.proposalId) return;
    cardId = r.proposalId;
    const card = await db.query<{ proposal: Record<string, unknown>; decided_at: Date | null }>(
      "SELECT proposal, decided_at FROM ops.approval_request WHERE id = $1",
      [cardId],
    );
    expect(card.rows[0]).toMatchObject({ proposal: { kind: "STAFF_ACTION", tool: "restart_demo_day" }, decided_at: null });
    expect((await board()).version).toBe(before.version);
  });

  it("refuses a coordinator's press — they cannot Restart either — and leaves the card pending", async () => {
    expect(await confirmStaffAction(db, { userId: people.coordinator, approvalId: cardId, decision: "APPROVED", now: NOW }))
      .toMatchObject({ status: 403, body: { error: "NOT_YOUR_ROLE" } });
    const card = await db.query<{ decided_at: Date | null }>("SELECT decided_at FROM ops.approval_request WHERE id = $1", [cardId]);
    expect(card.rows[0].decided_at).toBeNull();
  });

  it("runs the Restart on the director's press, as the director", async () => {
    expect(await confirmStaffAction(db, { userId: people.director, approvalId: cardId, decision: "APPROVED", now: NOW }))
      .toEqual({ status: 200, body: { ok: true, decision: "APPROVED" } });
    // Restart clears the day's saved plan (demo/seed.ts RESET_TABLES): the board is unplanned again.
    expect((await board()).version).toBe(0);
  });
});
