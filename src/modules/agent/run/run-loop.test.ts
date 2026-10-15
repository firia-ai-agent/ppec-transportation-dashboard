/**
 * B-08 slice 2, the run loop (PRD §11.1 l.924), against a real database.
 *
 * The three sentences under test here are the first two and the last: one run per
 * (trigger_type, trigger_id); every tool call written down, with its policy decision, *before* it
 * executes; and a blocked or proposed call recorded without executing anything. Resume lives in
 * `resume.test.ts`, the await timer in `timers.test.ts`.
 *
 * Everything the model says is scripted (`FakeProvider`) and everything it would do is an intent
 * record (`intentRecorder`), so a failure here is the loop's and not a vendor's.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { Db } from "@/db/exec";
import { SITE, freshDb } from "@/test/pglite";
import { approvalKey } from "../policy";
import { freeText, toolCall } from "../providers/fake";
import { cassetteFrom, cassetteKey, recordedProvider } from "../providers/recorded";
import { TOOL_NAMES } from "../tools";
import type { ProviderResponseBody } from "../providers/provider";
import { tierPrompt } from "./context";
import {
  AT01_EXECUTORS, AT01_FACTS, AT01_NOTE, AT01_READ, AT01_SCRIPT, at01Policy,
  type Harness, runHarness,
} from "./harness";
import { type ToolExecutor, intentRecorder } from "./executors";
import { startAndDriveRun } from "./loop";
import { callIdempotencyKey, setRunState, startRun } from "./store";
import { TRIGGER_TYPES, TriggerError, type Trigger } from "./triggers";

const TRIGGER: Trigger = { type: "msg.inbound", id: "MSG-1", siteId: SITE };

/* ───────────────────────────── harness plumbing ───────────────────────────── */

let pg: PGlite;
let db: Db;
let now: Date;
const open: PGlite[] = [];

beforeEach(async () => {
  ({ pg, db } = await freshDb());
  open.push(pg);
  now = new Date("2026-10-15T12:00:00.000Z");
}, 60_000);

// Each PGlite holds its own WASM heap; leaking them into one worker gets the worker OOM-killed.
afterEach(async () => {
  await Promise.all(open.splice(0).map((h) => h.close().catch(() => {})));
});

const harness = (over: Partial<Parameters<typeof runHarness>[0]> = {}): Harness =>
  runHarness({
    db,
    script: AT01_SCRIPT,
    facts: AT01_FACTS,
    policy: at01Policy(),
    overrides: AT01_EXECUTORS,
    now: () => now,
    ...over,
  });

const runs = async () =>
  (await db.query<{ id: string; state: string; trigger_type: string; trigger_id: string; model: string; provider_routed: string; prompt_hash: string | null }>(
    "SELECT id, state, trigger_type, trigger_id, model, provider_routed, prompt_hash FROM ops.agent_run ORDER BY created_at", [])).rows;

type CallRow = {
  seq: number; tool: string; status: string; policy_decision: string; args: Record<string, unknown>;
  args_hash: string; idempotency_key: string; result: Record<string, unknown> | null; committed_at: Date | null;
};
const calls = async (runId: string) =>
  (await db.query<CallRow>(
    `SELECT seq, tool, status, policy_decision, args, args_hash, idempotency_key, result, committed_at
     FROM ops.agent_tool_call WHERE run_id = $1 ORDER BY seq`, [runId])).rows;

/* ──────────────────────────────── the tests ──────────────────────────────── */

