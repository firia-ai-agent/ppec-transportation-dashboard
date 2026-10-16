/**
 * §11.1 "resumes from last committed result", proved the only way it can be: by killing a run at
 * every point a process can die and restarting it.
 *
 * Three crash points exist per step, and the matrix below walks all of them for all three steps:
 *
 *   before-persist   the model turn happened (or did not come back) and no row was written.
 *                    Nothing executed, so the step is simply re-taken.
 *   after-persist    the row is committed PENDING and the effect had not started. Re-driven.
 *   after-effect     the effect happened and the row never committed — the hard one. The loop
 *                    re-drives the call with the *same* idempotency key, and the sink refuses the
 *                    second attempt. That refusal is what "must not double-execute" means; nothing
 *                    above the sink can know whether the first attempt landed.
 *
 * `effects` below is that sink: one entry per idempotency key, ever, the way a unique
 * `ops.outbound_message.idempotency_key` or a version-guarded `transition()` behaves. Every case
 * asserts the run finishes with exactly three effects and three EXECUTED rows — never four.
 *
 * A "crash" is an error `isFatal` claims, which propagates instead of being recorded: the same
 * seam `FireOpts.isFatal` gives the job runner, for the same reason.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { Db } from "@/db/exec";
import { TEST_NOW } from "@/test/clock";
import { SITE, freshDb } from "@/test/pglite";
import type { PolicyDecision } from "../policy";
import { fakeProvider } from "../providers/fake";
import type { ToolExecution, ToolExecutor } from "./executors";
import {
  AT01_EXECUTORS, AT01_FACTS, AT01_SCRIPT, AT01_TOOLS, at01Policy, runHarness,
} from "./harness";
import { driveRun, tightenOnResume } from "./loop";
import { callIdempotencyKey, commitCall, loadRun, persistCall, startRun, toolCalls } from "./store";
import type { Trigger } from "./triggers";

class SimulatedCrash extends Error {}
/**
 * What this process treats as "I am gone": the injected crash, and the scripted model running out
 * of responses — which is how the harness spells "the turn never came back", the one crash that
 * happens before anything is persisted.
 */
const isFatal = (e: unknown) =>
  e instanceof SimulatedCrash || (e instanceof Error && /script exhausted/.test(e.message));

const TRIGGER: Trigger = { type: "msg.inbound", id: "MSG-1", siteId: SITE };
const ROUTING = { model: "anthropic/claude-sonnet", provider: "openrouter" };

let pg: PGlite;
let db: Db;
let now: Date;
const open: PGlite[] = [];

beforeEach(async () => {
  ({ pg, db } = await freshDb());
  open.push(pg);
  now = new Date(TEST_NOW);
}, 60_000);

afterEach(async () => {
  await Promise.all(open.splice(0).map((h) => h.close().catch(() => {})));
});

type CrashPoint = "before-persist" | "after-persist" | "after-effect";

/**
 * A harness that crashes exactly once, at `point`, during step `step`, and then behaves. The
 * crash is armed for one occurrence only, so the resume is a normal run and the test is about the
 * loop rather than about a flaky executor.
 */
function crashingHarness(point: CrashPoint, step: number) {
  /** The sink: one entry per idempotency key, ever. */
  const effects: string[] = [];
  const sunk = new Set<string>();
  let armed = true;
  let drives = 0;

  const overrides: Record<string, ToolExecutor> = {};
  AT01_TOOLS.forEach((tool, i) => {
    overrides[tool] = async (call) => {
      if (point === "after-persist" && i === step && armed) {
        armed = false;
        throw new SimulatedCrash(`process died after persisting ${tool}`);
      }
      if (!sunk.has(call.idempotencyKey)) {
        sunk.add(call.idempotencyKey);
        effects.push(call.idempotencyKey);
      }
      if (point === "after-effect" && i === step && armed) {
        armed = false;
        throw new SimulatedCrash(`process died after executing ${tool}`);
      }
      return AT01_EXECUTORS[tool]!(call) as Promise<ToolExecution>;
    };
  });

  const h = runHarness({
    db,
    script: AT01_SCRIPT,
    facts: AT01_FACTS,
    policy: at01Policy(),
    overrides,
    now: () => now,
    isFatal,
    // On the first drive only, the script runs out exactly where the crash is wanted, so the model
    // turn for `step` never returns and nothing is persisted for it.
    provider: (offset) => {
      drives += 1;
      const end = point === "before-persist" && drives === 1 ? step : undefined;
      return fakeProvider(AT01_SCRIPT.slice(offset, end));
    },
  });
  return { h, effects };
}

