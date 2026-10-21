/**
 * THE AGENT FINISHES THE JOB (ledger #87). Traced on prod: "plan routes for today" took 10 steps —
 * three reads refused for arriving together, the same empty read six times, then a reply promising a
 * plan the run could no longer make. Each piece of the fix, against the real loop and a real database.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { Db } from "@/db/exec";
import { departuresOf } from "@/domain/plan/arrivals";
import type { BoardPlan } from "@/domain/plan/board";
import { previewPlanChange } from "@/modules/changes/plan-change";
import type { BoardView } from "@/modules/plan/store";
import { testDay, scenarioPlan } from "@/test/board-day";
import { TEST_NOW } from "@/test/clock";
import { SITE, freshDb } from "@/test/pglite";
import { agentGuidance, agentSteps } from "@/ui/copy";
import { createGateway, GatewayError } from "../gateway";
import { loadAgentConfig } from "../config";
import { fakeProvider, toolCall } from "../providers/fake";
import { normalize, userContent } from "../providers/remote";
import { stepWords } from "../ask/thread";
import { AT01_FACTS, AT01_NOTE, at01Policy, runHarness } from "./harness";
import { tierPromptBlocks } from "./context";
import { teamPlanChange } from "./exec/team";
import { riderFacts } from "./plan-facts";
import { startAndDriveRun } from "./loop";
import type { Trigger } from "./triggers";

const TRIGGER: Trigger = { type: "msg.inbound", id: "MSG-1", siteId: SITE };
const READS = ["get_leg_state", "resolve_sender", "read_guardian_thread", "summarize_thread_for_staff"];

describe("one plan tool, two named Auto-plans", () => {
  it("whole_leg plans an empty morning from scratch: every child placed", async () => {
    const day = await testDay("AM");
    const empty: BoardPlan = Object.fromEntries(day.riders.map((r) => [r.token, { bucket: "UNASSIGNED" as const, vanId: null, pinned: false }]));
    const view = { day, plan: empty, departs: departuresOf(day), version: 0 } as unknown as BoardView;
    const preview = previewPlanChange(view, teamPlanChange(view, { auto_plan: "whole_leg" }).change);
    if (!preview.ok) throw new Error(preview.reason);
    expect(preview.stranded).toEqual([]);
    expect(day.riders.every((r) => preview.next[r.token]?.bucket === "VAN")).toBe(true);
  });

  it("fix_fit moves nobody when every van already fits — it is the smallest change, not a fresh plan", async () => {
    const day = await testDay("PM");
    const view = { day, plan: scenarioPlan(day), departs: departuresOf(day), version: 1 } as unknown as BoardView;
    expect(previewPlanChange(view, teamPlanChange(view, { auto_plan: "fix_fit" }).change)).toMatchObject({ ok: false, reason: "NOTHING_TO_CHANGE" });
  });

  it("still reads a stored card's legacy replan as the fix, and says the difference in plain words", async () => {
    const day = await testDay("PM");
    const view = { day, plan: scenarioPlan(day), departs: departuresOf(day), version: 1 } as unknown as BoardView;
    expect(teamPlanChange(view, { replan: true }).change.auto).toBe("FIX_FIT");
    expect(agentGuidance.proposePlanChange).toMatch(/plan the routes for a leg, set auto_plan to whole_leg/);
    expect(agentGuidance.replyToStaff).toMatch(/This ends your turn/);
  });
});

describe("context up front", () => {
  it("names what placing an unassigned child needs, so there is nobody to look up", () => {
    expect(riderFacts({ name: "Mia R.", needs: { carSeat: true, wheelchair: false }, stopLabel: "Greenacres Branch Library", window: "07:30" }))
      .toMatch(/^Mia R\. \(carSeat; stop Greenacres Branch Library; window 7:30/);
  });
});

describe("the loop: reads together, no repeated reads, cacheable prompts", () => {
  let pg: PGlite;
  let db: Db;
  const open: PGlite[] = [];
  const now = new Date(TEST_NOW);
  beforeEach(async () => {
    ({ pg, db } = await freshDb());
    open.push(pg);
  }, 60_000);
  afterEach(async () => {
    await Promise.all(open.splice(0).map((h) => h.close().catch(() => {})));
  });

  const ran = (script: Parameters<typeof runHarness>[0]["script"], prompts?: string[][]) => {
    const harness = runHarness({
      db, script, facts: AT01_FACTS, policy: at01Policy(), tools: READS, now: () => now,
      overrides: {
        get_leg_state: async () => ({ data: {}, promptFacts: { leg_state: "SCHEDULED" } }),
        resolve_sender: async () => ({ data: {}, promptFacts: { child: "C1" } }),
        read_guardian_thread: async () => ({ data: {}, promptFacts: { messages: 1 } }),
        summarize_thread_for_staff: async () => ({ data: { note: "stored" }, done: true }),
      },
    });
    const deps = harness.deps(0);
    const assemble = deps.assemble;
    return startAndDriveRun(
      prompts ? { ...deps, assemble: async (input) => { const a = await assemble(input); prompts.push([...(a.promptBlocks ?? [])]); return a; } } : deps,
      TRIGGER,
    );
  };
  const rows = async (runId: string) =>
    (await db.query<{ seq: number; tool: string; status: string; result: Record<string, unknown> | null }>(
      "SELECT seq, tool, status, result FROM ops.agent_tool_call WHERE run_id = $1 ORDER BY seq", [runId])).rows;

  it("takes several reads in one turn: one row each, in order, all executed", async () => {
    const batch = { tool_calls: [
      { name: "get_leg_state", arguments: { leg_id: "L-C1-AM" } },
      { name: "resolve_sender", arguments: { message_id: "MSG-1" } },
      { name: "read_guardian_thread", arguments: { thread_id: "TH-F1", count: 3 } },
    ] };
    const r = await ran([batch, AT01_NOTE]);
    expect(r.state).toBe("SUCCEEDED");
    expect((await rows(r.runId)).map((x) => [x.seq, x.tool, x.status])).toEqual([
      [0, "get_leg_state", "EXECUTED"], [1, "resolve_sender", "EXECUTED"], [2, "read_guardian_thread", "EXECUTED"],
      [3, "summarize_thread_for_staff", "EXECUTED"],
    ]);
  });

  it("still refuses a turn that mixes a write in with reads", async () => {
    const gateway = createGateway(fakeProvider([{ tool_calls: [
      { name: "get_leg_state", arguments: { leg_id: "L-C1-AM" } },
      { name: "summarize_thread_for_staff", arguments: { thread_id: "TH-F1", summary: "a note" } },
    ] }]), loadAgentConfig({}));
    await expect(gateway.complete({ runId: "r", prompt: "p", tools: READS })).rejects.toMatchObject({ outcome: "REJECTED_MULTIPLE_CALLS" } satisfies Partial<GatewayError>);
  });

  it("answers a repeated identical read by pointing at the first, without running it again", async () => {
    let calls = 0;
    const harness = runHarness({
      db, script: [toolCall("get_leg_state", { leg_id: "L-C1-AM" }), toolCall("get_leg_state", { leg_id: "L-C1-AM" }), AT01_NOTE],
      facts: AT01_FACTS, policy: at01Policy(), tools: READS, now: () => now,
      overrides: {
        get_leg_state: async () => { calls += 1; return { data: {}, promptFacts: { leg_state: "SCHEDULED" } }; },
        summarize_thread_for_staff: async () => ({ data: { note: "stored" }, done: true }),
      },
    });
    const r = await startAndDriveRun(harness.deps(0), TRIGGER);
    expect(calls).toBe(1);
    expect((await rows(r.runId))[1]).toMatchObject({ tool: "get_leg_state", status: "EXECUTED", result: { prompt_facts: { same_as_seq: 0 } } });
  });

  it("builds each turn's prompt as the last one plus new results, so a provider can cache it", async () => {
    const prompts: string[][] = [];
    await ran([toolCall("get_leg_state", { leg_id: "L-C1-AM" }), toolCall("resolve_sender", { message_id: "MSG-1" }), AT01_NOTE], prompts);
    expect(prompts.length).toBe(3);
    for (let i = 1; i < prompts.length; i++) expect(prompts[i].slice(0, prompts[i - 1].length)).toEqual(prompts[i - 1]);
    expect(tierPromptBlocks(AT01_FACTS, { runId: "r", trigger: TRIGGER, committed: [], now }).length).toBe(1);
  });
});

describe("the request caches, and says what it read from the cache", () => {
  it("marks the first and last blocks, and joins back to the exact prompt", () => {
    const blocks = ["standing context", "result seq=0 a", "result seq=1 b"];
    const content = userContent({ prompt: blocks.join("\n"), promptBlocks: blocks }) as { text: string; cache_control?: unknown }[];
    expect(content.map((c) => c.text).join("")).toBe(blocks.join("\n"));
    expect(content.map((c) => Boolean(c.cache_control))).toEqual([true, false, true]);
    expect(userContent({ prompt: "plain" })).toBe("plain");
  });

  it("keeps the cached-token count from the vendor's envelope", () => {
    const body = normalize({
      choices: [{ message: { tool_calls: [{ function: { name: "get_plan", arguments: "{}" } }] } }],
      usage: { prompt_tokens: 3000, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 2600 } },
    });
    expect(body?.usage).toEqual({ inputTokens: 3000, outputTokens: 20, cachedInputTokens: 2600 });
  });
});

describe("a quiet line per step while it works", () => {
  it("says what each step is doing, in fixed words", () => {
    expect(stepWords("get_activity", null)).toBe(agentSteps.get_activity);
    expect(stepWords("get_plan", "AM")).toBe("Reading the morning plan…");
    expect(stepWords("propose_plan_change", "PM")).toBe(agentSteps.propose_plan_change);
    expect(stepWords("propose_van_setup", null)).toBe(agentSteps.card);
    expect(stepWords("resolve_sender", null)).toBe(agentSteps.default);
  });
});