describe("§11.1 one run per trigger (trigger_type, trigger_id)", () => {
  it("drives the scenario to SUCCEEDED and records every step", async () => {
    const h = harness();
    const r = await h.start(TRIGGER);
    expect([r.state, r.created, r.steps]).toEqual(["SUCCEEDED", true, 3]);

    const [run] = await runs();
    expect([run.trigger_type, run.trigger_id, run.state]).toEqual(["msg.inbound", "MSG-1", "SUCCEEDED"]);
    // The run says which model it was routed to, and keeps the last turn's prompt as a hash only.
    expect([run.model, run.provider_routed]).toEqual([h.config.model, h.config.provider]);
    expect(run.prompt_hash).toMatch(/^[0-9a-f]{64}$/);

    const rows = await calls(run.id);
    expect(rows.map((c) => [c.seq, c.tool, c.status])).toEqual([
      [0, "get_leg_state", "EXECUTED"],
      [1, "cancel_attendance_or_leg", "EXECUTED"],
      [2, "summarize_thread_for_staff", "EXECUTED"],
    ]);
    expect(h.recorder.intents.map((i) => i.tool)).toEqual(["get_leg_state", "cancel_attendance_or_leg", "summarize_thread_for_staff"]);
  });

  it("a duplicate trigger returns the existing run and never a second one", async () => {
    const first = await harness().start(TRIGGER);
    const second = await harness().start(TRIGGER);

    expect(second.runId).toBe(first.runId);
    expect([second.created, second.state, second.steps]).toEqual([false, "SUCCEEDED", 0]);
    expect(second.reason).toBe("run already finished");
    expect(await runs()).toHaveLength(1);
    expect(await calls(first.runId)).toHaveLength(3);
  });

  it("concurrent duplicate starts collapse onto one run (the unique index decides)", async () => {
    const routing = { model: "m", provider: "openrouter" };
    const started = await Promise.all(
      Array.from({ length: 5 }, () => startRun(db, { ...TRIGGER, id: "MSG-RACE" }, routing)),
    );
    expect(new Set(started.map((s) => s.runId)).size).toBe(1);
    // Exactly one of the five inserted; the other four read the row the winner committed.
    expect(started.filter((s) => s.created)).toHaveLength(1);
    expect(await runs()).toHaveLength(1);
  });

  it("a different trigger id is a different run; a reused id in another site is refused", async () => {
    await harness().start(TRIGGER);
    await harness({ script: [AT01_NOTE], overrides: { summarize_thread_for_staff: AT01_EXECUTORS.summarize_thread_for_staff } })
      .start({ ...TRIGGER, id: "MSG-2" });
    expect(await runs()).toHaveLength(2);

    await expect(startRun(db, { ...TRIGGER, siteId: "00000000-0000-7000-8000-0000000000ff" }, { model: "m", provider: "p" }))
      .rejects.toThrow(/another site/);
  });

  it("refuses a trigger the loop could not deduplicate", async () => {
    const h = harness();
    await expect(h.start({ ...TRIGGER, id: "" })).rejects.toBeInstanceOf(TriggerError);
    await expect(h.start({ ...TRIGGER, id: "has space" })).rejects.toBeInstanceOf(TriggerError);
    await expect(h.start({ ...TRIGGER, type: "msg.outbound" as Trigger["type"] })).rejects.toBeInstanceOf(TriggerError);
    expect(await runs()).toHaveLength(0);
  });
});

