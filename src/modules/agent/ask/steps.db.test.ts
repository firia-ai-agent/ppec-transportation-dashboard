import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/db/exec";
import { seedStandardScenario } from "@/modules/demo/seed";
import { seedStaff } from "@/test/messaging";
import { freshPlanDb, SITE } from "@/test/pglite";
import { agentBubble, agentSteps } from "@/ui/copy";
import { commitCall, persistCall } from "../run/store";
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

describe("the agent's steps, while it works (ledger #87)", () => {
  it("shows one quiet line per step, then Working on it…, and none once the run has finished", async () => {
    const r = await askAgent(db, { siteId: SITE, text: "plan routes for today", by: `staff:${director}` }, {
      env: ENV,
      runner: () => ({ ok: true as const, refused: false, reason: null, deps: {} as never }),
      wake: { publish: async () => {} },
    });
    if (r.outcome !== "working") throw new Error(r.outcome);
    for (const [seq, tool, args] of [[0, "get_activity", {}], [1, "get_plan", { leg: "AM" }]] as const) {
      const row = await persistCall(db, { runId: r.runId, siteId: SITE, seq, tool, args, storeArgs: args, policyDecision: "ALLOW" });
      expect(await commitCall(db, row.id, "EXECUTED", { prompt_facts: {} }, "test")).toBe(true);
    }
    await db.query("UPDATE ops.agent_run SET state = 'RUNNING' WHERE id = $1", [r.runId]);

    const working = (await readAgentThread(db, SITE)).items.filter((i) => "id" in i && i.id.startsWith(r.taskId));
    expect(working.map((i) => [i.kind, "text" in i ? i.text : ""])).toEqual([
      ["staff", "plan routes for today"],
      ["step", agentSteps.get_activity],
      ["step", "Reading the morning plan…"],
      ["agent", agentBubble.working],
    ]);

    await db.query("UPDATE ops.agent_run SET state = 'SUCCEEDED' WHERE id = $1", [r.runId]);
    const after = (await readAgentThread(db, SITE)).items.filter((i) => "id" in i && i.id.startsWith(r.taskId));
    expect(after.some((i) => i.kind === "step")).toBe(false);
  });
});
