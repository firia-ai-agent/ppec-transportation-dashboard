/**
 * TRIAGE (ledger #85): the fast model reads a family's text first. FYI / NOISE end the run before
 * the full agent spends a turn; PLAN_* and any triage failure are the full run, unchanged. Scripted
 * end to end (`FakeProvider`), against a real database.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { Db } from "@/db/exec";
import { TEST_NOW } from "@/test/clock";
import { SITE, freshDb } from "@/test/pglite";
import { createGateway } from "../gateway";
import { fakeProvider, toolCall } from "../providers/fake";
import type { LlmProvider } from "../providers/provider";
import { TRIAGE_TOOL } from "../tools";
import { AT01_EXECUTORS, AT01_FACTS, AT01_SCRIPT, at01Policy, runHarness } from "./harness";
import { startAndDriveRun } from "./loop";
import { triagePrompt } from "./triage";
import type { Trigger } from "./triggers";

const TRIGGER: Trigger = { type: "msg.inbound", id: "MSG-1", siteId: SITE };

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

const classify = (relevance: string) => ({
  ...toolCall(TRIAGE_TOOL, { relevance, intent: relevance === "FYI" ? "THANKS" : "DROPOFF_TIME", child_tokens: [], confidence: 0.9 }),
  usage: { inputTokens: 120, outputTokens: 9 },
});

/** The AT-01 run, with a triage gateway over `triage` beside its own. */
function drive(triage: LlmProvider | null) {
  const harness = runHarness({ db, script: AT01_SCRIPT, facts: AT01_FACTS, policy: at01Policy(), overrides: AT01_EXECUTORS, now: () => now });
  const deps = harness.deps(0);
  return startAndDriveRun(
    triage ? { ...deps, triage: { gateway: createGateway(triage, harness.config, { now: () => now.getTime() }) } } : deps,
    TRIGGER,
  );
}

const toolCallCount = async (runId: string) =>
  (await db.query<{ n: number }>("SELECT count(*)::int AS n FROM ops.agent_tool_call WHERE run_id = $1", [runId])).rows[0].n;
const runRow = async (runId: string) =>
  (await db.query<{ state: string; tokens_in: number | null; tokens_out: number | null }>(
    "SELECT state, tokens_in, tokens_out FROM ops.agent_run WHERE id = $1", [runId])).rows[0];

describe("the fast model reads a family's text first (ledger #85)", () => {
  it("ends an FYI text at triage: no full turn, no tool call, the cost recorded, the verdict audited", async () => {
    const r = await drive(fakeProvider([classify("FYI")]));
    expect(r.state).toBe("SUCCEEDED");
    expect(r.reason).toBe("triage: FYI");
    expect(await toolCallCount(r.runId)).toBe(0);
    expect(await runRow(r.runId)).toMatchObject({ state: "SUCCEEDED", tokens_in: 120, tokens_out: 9 });
    const audit = await db.query<{ detail: Record<string, unknown> }>(
      "SELECT detail FROM ops.audit_event WHERE action = 'agent.triage' AND entity_id = $1", [TRIGGER.id]);
    expect(audit.rows.map((row) => row.detail)).toEqual([{ relevance: "FYI", intent: "THANKS", children: 0, confidence: 0.9 }]);
  });

  it("ends NOISE the same way", async () => {
    const r = await drive(fakeProvider([classify("NOISE")]));
    expect(r.state).toBe("SUCCEEDED");
    expect(await toolCallCount(r.runId)).toBe(0);
  });

  it("hands a text about today's rides to the full agent, which runs as it always did", async () => {
    const plain = await drive(null);
    await db.query("DELETE FROM ops.agent_tool_call", []);
    await db.query("DELETE FROM ops.agent_run", []);
    const r = await drive(fakeProvider([classify("PLAN_TODAY")]));
    expect(r.state).toBe(plain.state);
    expect(await toolCallCount(r.runId)).toBe(plain.steps);
    expect(plain.steps).toBeGreaterThan(0);
  });

  it("is the full run when triage is down — never a rule of its own", async () => {
    const down: LlmProvider = {
      ...fakeProvider([]),
      invoke: async () => {
        throw new Error("provider unreachable");
      },
    };
    const r = await drive(down);
    expect(await toolCallCount(r.runId)).toBeGreaterThan(0);
  });

  it("asks with the full run's own tiers and only the task swapped", () => {
    const prompt = ["role=x", "T1 a", "T3 <untrusted_user_message>hi</untrusted_user_message>", "task=choose exactly one tool call", "guide=do things"].join("\n");
    const triaged = triagePrompt(prompt);
    expect(triaged).toContain("T3 <untrusted_user_message>hi</untrusted_user_message>");
    expect(triaged).not.toContain("guide=do things");
    expect(triaged).toContain(`task=call ${TRIAGE_TOOL} once`);
  });
});
