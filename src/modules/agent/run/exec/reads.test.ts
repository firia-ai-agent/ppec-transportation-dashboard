/**
 * B-08 slice 3, the two §11.2 read tools against real rows: `resolve_sender` (known contact point →
 * candidates{child, legs, confidence}; unknown → unknown_sender task) and `get_leg_state`
 * (— → leg + version).
 *
 * These are the front half of AT-01 and the whole of what AT-06 turns on: one authorized child is
 * resolved with its legs named, two siblings on one number are resolved to two candidates with no
 * leg named at all, and an unrecognized number resolves to a staff task and nothing else.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import type { Db } from "@/db/exec";
import { TEST_NOW } from "@/test/clock";
import { freshDb } from "@/test/pglite";
import { UNKNOWN_NUMBER, PEPPER } from "@/test/messaging";
import { type AgentScenario, seedAgentScenario, seedInbound } from "@/test/agent-state";
import { phoneHmac } from "@/modules/identity/phone";
import { TOOL_NAMES } from "../../tools";
import type { ExecutorCall, ToolExecution } from "../executors";
import type { ExecutorDeps } from "./effects";
import { effectId, isUuid } from "./effects";
import { UNKNOWN_SENDER_TASK_CATEGORY } from "./reads";
import { PROPOSAL_ONLY_TOOLS, SEQUENCED_EXECUTORS, liveExecutors, unaccountedTools } from "./registry";
import { liveHarness } from "./live-harness";

let pg: PGlite;
let db: Db;
let now: Date;
let sc: AgentScenario;
const open: PGlite[] = [];

beforeEach(async () => {
  ({ pg, db } = await freshDb());
  open.push(pg);
  now = new Date(TEST_NOW);
}, 60_000);

afterEach(async () => {
  await Promise.all(open.splice(0).map((h) => h.close().catch(() => {})));
});

/** One live executor, called directly: the loop's contract, without the loop. */
const run = async (tool: string, args: Record<string, unknown>, seq = 0): Promise<ToolExecution> => {
  const deps: ExecutorDeps = liveHarness({
    db, script: [], facts: { t1: "", t2: "", t3: [], t4: "" },
    policy: { scope: sc.scope, sendableSubjects: new Set() }, now: () => now,
  }).execDeps;
  const call: ExecutorCall = {
    runId: "0199e5f0-0000-7000-8000-00000000d001",
    callId: "0199e5f0-0000-7000-8000-00000000d002",
    siteId: sc.siteId,
    seq,
    tool,
    args,
    idempotencyKey: `agent:test:${seq}`,
    trigger: { type: "msg.inbound", id: sc.messageId, siteId: sc.siteId },
    now,
    committed: [],
  };
  return liveExecutors(deps)[tool](call);
};

const tasks = async () =>
  (await db.query<{ id: string; category: string; severity: string; state: string; completion_predicate: string }>(
    "SELECT id, category, severity, state, completion_predicate FROM ops.task ORDER BY created_at", [])).rows;