describe("§11.1 tool calls persisted before execution", () => {
  it("the executor sees its own row PENDING, uncommitted, with its decision and key — and no later row", async () => {
    const seen: Record<string, unknown>[] = [];
    const probe: ToolExecutor = async (call) => {
      const rows = await calls(call.runId);
      seen.push({
        tool: call.tool,
        rowsSoFar: rows.length,
        mine: rows.find((r) => r.seq === call.seq),
        key: call.idempotencyKey,
      });
      return AT01_EXECUTORS[call.tool]!(call);
    };
    const h = harness({
      overrides: { get_leg_state: probe, cancel_attendance_or_leg: probe, summarize_thread_for_staff: probe },
    });
    const r = await h.start(TRIGGER);

    expect(seen).toHaveLength(3);
    seen.forEach((s, i) => {
      const mine = s.mine as CallRow;
      // Persisted before this executor ran: the row exists, PENDING, uncommitted, with the policy
      // decision and the idempotency key already on it.
      expect([mine.status, mine.committed_at]).toEqual(["PENDING", null]);
      expect(mine.policy_decision).toMatch(/^ALLOW:/);
      expect(mine.args_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(s.key).toBe(callIdempotencyKey(r.runId, i));
      expect(mine.idempotency_key).toBe(s.key);
      // …and nothing *after* it: a step is one call, written, then run.
      expect(s.rowsSoFar).toBe(i + 1);
    });

    for (const row of await calls(r.runId)) {
      expect(row.status).toBe("EXECUTED");
      expect(row.committed_at).not.toBeNull();
      expect(row.result).toMatchObject({ prompt_facts: expect.any(Object) });
    }
  });

  it("the idempotency key is unique per call, and the database says so", async () => {
    const r = await harness().start(TRIGGER);
    const rows = await calls(r.runId);
    expect(new Set(rows.map((c) => c.idempotency_key)).size).toBe(3);
    await expect(db.query(
      `INSERT INTO ops.agent_tool_call (id, site_id, run_id, seq, tool, args_hash, args, policy_decision, idempotency_key, created_by, updated_by)
       VALUES ('00000000-0000-7000-8000-0000000000e1', $1, $2, 9, 'get_leg_state', 'h', '{}', 'ALLOW:read', $3, 't', 't')`,
      [SITE, r.runId, rows[0].idempotency_key],
    )).rejects.toThrow();
  });

  it("a staff-facing prose argument is stored redacted, so no number reaches the table", async () => {
    const leaky = toolCall("summarize_thread_for_staff", {
      thread_id: "TH-F1", summary: "Guardian asked us to call (561) 555-0101 instead.",
    });
    const h = harness({ script: [leaky] });
    const r = await h.start(TRIGGER);
    const [row] = await calls(r.runId);
    expect(row.status).toBe("EXECUTED");
    expect(JSON.stringify(row.args)).toContain("[REDACTED:PHONE]");
    expect(JSON.stringify(row)).not.toContain("555-0101");
    // The intent the executor recorded carries the stored arguments, not the model's.
    expect(JSON.stringify(h.recorder.intents)).not.toContain("555-0101");
  });
});

describe("§11.1 blocked and proposed calls are recorded, and execute nothing", () => {
  it("an out-of-scope call is recorded BLOCKED with its rule, executes nothing, and fails the run shut", async () => {
    const h = harness({ script: [toolCall("get_leg_state", { leg_id: "L-C9-AM" }), AT01_READ] });
    const r = await h.start(TRIGGER);
    expect([r.state, r.steps]).toEqual(["FAILED", 1]);
    expect(r.reason).toMatch(/policy blocked get_leg_state \(cross_family_disclosure\)/);

    const rows = await calls(r.runId);
    expect(rows.map((c) => [c.tool, c.status, c.policy_decision])).toEqual([
      ["get_leg_state", "BLOCKED", "BLOCK:cross_family_disclosure"],
    ]);
    expect(rows[0].result).toEqual({ blocked_rule: "cross_family_disclosure" });
    expect(rows[0].committed_at).not.toBeNull();
    // Fail-shut: the second scripted turn never happens, and nothing executed.
    expect(h.recorder.intents).toEqual([]);
  });

  it("a blocked call's arguments are redacted before they are stored", async () => {
    const h = harness({
      script: [toolCall("escalate_exception", {
        severity: "RED", category: "POLICY_BLOCK", leg_id: "L-C9-AM",
        summary: "Caller on (561) 555-0101 asked about another family's van.",
        next_step_code: "STAFF_REVIEW",
      })],
    });
    const r = await h.start(TRIGGER);
    expect(r.state).toBe("FAILED");
    const [row] = await calls(r.runId);
    expect([row.status, row.policy_decision]).toEqual(["BLOCKED", "BLOCK:cross_family_disclosure"]);
    expect(JSON.stringify(row)).not.toContain("555-0101");
    expect(JSON.stringify(row.args)).toContain("[REDACTED:PHONE]");
    // The fingerprint is still of the call as the model made it, so the attempt stays identifiable.
    expect(row.args_hash).toBe(approvalKey("escalate_exception", {
      severity: "RED", category: "POLICY_BLOCK", leg_id: "L-C9-AM",
      summary: "Caller on (561) 555-0101 asked about another family's van.",
      next_step_code: "STAFF_REVIEW",
    }));
  });

  it("a human-tier call is recorded PROPOSED, mutates nothing, and ends the run", async () => {
    const h = harness({
      script: [toolCall("propose_contact_or_profile_change", {
        family_token: "F1", category: "PHONE", claim_summary: "Guardian says the cell number changed.", source_message_id: "MSG-1",
      })],
    });
    const r = await h.start(TRIGGER);
    expect([r.state, r.steps]).toEqual(["SUCCEEDED", 1]);
    const [row] = await calls(r.runId);
    expect([row.status, row.policy_decision]).toEqual(["PROPOSED", "PROPOSAL:human_tier_requires_approval"]);
    // The approval a human would sign is keyed on the same fingerprint the row carries.
    expect(row.result).toEqual({ proposal_rule: "human_tier_requires_approval", approval_key: row.args_hash });
    expect(h.recorder.intents).toEqual([]);
  });

  it("an unapproved send is a proposal: the loop sends nothing (slice 1's bar, through the loop)", async () => {
    const send = toolCall("notify_affected_therapist", {
      therapy_session_token: "SESS-C1", child_token: "C1", impact: "ABSENT", eta: null,
    });
    const h = harness({ script: [send] });
    const r = await h.start(TRIGGER);
    const [row] = await calls(r.runId);
    expect([r.state, row.status, row.policy_decision]).toEqual(["SUCCEEDED", "PROPOSED", "PROPOSAL:send_requires_approval"]);
    expect(h.recorder.intents).toEqual([]);
  });

  it("the same send with a human approval bound to that exact call is allowed and executed", async () => {
    const args = { therapy_session_token: "SESS-C1", child_token: "C1", impact: "ABSENT", eta: null };
    const h = harness({
      script: [toolCall("notify_affected_therapist", args)],
      policy: at01Policy({ approvedCalls: new Set([approvalKey("notify_affected_therapist", args)]) }),
      overrides: { notify_affected_therapist: async () => ({ data: { would_send: "therapist.absence_alert" }, done: true }) },
    });
    const r = await h.start(TRIGGER);
    const [row] = await calls(r.runId);
    expect([r.state, row.status, row.policy_decision]).toEqual(["SUCCEEDED", "EXECUTED", "ALLOW:send"]);
    // Still no send: the executor records the intent (B-08 slice 2 ships no outbox wiring).
    expect(h.recorder.intents.map((i) => i.tool)).toEqual(["notify_affected_therapist"]);
    expect(row.result).toMatchObject({ would_send: "therapist.absence_alert" });
  });
});

describe("fail-shut boundaries", () => {
  it("a gateway refusal ends the run and writes no tool-call row", async () => {
    const h = harness({ script: [freeText("just call her mother")] });
    const r = await h.start(TRIGGER);
    expect([r.state, r.steps]).toEqual(["FAILED", 0]);
    expect(r.reason).toMatch(/gateway refused the turn/);
    expect(await calls(r.runId)).toEqual([]);
    // The refusal is in the gateway's own audit log, hashes only.
    expect(h.gateways.at(-1)!.auditLog.map((a) => a.outcome)).toEqual(["REJECTED_FREE_TEXT"]);
  });

  it("the step budget from the slice-1 config bounds the loop", async () => {
    const loop: ProviderResponseBody[] = [AT01_READ, AT01_READ, AT01_READ, AT01_READ];
    const h = harness({ script: loop, config: { rateLimits: { maxCallsPerRun: 2 } } });
    const r = await h.start(TRIGGER);
    expect([r.state, r.steps]).toEqual(["FAILED", 2]);
    expect(r.reason).toMatch(/step budget of 2 tool calls exhausted/);
    expect(await calls(r.runId)).toHaveLength(2);
  });

  it("a tool with no executor fails the step instead of pretending it ran", async () => {
    const h = harness({ script: [AT01_READ], overrides: {} });
    // intentRecorder covers all 15 tools, so take the executor away explicitly.
    const deps = { ...h.deps(0), executors: {} };
    const r = await startAndDriveRun(deps, TRIGGER);
    expect([r.state, r.reason]).toEqual(["FAILED", "no executor for get_leg_state"]);
    const [row] = await calls(r.runId);
    expect([row.status, row.result]).toEqual(["FAILED", { error_code: "NO_EXECUTOR" }]);
  });

  it("an executor that throws is recorded as a failed step, not a crash", async () => {
    const h = harness({
      script: [AT01_READ],
      overrides: { get_leg_state: async () => { throw new Error("leg read timed out"); } },
    });
    const r = await h.start(TRIGGER);
    expect(r.state).toBe("FAILED");
    const [row] = await calls(r.runId);
    expect(row.status).toBe("FAILED");
    expect(row.result).toMatchObject({ error_code: "EXECUTOR_ERROR", error: "leg read timed out" });
  });
});

describe("§11.1 tiers assembled fresh each run", () => {
  it("the prompt is rebuilt every turn, carries the committed results, and is token-only", async () => {
    const h = harness();
    const r = await h.start(TRIGGER);
    // One prompt per turn, each one different because the results block grew.
    const hashes = h.gateways.at(-1)!.auditLog.map((a) => a.promptHash);
    expect(hashes).toHaveLength(3);
    expect(new Set(hashes).size).toBe(3);

    // The third turn's prompt is exactly what tierPrompt builds from the two committed results —
    // nothing is carried over from the earlier turns except those rows.
    const third = tierPrompt(AT01_FACTS, {
      runId: r.runId,
      trigger: TRIGGER,
      now,
      committed: [
        { seq: 0, tool: "get_leg_state", status: "EXECUTED", argsHash: "", promptFacts: { leg_state: "SCHEDULED", leg_version: 3 } },
        { seq: 1, tool: "cancel_attendance_or_leg", status: "EXECUTED", argsHash: "", promptFacts: { leg_canceled: true } },
      ],
    });
    expect(third).toContain("result seq=0 tool=get_leg_state status=EXECUTED leg_state=SCHEDULED leg_version=3");
    expect(third).toContain("<untrusted_user_message>wont need the AM van, dropping off at 9:30</untrusted_user_message>");
    // Validated by the gateway, which refuses a prompt carrying a number, an address or a name.
    expect(h.gateways.at(-1)!.validatePromptTokensOnly(third)).toMatch(/^[0-9a-f]{64}$/);
    expect(h.gateways.at(-1)!.auditLog.at(-1)!.promptHash).toBe(
      h.gateways.at(-1)!.validatePromptTokensOnly(third),
    );
  });
});

describe("the loop reaches a model only through the slice-1 providers", () => {
  it("drives a run on RecordedProvider: the assembled prompt is the cassette key", async () => {
    // The cassette is keyed by prompt hash, so this passes only if the prompt the loop builds is
    // byte-identical to the one the test built — i.e. if tier assembly is deterministic.
    const prompt = tierPrompt(AT01_FACTS, { runId: "unknown-at-cassette-time", trigger: TRIGGER, committed: [], now });
    const cassette = cassetteFrom([{ prompt, response: AT01_NOTE }]);
    const recorded = recordedProvider(cassette);
    const h = harness({ script: [AT01_NOTE], provider: () => recorded });

    const r = await h.start(TRIGGER);
    expect([r.state, r.steps]).toEqual(["SUCCEEDED", 1]);
    expect(recorded.hits).toEqual([cassetteKey(prompt)]);
  });

  it("a cassette miss fails the run shut rather than inventing an answer", async () => {
    const other = tierPrompt({ ...AT01_FACTS, t2: "leg=L-C1-PM state=SCHEDULED version=1" }, {
      runId: "r", trigger: TRIGGER, committed: [], now,
    });
    const h = harness({ provider: () => recordedProvider(cassetteFrom([{ prompt: other, response: AT01_NOTE }])) });
    const r = await h.start(TRIGGER);
    expect([r.state, r.steps]).toEqual(["FAILED", 0]);
    expect(r.reason).toMatch(/no recorded response for prompt sha256/);
    expect(await calls(r.runId)).toEqual([]);
  });
});

describe("the §11.1 trigger list, the run-state edges and the executor registry", () => {
  it("the five trigger types that start a run are the §11.1 list (ETA threshold is deterministic)", () => {
    expect([...TRIGGER_TYPES]).toEqual([
      "msg.inbound", "operational.event", "timer.deadline", "sweeper.overdue", "reconciliation",
    ]);
  });

  it("an illegal run-state edge is refused in code, before any UPDATE is sent", async () => {
    const { runId } = await startRun(db, TRIGGER, { model: "m", provider: "p" });
    await expect(setRunState(db, runId, "SUCCEEDED", "RUNNING", "t")).rejects.toThrow(/not an allowed edge/);
    // A guarded move whose `from` is wrong writes nothing and says so.
    expect(await setRunState(db, runId, "RUNNING", "SUCCEEDED", "t")).toBe(false);
    expect(await setRunState(db, runId, "QUEUED", "RUNNING", "t")).toBe(true);
  });

  it("the default registry covers all 15 catalog tools and records one intent per idempotency key", async () => {
    const recorder = intentRecorder();
    expect(Object.keys(recorder.executors).sort()).toEqual([...TOOL_NAMES].sort());

    const call = {
      runId: "r", callId: "c", siteId: SITE, seq: 0, tool: "get_leg_state", args: { leg_id: "L-C1-AM" },
      idempotencyKey: "agent:r:0", trigger: TRIGGER, now,
    };
    const first = await recorder.executors.get_leg_state(call);
    const second = await recorder.executors.get_leg_state(call);
    expect(second).toBe(first); // the sink's answer, not a second effect
    expect(recorder.intents).toHaveLength(1);
    expect(recorder.has("agent:r:0")).toBe(true);
  });
});
