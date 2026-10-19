/**
 * A REFUSED STEP IS FEEDBACK FOR A PERSON'S RUN, AND STILL FAILS A FAMILY'S RUN SHUT
 * (user ruling 2026-10-18, ledger #74).
 *
 * The policy engine's verdict is unchanged: an out-of-scope call is BLOCKED, recorded, executes
 * nothing and opens its staff task. What changes is what the *run* does next. A family's text
 * (`msg.inbound`) still ends FAILED on the first refusal — a hijacked thread must not be able to
 * keep steering the loop. A staff member's ask carries on: the model is told the step was refused
 * (`refused=<rule>` in its next prompt) and gets its remaining turns to answer another way.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { Db } from "@/db/exec";
import { TEST_NOW } from "@/test/clock";
import { SITE, freshDb } from "@/test/pglite";
import { fakeProvider, toolCall } from "../providers/fake";
import type { LlmProvider, ProviderCall } from "../providers/provider";
import { AT01_EXECUTORS, AT01_FACTS, AT01_NOTE, AT01_READ, at01Policy, runHarness } from "./harness";
import type { Trigger } from "./triggers";

const OUT_OF_SCOPE = toolCall("get_leg_state", { leg_id: "L-C9-AM" });

let pg: PGlite;
let db: Db;
beforeEach(async () => {
  ({ pg, db } = await freshDb());
}, 60_000);
afterEach(async () => {
  await pg.close().catch(() => {});
});

/** The scripted model, recording every prompt it was sent. */
function promptRecorder(script: Parameters<typeof fakeProvider>[0]): { provider: (offset: number) => LlmProvider; prompts: string[] } {
  const prompts: string[] = [];
  return {
    prompts,
    provider: (offset) => {
      const inner = fakeProvider(script.slice(offset));
      return { ...inner, invoke: (call: ProviderCall) => (prompts.push(call.prompt), inner.invoke(call)) };
    },
  };
}

const harness = (script: Parameters<typeof fakeProvider>[0], provider?: (offset: number) => LlmProvider) =>
  runHarness({
    db, script, facts: AT01_FACTS, policy: at01Policy(), overrides: AT01_EXECUTORS,
    now: () => new Date(TEST_NOW), provider,
  });

const calls = async (runId: string) =>
  (await db.query<{ tool: string; status: string; result: Record<string, unknown> | null }>(
    "SELECT tool, status, result FROM ops.agent_tool_call WHERE run_id = $1 ORDER BY seq", [runId],
  )).rows;

describe("a staff ask whose step is refused carries on (S1)", () => {
  const ASK: Trigger = { type: "staff.ask", id: "01900000-0000-7000-8000-00000000a5c1", siteId: SITE };

  it("records the refusal, tells the model why, and lets it answer another way", async () => {
    const model = promptRecorder([OUT_OF_SCOPE, AT01_READ, AT01_NOTE]);
    const r = await harness([OUT_OF_SCOPE, AT01_READ, AT01_NOTE], model.provider).start(ASK);

    expect(r.state).toBe("SUCCEEDED");
    expect((await calls(r.runId)).map((c) => [c.tool, c.status])).toEqual([
      ["get_leg_state", "BLOCKED"],
      ["get_leg_state", "EXECUTED"],
      ["summarize_thread_for_staff", "EXECUTED"],
    ]);
    // The second turn's prompt says the first step was refused, and by which rule — a code, never
    // the reason sentence, so "no such object" and "not yours" still read the same.
    expect(model.prompts[1]).toMatch(/result seq=0 tool=get_leg_state status=BLOCKED refused=cross_family_disclosure/);
  });

  it("is still bounded: a model that keeps being refused ends the run when its turns run out", async () => {
    const r = await harness(Array.from({ length: 12 }, () => OUT_OF_SCOPE)).start(ASK);
    expect(r.state).toBe("FAILED");
    expect((await calls(r.runId)).every((c) => c.status === "BLOCKED")).toBe(true);
  });
});

describe("a family's run still fails shut on the first refusal (S2)", () => {
  it("ends FAILED after one blocked call and never takes the next turn", async () => {
    const r = await harness([OUT_OF_SCOPE, AT01_READ]).start({ type: "msg.inbound", id: "MSG-1", siteId: SITE });
    expect([r.state, r.steps]).toEqual(["FAILED", 1]);
    expect((await calls(r.runId)).map((c) => c.status)).toEqual(["BLOCKED"]);
  });
});