describe("§11.2 resolve_sender: known contact point → candidates{child, legs, confidence}", () => {
  it("resolves one authorized child, names its legs, and reports full confidence", async () => {
    sc = await seedAgentScenario(db);
    const r = await run("resolve_sender", { message_id: sc.messageId });

    expect(r.status).toBe("executed");
    expect(r.data).toMatchObject({
      sender_known: true,
      contact_token: sc.contactToken,
      family_token: sc.familyGroupId,
      thread_id: sc.threadId,
      service_date: "2026-10-15",
      confidence: 1,
    });
    expect(r.data!.candidates).toEqual([
      {
        child_token: sc.children[0],
        legs: [
          { leg_id: sc.legs[sc.children[0]].AM, direction: "AM", state: "SCHEDULED", version: 1 },
          { leg_id: sc.legs[sc.children[0]].PM, direction: "PM", state: "SCHEDULED", version: 1 },
        ],
      },
    ]);
    // The facts the next turn sees: tokens, counts, a number — and the legs it may read.
    expect(r.promptFacts).toEqual({
      sender_known: true,
      sender_thread_id: sc.threadId,
      sender_child_count: 1,
      sender_confidence: 1,
      sender_candidates: sc.children[0],
      service_date: "2026-10-15",
      sender_child_token: sc.children[0],
      am_leg_id: sc.legs[sc.children[0]].AM,
      pm_leg_id: sc.legs[sc.children[0]].PM,
    });
    // A read changes nothing: no task, and the legs are untouched.
    expect(await tasks()).toEqual([]);
  });

  it("the number never appears in the result or the facts, in any form", async () => {
    sc = await seedAgentScenario(db);
    const r = await run("resolve_sender", { message_id: sc.messageId });
    const serialized = JSON.stringify(r);
    expect(serialized).not.toContain(sc.number);
    expect(serialized).not.toContain(sc.number.replace("+1", ""));
    expect(serialized).not.toContain(phoneHmac(sc.number, PEPPER));
  });

  it("two siblings on one number are two candidates, half confidence, and no leg is named (AT-06)", async () => {
    sc = await seedAgentScenario(db, { children: 2, body: "staying home sick" });
    const r = await run("resolve_sender", { message_id: sc.messageId });

    expect(r.data).toMatchObject({ sender_known: true, confidence: 0.5 });
    expect((r.data!.candidates as unknown[]).length).toBe(2);
    expect(r.promptFacts).toMatchObject({
      sender_child_count: 2,
      sender_confidence: 0.5,
      sender_candidates: sc.children.join(","),
    });
    // Nothing to cancel until the family says which child: no leg id, no resolved child.
    expect(r.promptFacts!.sender_child_token).toBeUndefined();
    expect(Object.keys(r.promptFacts!).filter((k) => k.endsWith("_leg_id"))).toEqual([]);
    expect(r.done).toBeUndefined();
  });

  it("an unrecognized number raises one unknown_sender task, finishes the run, and answers nobody", async () => {
    sc = await seedAgentScenario(db);
    const strangerId = await seedInbound(db, {
      siteId: sc.siteId,
      threadId: sc.threadId,
      fromHmac: phoneHmac(UNKNOWN_NUMBER, PEPPER),
      body: "is the van coming",
      receivedAt: now,
    });
    const r = await run("resolve_sender", { message_id: strangerId });

    expect(r.status).toBe("executed");
    expect(r.done).toBe(true);
    expect(r.promptFacts).toEqual({ sender_known: false, reason_code: "NO_CONTACT_POINT" });
    const [task] = await tasks();
    expect([task.category, task.severity, task.state]).toEqual([UNKNOWN_SENDER_TASK_CATEGORY, "AMBER", "OPEN"]);
    // Idempotent on the call's key: the id is derived from it, so a re-drive writes no second row.
    expect(task.id).toBe(effectId("agent:test:0", "unknown-sender"));
    await run("resolve_sender", { message_id: strangerId });
    expect(await tasks()).toHaveLength(1);
    // Nothing was queued to anybody (AT-09).
    const out = await db.query<{ n: number }>("SELECT count(*)::int n FROM ops.outbound_message", []);
    expect(out.rows[0].n).toBe(0);
  });

  it("a recognized contact authorized for no child is the same staff question, not a sender", async () => {
    sc = await seedAgentScenario(db);
    await db.query("DELETE FROM ops.contact_authorization WHERE contact_token = $1", [sc.contactToken]);
    const r = await run("resolve_sender", { message_id: sc.messageId });
    expect(r.promptFacts).toEqual({ sender_known: false, reason_code: "NOT_AUTHORIZED" });
    expect((await tasks())[0].category).toBe(UNKNOWN_SENDER_TASK_CATEGORY);
  });

  it("our own echo has no sender to resolve (MSG-03)", async () => {
    sc = await seedAgentScenario(db);
    await db.query("UPDATE ops.message SET is_own_echo = true WHERE id = $1", [sc.messageId]);
    const r = await run("resolve_sender", { message_id: sc.messageId });
    expect(r.promptFacts).toEqual({ sender_known: false, reason_code: "OWN_ECHO" });
  });

  it("a message id that is not this site's, and one that is not an id at all, are both NOT_FOUND", async () => {
    sc = await seedAgentScenario(db);
    await db.query("UPDATE ops.message SET site_id = $1 WHERE id = $2", [sc.siteId, sc.messageId]);
    const other = await run("resolve_sender", { message_id: "0199e5f0-0000-7000-8000-0000000000ff" });
    expect([other.status, other.data]).toEqual(["failed", { error_code: "NOT_FOUND", object: "message" }]);
    const nonsense = await run("resolve_sender", { message_id: "MSG-1" });
    expect(nonsense.data).toEqual({ error_code: "NOT_FOUND", object: "message" });
  });
});