const rows = (runId: string) => toolCalls(db, runId);

describe("§11.1 resume: a crash at any point costs no effect and makes no second one", () => {
  const cases = (["before-persist", "after-persist", "after-effect"] as const).flatMap((point) =>
    [0, 1, 2].map((step) => [point, step] as const),
  );

  it.each(cases)("crash %s during step %i, then resume", async (point, step) => {
    const { h, effects } = crashingHarness(point, step);

    await expect(h.start(TRIGGER)).rejects.toBeInstanceOf(Error);

    // What the dead process left behind.
    const run = (await db.query<{ id: string; state: string }>("SELECT id, state FROM ops.agent_run", [])).rows[0];
    expect(run.state).toBe("RUNNING");
    const afterCrash = await rows(run.id);
    expect(afterCrash).toHaveLength(point === "before-persist" ? step : step + 1);
    if (point !== "before-persist") {
      // Persist-before-execute, seen from the other side: the interrupted step is on disk, PENDING.
      expect([afterCrash[step].status, afterCrash[step].committedAt]).toEqual(["PENDING", null]);
      expect(afterCrash[step].idempotencyKey).toBe(callIdempotencyKey(run.id, step));
    }
    // The effect of the step that crashed happened only in the after-effect case.
    expect(effects).toHaveLength(point === "after-effect" ? step + 1 : step);

    // …and the resume.
    const resumed = await h.drive(run.id);
    expect([resumed.state, resumed.runId]).toEqual(["SUCCEEDED", run.id]);

    const final = await rows(run.id);
    expect(final.map((c) => [c.seq, c.tool, c.status])).toEqual([
      [0, "get_leg_state", "EXECUTED"],
      [1, "cancel_attendance_or_leg", "EXECUTED"],
      [2, "summarize_thread_for_staff", "EXECUTED"],
    ]);
    for (const row of final) expect(row.committedAt).not.toBeNull();

    // Exactly one effect per call. Three keys, in order, none twice — this is the assertion the
    // whole file exists for.
    expect(effects).toEqual([0, 1, 2].map((i) => callIdempotencyKey(run.id, i)));
    expect(h.recorder.intents.map((i) => i.idempotencyKey)).toEqual(effects);
  });

  it("a duplicate trigger during the outage resumes the same run rather than starting a new one", async () => {
    const { h, effects } = crashingHarness("after-effect", 1);
    await expect(h.start(TRIGGER)).rejects.toBeInstanceOf(SimulatedCrash);

    // The redelivery that arrives while the run is half-done: same trigger, same run, resumed.
    const again = await h.start(TRIGGER);
    expect([again.created, again.state]).toEqual([false, "SUCCEEDED"]);
    expect((await db.query("SELECT id FROM ops.agent_run", [])).rows).toHaveLength(1);
    expect(effects).toHaveLength(3);
  });

  it("a committed call is never re-executed, and its result is what the next turn reads", async () => {
    const { h, effects } = crashingHarness("before-persist", 2);
    await expect(h.start(TRIGGER)).rejects.toThrow(/script exhausted/);
    // Two steps committed, nothing pending: the resume takes the third turn and only the third.
    const run = (await db.query<{ id: string }>("SELECT id FROM ops.agent_run", [])).rows[0];
    expect(effects).toHaveLength(2);

    const resumed = await h.drive(run.id);
    expect([resumed.state, resumed.steps]).toEqual(["SUCCEEDED", 1]);
    expect(effects).toHaveLength(3);
    // One model turn on the resume, and its prompt carried the two committed results.
    const audit = h.gateways.at(-1)!.auditLog;
    expect(audit.map((a) => [a.outcome, a.tool])).toEqual([["ACCEPTED", "summarize_thread_for_staff"]]);
  });
});

