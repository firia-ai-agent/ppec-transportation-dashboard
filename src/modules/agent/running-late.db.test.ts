import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/db/exec";
import { seedStandardScenario } from "@/modules/demo/seed";
import { childTokenOf } from "@/modules/demo/fixtures/standard";
import { freshPlanDb, SITE } from "@/test/pglite";
import { ALERT_TRIGGER } from "./alerts";
import { RUNNING_LATE_TASK_CATEGORY, raiseRunningLateAlerts } from "./running-late";
import type { AgentWake, AgentWakeTransport } from "./run/wake";
import { ACTIONS, type ActionCtx } from "@/modules/actions/registry";
import { actionDepsFor } from "@/modules/actions/deps";
import { loadBoard } from "@/modules/plan/store";
import { saveAutoPlan } from "@/test/save-plan";
import { seedStaff } from "@/test/messaging";

/**
 * A VAN RUNNING LATE IS AN INPUT THE AGENT HEARS (ledger #79): once per set of families told, and
 * with the children named so the run knows who it is about.
 */
let db: Db;
let close: () => Promise<void>;
const saved = { ...process.env };
const ENV = { APP_DATA_CLASS: "SYNTHETIC", DEMO_MODE: "1", HMAC_PEPPER: "p", DATA_KEY: "k" };
const NOW = new Date("2026-10-16T20:10:00.000Z");
const woken: AgentWake[] = [];
const wake: AgentWakeTransport = { publish: async (m) => void woken.push(m) };
const routing = { model: "test-model", provider: "openrouter" };

beforeAll(async () => {
  process.env = { ...saved, ...ENV };
  ({ db, close } = await freshPlanDb());
  await seedStandardScenario(db, { now: NOW, siteId: SITE, env: ENV });
}, 180_000);

afterAll(async () => {
  process.env = saved;
  await close();
});

describe("running late reaches the agent", () => {
  const late = () => [{ siteId: SITE, childToken: childTokenOf("C2"), delayMinutes: 10 }];

  it("raises one alert naming who is late, and starts the agent on it", async () => {
    expect(await raiseRunningLateAlerts(db, wake, routing, { late: late(), now: NOW, by: "system:eta-notice" })).toBe(1);
    const tasks = await db.query<{ summary: string }>("SELECT summary FROM ops.task WHERE category = $1", [RUNNING_LATE_TASK_CATEGORY]);
    expect(tasks.rows).toHaveLength(1);
    expect(tasks.rows[0].summary).toMatch(/^Running about 10 min late: .*Noah/);
    const runs = await db.query("SELECT 1 FROM ops.agent_run WHERE trigger_type = $1", [ALERT_TRIGGER]);
    expect(runs.rows).toHaveLength(1);
    expect(woken).toHaveLength(1);
  });

  it("does not raise it again for the same families", async () => {
    await raiseRunningLateAlerts(db, wake, routing, { late: late(), now: NOW, by: "system:eta-notice" });
    expect((await db.query("SELECT 1 FROM ops.task WHERE category = $1", [RUNNING_LATE_TASK_CATEGORY])).rows).toHaveLength(1);
    expect((await db.query("SELECT 1 FROM ops.agent_run WHERE trigger_type = $1", [ALERT_TRIGGER])).rows).toHaveLength(1);
  });
});

describe("a change to who rides is heard the way a save is (ledger #79)", () => {
  it("runs the van-fit check after a child is marked away", async () => {
    const director = await seedStaff(db, "DIRECTOR", SITE);
    const heard: unknown[] = [];
    const ctx: ActionCtx = {
      siteId: SITE, caller: { userId: director, role: "DIRECTOR" }, now: NOW,
      deps: { ...actionDepsFor(db, SITE), vanShort: async (input) => void heard.push(input) },
    };
    expect((await saveAutoPlan(ctx, "2026-10-16", "PM")).status).toBe(200);
    heard.length = 0;
    const view = await loadBoard(ctx.deps!.store!, SITE, "2026-10-16", "PM", ctx.deps!.source!);
    const answer = await ACTIONS.place_child.run(ctx, {
      date: "2026-10-16", direction: "PM", childToken: childTokenOf("C2"), bucket: "ABSENT", version: view.version,
    });
    expect(answer.status).toBe(200);
    expect(heard).toEqual([expect.objectContaining({ siteId: SITE, date: "2026-10-16" })]);
  });
});