describe("§11.2 get_leg_state: — → leg + version", () => {
  it("returns the leg, its version, and the attendance day the full-day cancel is guarded on", async () => {
    sc = await seedAgentScenario(db);
    const legId = sc.legs[sc.children[0]].AM;
    const r = await run("get_leg_state", { leg_id: legId });

    expect(r.data).toEqual({
      leg_id: legId,
      child_token: sc.children[0],
      service_date: "2026-10-15",
      direction: "AM",
      mode: "PROVIDER",
      state: "SCHEDULED",
      version: 1,
      plan_version: 1,
      attendance: { state: "SCHEDULED", version: 1 },
    });
    expect(r.promptFacts).toEqual({
      leg_id: legId,
      leg_child_token: sc.children[0],
      leg_date: "2026-10-15",
      leg_direction: "AM",
      leg_state: "SCHEDULED",
      leg_version: 1,
      leg_plan_version: 1,
      attendance_state: "SCHEDULED",
      attendance_version: 1,
    });
  });

  it("reports the version a staff write has already moved, so the next write is guarded on the truth", async () => {
    sc = await seedAgentScenario(db);
    const legId = sc.legs[sc.children[0]].AM;
    await db.query("UPDATE ops.trip_leg SET state = 'PROVISIONAL_ASSIGNED', version = version + 1 WHERE id = $1", [legId]);
    const r = await run("get_leg_state", { leg_id: legId });
    expect(r.promptFacts).toMatchObject({ leg_state: "PROVISIONAL_ASSIGNED", leg_version: 2 });
  });

  it("a leg of another site is NOT_FOUND, in the same words as an id that exists nowhere", async () => {
    sc = await seedAgentScenario(db);
    const missing = await run("get_leg_state", { leg_id: "0199e5f0-0000-7000-8000-0000000000fe" });
    const nonsense = await run("get_leg_state", { leg_id: "L-C1-AM" });
    expect(missing.data).toEqual({ error_code: "NOT_FOUND", object: "trip_leg" });
    expect(nonsense.data).toEqual(missing.data);
  });
});

describe("the live registry accounts for every catalog tool", () => {
  it("every §11.2 tool is live, proposal-only, or named as deferred — exactly once", async () => {
    sc = await seedAgentScenario(db);
    const deps: ExecutorDeps = liveHarness({
      db, script: [], facts: { t1: "", t2: "", t3: [], t4: "" },
      policy: { scope: sc.scope, sendableSubjects: new Set() }, now: () => now,
    }).execDeps;
    const live = Object.keys(liveExecutors(deps));
    expect(unaccountedTools(deps)).toEqual([]);
    expect([...live, ...PROPOSAL_ONLY_TOOLS, ...SEQUENCED_EXECUTORS].sort()).toEqual([...TOOL_NAMES].sort());
    // A deferred tool has no executor at all: the loop fails its step shut (NO_EXECUTOR).
    for (const tool of SEQUENCED_EXECUTORS) expect(live).not.toContain(tool);
  });
});

describe("effect ids are derived from the call's idempotency key", () => {
  it("the same key gives the same uuid, a different key or suffix gives another", () => {
    expect(effectId("agent:r:0")).toBe(effectId("agent:r:0"));
    expect(isUuid(effectId("agent:r:0"))).toBe(true);
    expect(effectId("agent:r:0")).not.toBe(effectId("agent:r:1"));
    expect(effectId("agent:r:0")).not.toBe(effectId("agent:r:0", "exception"));
    // Version 8, RFC 4122 variant: a well-formed uuid that is deliberately not time-ordered.
    expect(effectId("agent:r:0").charAt(14)).toBe("8");
    expect("89ab").toContain(effectId("agent:r:0").charAt(19));
  });
});