/**
 * PR #35 review, F1. `tightenOnResume` is the whole of the rule, so it is also tested as a
 * function: all nine (persisted, fresh) pairs, with the direction asserted rather than described.
 * The effect-time proof — a pause or a withdrawn consent landing between the persist and the
 * resume, measured at the provider — is `exec/resume-tighten.test.ts`.
 */
describe("§11.1 resume re-decides a step tighten-only", () => {
  const RANKED = ["ALLOW", "PROPOSAL", "BLOCK"] as const;
  const decision = (verdict: (typeof RANKED)[number]): PolicyDecision =>
    verdict === "ALLOW"
      ? { verdict, tool: "get_leg_state", effect: "read", args: {} }
      : verdict === "PROPOSAL"
        ? { verdict, rule: "send_requires_approval", tool: "send_followup", args: {}, mutates: false, requiresApproval: true }
        : { verdict, rule: "send_while_paused", tool: "send_followup", reason: "paused", tasks: [] };

  it.each(RANKED.flatMap((persisted) => RANKED.map((fresh) => [persisted, fresh] as const)))(
    "persisted %s, now %s",
    (persisted, fresh) => {
      const tightened = tightenOnResume(persisted, decision(fresh));
      // Strictly tighter wins; equal or looser keeps the decision the row was persisted with.
      const tighter = RANKED.indexOf(fresh) > RANKED.indexOf(persisted);
      expect(tightened?.verdict ?? null).toBe(tighter ? fresh : null);
    },
  );
});

