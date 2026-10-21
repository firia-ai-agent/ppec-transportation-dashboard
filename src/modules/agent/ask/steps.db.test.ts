import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/db/exec";
import { seedStandardScenario } from "@/modules/demo/seed";
import { seedStaff } from "@/test/messaging";
import { freshPlanDb, SITE } from "@/test/pglite";
import { agentSteps } from "@/ui/copy";
import { commitCall, persistCall } from "../run/store";
import { AGENT_RETRY_JOB_KIND } from "../run/timers";
import { askAgent } from "./staff-ask";
import { readAgentThread } from "./thread";

/** "Show it's thinking" (ledger #87): a quiet line per step while an ask's run works, none after. */
let db: Db;
let close: () => Promise<void>;
const ENV = { APP_DATA_CLASS: "SYNTHETIC", DEMO_MODE: "1", HMAC_PEPPER: "p", DATA_KEY: "k" };
let director = "";

beforeAll(async () => {
  ({ db, close } = await freshPlanDb());
  await seedStandardScenario(db, { now: new Date(), siteId: SITE, env: ENV });
  director = await seedStaff(db, "DIRECTOR", SITE);
}, 180_000);

afterAll(async () => {
  await close();
});

const thread = async (taskId: string) =>
  (await readAgentThread(db, SITE)).items
    .filter((i) => "id" in i && i.id.startsWith(taskId))
    .map((i) => [i.kind, "text" in i ? i.text : ""]);

async function ask(text: string) {
  const r = await askAgent(db, { siteId: SITE, text, by: `staff:${director}` }, {
    env: ENV,
    runner: () => ({ ok: true as const, refused: false, reason: null, deps: {} as never }),
    wake: { publish: async () => {} },
  });
  if (r.outcome !== "working") throw new Error(r.outcome);
  return r;
}

async function step(runId: string, seq: number, tool: string, args: Record<string, unknown>, result: Record<string, unknown> = { prompt_facts: {} }) {
  const row = await persistCall(db, { runId, siteId: SITE, seq, tool, args, storeArgs: args, policyDecision: "ALLOW" });
  expect(await commitCall(db, row.id, result.error_code ? "FAILED" : "EXECUTED", result, "test")).toBe(true);
}

const state = (runId: string, to: string) => db.query("UPDATE ops.agent_run SET state = $2 WHERE id = $1", [runId, to]);

describe("the agent's steps, while it works (ledger #87)", () => {
  it("shows one quiet line per step, what it is doing now, and none once the run has finished", async () => {
    const r = await ask("plan routes for today");
    await step(r.runId, 0, "get_activity", {});
    await step(r.runId, 1, "get_plan", { leg: "AM" });
    await state(r.runId, "RUNNING");

    expect(await thread(r.taskId)).toEqual([
      ["staff", "plan routes for today"],
      ["step", agentSteps.get_activity],
      ["step", "Reading the morning plan…"],
      ["agent", agentSteps.default],
    ]);

    await state(r.runId, "SUCCEEDED");
    expect((await thread(r.taskId)).some(([kind]) => kind === "step")).toBe(false);
  });

  it("says something true before the first step: queued, then looking at the plan the prompt carries", async () => {
    const r = await ask("yeah do it");
    expect((await thread(r.taskId)).at(-1)).toEqual(["agent", agentSteps.starting]);
    await state(r.runId, "RUNNING");
    expect((await thread(r.taskId)).at(-1)).toEqual(["agent", agentSteps.firstLook]);
  });

  it("says the model is busy while the run is parked for a retry", async () => {
    const r = await ask("what's in van 2?");
    await state(r.runId, "RUNNING");
    await state(r.runId, "WAITING_TOOL");
    await db.query(
      `INSERT INTO ops.job (id, site_id, key, kind, payload, due_at, created_by, updated_by, source_mode)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, now() + interval '1 minute', 'test', 'test', 'SIMULATED')`,
      [SITE, `${AGENT_RETRY_JOB_KIND}:${r.runId}:0`, AGENT_RETRY_JOB_KIND, JSON.stringify({ runId: r.runId, attempt: 0 })],
    );
    expect((await thread(r.taskId)).at(-1)).toEqual(["agent", agentSteps.modelBusy]);
  });

  it("says the same step once, and never a slipped turn", async () => {
    const r = await ask("does van 2 fit?");
    await step(r.runId, 0, "get_plan", { leg: "PM" });
    await step(r.runId, 1, "get_plan", { leg: "PM", preview: { moves: [] } });
    await step(r.runId, 2, "propose_plan_change", {}, { error_code: "REJECTED_INVALID_ARGS", prompt_facts: {} });
    await step(r.runId, 3, "get_plan", { leg: "PM" });
    await state(r.runId, "RUNNING");
    expect((await thread(r.taskId)).filter(([kind]) => kind === "step")).toEqual([["step", "Reading the afternoon plan…"]]);
  });
});