describe("§11.1 resume: the persisted decision is what a resume obeys", () => {
  it("a PENDING row that was persisted BLOCKED is committed BLOCKED without executing, even if policy would now allow it", async () => {
    const { runId } = await startRun(db, TRIGGER, ROUTING);
    // A step interrupted between the persist and the status update: the decision on the row says
    // BLOCK, while the arguments on it are perfectly in scope and would pass policy today.
    await persistCall(db, {
      runId, siteId: SITE, seq: 0, tool: "get_leg_state",
      args: { leg_id: "L-C1-AM" }, storeArgs: { leg_id: "L-C1-AM" },
      policyDecision: "BLOCK:cross_family_disclosure",
    });

    const h = runHarness({
      db, script: AT01_SCRIPT, facts: AT01_FACTS, policy: at01Policy(),
      overrides: AT01_EXECUTORS, now: () => now, isFatal,
    });
    const r = await driveRun(h.deps(1), runId);

    expect([r.state, r.reason]).toEqual(["FAILED", "policy blocked get_leg_state (cross_family_disclosure)"]);
    const [row] = await rows(runId);
    expect([row.status, row.result]).toEqual(["BLOCKED", { blocked_rule: "cross_family_disclosure" }]);
    expect(h.recorder.intents).toEqual([]);
    // No model turn was taken: the resume settled the row it found.
    expect(h.gateways.at(-1)!.auditLog).toEqual([]);
  });

  /**
   * The fence (PR #35 review, R2). `commitCall` updates `WHERE id = $1 AND status = 'PENDING'`,
   * and that single clause is what bounds two drivers on one run: the loop is explicitly not
   * claimed to be safe to call twice concurrently (loop.ts), so the worst case has to be a wasted
   * model turn and never a second settlement of the same step. Remove `AND status = 'PENDING'`
   * from store.ts and this test fails — the loop overwrites the other driver's committed result
   * and carries on taking turns on a run it does not own.
   */
  it("the second driver to settle a PENDING call is fenced out and changes nothing", async () => {
    const { runId } = await startRun(db, TRIGGER, ROUTING);
    const row = await persistCall(db, {
      runId, siteId: SITE, seq: 0, tool: "get_leg_state",
      args: { leg_id: "L-C1-AM" }, storeArgs: { leg_id: "L-C1-AM" },
      policyDecision: "ALLOW:read",
    });

    // The other driver settles the row while this one is inside the executor — exactly the window
    // the fence is for. The effect itself is idempotent on the shared key, so nothing happened
    // twice; what must not happen is this driver committing over the settlement.
    const other = "agent:other-driver";
    const h = runHarness({
      db, script: AT01_SCRIPT, facts: AT01_FACTS, policy: at01Policy(), now: () => now, isFatal,
      overrides: {
        ...AT01_EXECUTORS,
        get_leg_state: async (call) => {
          expect(await commitCall(db, call.callId, "EXECUTED", { settled_by: "other-driver" }, other)).toBe(true);
          return AT01_EXECUTORS.get_leg_state!(call);
        },
      },
    });
    const r = await driveRun(h.deps(0), runId);

    expect(r.reason).toBe("tool call 0 (get_leg_state) was committed by another driver");
    // The run's state is left to the driver that owns it, and no further turn was taken here.
    expect([r.state, r.steps]).toEqual(["RUNNING", 1]);
    expect(h.gateways.at(-1)!.auditLog).toEqual([]);

    // The row is the other driver's, down to its audit stamp.
    const after = (await db.query<{ status: string; result: Record<string, unknown>; updated_by: string }>(
      "SELECT status, result, updated_by FROM ops.agent_tool_call WHERE id = $1", [row.id])).rows[0];
    expect([after.status, after.result, after.updated_by]).toEqual([
      "EXECUTED", { settled_by: "other-driver" }, other,
    ]);
  });

  it("a finished run is left alone by a late resume", async () => {
    const h = runHarness({
      db, script: AT01_SCRIPT, facts: AT01_FACTS, policy: at01Policy(),
      overrides: AT01_EXECUTORS, now: () => now,
    });
    const first = await h.start(TRIGGER);
    expect(first.state).toBe("SUCCEEDED");

    const late = await h.drive(first.runId);
    expect([late.state, late.steps, late.reason]).toEqual(["SUCCEEDED", 0, "run already finished"]);
    expect(await rows(first.runId)).toHaveLength(3);
    expect(h.recorder.intents).toHaveLength(3);
    expect((await loadRun(db, first.runId))!.state).toBe("SUCCEEDED");
  });
});

describe("a human takeover stops the loop", () => {
  it("an aborted run is not driven another turn, and its state is left to the human", async () => {
    const h = runHarness({
      db, script: AT01_SCRIPT, facts: AT01_FACTS, policy: at01Policy(), now: () => now,
      overrides: {
        // The ops kill switch / staff takeover landing while the first step runs.
        get_leg_state: async (call) => {
          await db.query("UPDATE ops.agent_run SET state = 'ABORTED_SUPERSEDED_BY_HUMAN' WHERE id = $1", [call.runId]);
          return AT01_EXECUTORS.get_leg_state!(call);
        },
      },
    });
    const r = await h.start(TRIGGER);

    expect([r.state, r.steps, r.reason]).toEqual(["ABORTED_SUPERSEDED_BY_HUMAN", 1, "run was taken over before the next turn"]);
    // The step that was already in flight committed; no second turn was taken.
    const rows = await toolCalls(db, r.runId);
    expect(rows.map((c) => [c.tool, c.status])).toEqual([["get_leg_state", "EXECUTED"]]);
    expect(h.gateways.at(-1)!.auditLog).toHaveLength(1);
    expect((await loadRun(db, r.runId))!.state).toBe("ABORTED_SUPERSEDED_BY_HUMAN");
  });
});
