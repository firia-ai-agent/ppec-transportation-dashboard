/**
 * B-08 slice 3: §11.2 `escalate_exception` ("always allowed"), `close_task` ("evidence satisfies
 * completion predicate; else stays open") and the two `human`-tier `propose_*` rows ("no
 * mutation").
 *
 * The `close_task` suite also pins the founder's 2026-10-15 decision: an OPEN task is refused with
 * its own reason code and a staff-readable sentence, and the row it named is unchanged — a refusal,
 * not a new §6.3 edge.
 *
 * The propose suites are the ones with teeth: a `human`-tier call never reaches an executor at all,
 * so what is asserted is that the rows a human decides from exist, that they carry the approval key
 * the call row carries, and that **nothing else in the database moved**.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { uuidv7 } from "uuidv7";
import type { PGlite } from "@electric-sql/pglite";
import type { Db } from "@/db/exec";
import { agentNotes, agentRefusals, fill } from "@/ui/copy";
import { TEST_NOW } from "@/test/clock";
import { freshDb } from "@/test/pglite";
import { type AgentScenario, seedAgentScenario } from "@/test/agent-state";
import { approvalKey } from "../../policy";
import type { PolicyContext } from "../../policy";
import { toolCall } from "../../providers/fake";
import type { ProviderResponseBody } from "../../providers/provider";
import type { TierFacts } from "../context";
import { toolCalls } from "../store";
import type { Trigger } from "../triggers";
import { effectId } from "./effects";
import { PREDICATE_INBOUND_REPLY, checkPredicate, parsePredicate } from "./predicate";
import { demoChildToken, demoLegId } from "@/modules/demo/fixtures/standard";
import { renderTemplate } from "@/modules/messaging/templates";
import { TOOL_REGISTRY } from "../../tools";
import {
  CHANGE_REQUEST_TASK_CATEGORY,
  DROPOFF_CHANGE_TASK_CATEGORY,
  DROPOFF_CHANGE_TEMPLATE,
  REALLOCATION_TASK_CATEGORY,
} from "./proposals";
import { CLOSE_REFUSED_OPEN, THREAD_NOTE_TASK_CATEGORY } from "./staff";
import { type LiveHarness, liveHarness } from "./live-harness";

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

const trigger = (): Trigger => ({ type: "msg.inbound", id: sc.messageId, siteId: sc.siteId });

const facts = (): TierFacts => ({
  t1: `site=${sc.siteId} family=${sc.familyGroupId}`,
  t2: `service_date=${sc.serviceDate}`,
  t3: ["is the van coming"],
  t4: "channel=SMS locale=en-US",
});

const policy = (over: Partial<PolicyContext> = {}): PolicyContext => ({
  scope: sc.scope,
  sendableSubjects: new Set([sc.threadId, ...sc.children]),
  sourceMessageId: sc.messageId,
  ...over,
});

const harness = (script: readonly ProviderResponseBody[], over: Partial<PolicyContext> = {}): LiveHarness =>
  liveHarness({ db, script, facts: facts(), policy: policy(over), now: () => now });

const tasks = async () =>
  (await db.query<{
    id: string; category: string; severity: string; state: string; summary: string; next_step: string;
    completion_predicate: string; trip_leg_id: string | null; child_token: string | null;
    completion_evidence: Record<string, unknown> | null;
  }>(
    `SELECT id, category, severity, state, summary, next_step, completion_predicate, trip_leg_id, child_token,
       completion_evidence FROM ops.task ORDER BY created_at`, [])).rows;

describe("§11.2 escalate_exception: always allowed", () => {
  it("raises the task with the model's summary, our next step, and the leg it names", async () => {
    sc = await seedAgentScenario(db);
    const legId = sc.legs[sc.children[0]].AM;
    const h = harness([
      toolCall("escalate_exception", {
        severity: "RED", category: "NO_RECEIVER", leg_id: legId,
        summary: "Nobody at the stop and the guardian is not answering",
        next_step_code: "STAFF_CALL",
      }),
    ]);
    const r = await h.start(trigger());

    expect([r.state, r.steps]).toEqual(["SUCCEEDED", 1]);
    const [task] = await tasks();
    expect([task.category, task.severity, task.state]).toEqual(["NO_RECEIVER", "RED", "OPEN"]);
    expect(task.summary).toBe("Nobody at the stop and the guardian is not answering");
    // The next step is ours, chosen by the model's code.
    expect(task.next_step).toMatch(/^Call the family or the provider/);
    expect([task.trip_leg_id, task.child_token]).toEqual([legId, sc.children[0]]);
    expect(task.id).toBe(effectId(`agent:${r.runId}:0`, "exception"));

    const [call] = await toolCalls(db, r.runId);
    expect(call.result).toMatchObject({ exception_task_id: task.id, severity: "RED", category: "NO_RECEIVER" });
  });

  it("works while the agent is paused, which is the whole point of 'always allowed'", async () => {
    sc = await seedAgentScenario(db);
    const h = harness(
      [toolCall("escalate_exception", {
        severity: "AMBER", category: "POLICY_BLOCK", leg_id: null,
        summary: "Stopped because the agent is paused", next_step_code: "STAFF_REVIEW",
      })],
      { paused: true },
    );
    const r = await h.start(trigger());
    expect(r.state).toBe("SUCCEEDED");
    expect((await tasks()).map((t) => [t.category, t.severity])).toEqual([["POLICY_BLOCK", "AMBER"]]);
  });

  it("INFO is a GREEN task, and a leg that is not this site's is refused", async () => {
    sc = await seedAgentScenario(db);
    const info = harness([toolCall("escalate_exception", {
      severity: "INFO", category: "ACK_OVERDUE", leg_id: null,
      summary: "Recording that the ack is late", next_step_code: "NONE",
    })]);
    expect((await info.start(trigger())).state).toBe("SUCCEEDED");
    expect((await tasks())[0].severity).toBe("GREEN");

    const strangerLeg = "0199e5f0-0000-7000-8000-0000000000ef";
    const missing = harness(
      [toolCall("escalate_exception", {
        severity: "RED", category: "LOCATION_LOST", leg_id: strangerLeg,
        summary: "A leg nobody has", next_step_code: "STAFF_REVIEW",
      })],
      { scope: { ...sc.scope, tokens: new Set([...sc.scope.tokens, strangerLeg]) } },
    );
    const r = await missing.start({ ...trigger(), id: "MSG-STRANGER" });
    expect(r.state).toBe("FAILED");
    expect((await toolCalls(db, r.runId))[0].result).toMatchObject({ error_code: "NOT_FOUND", object: "trip_leg" });
    expect(await tasks()).toHaveLength(1);
  });

  it("the summary a staff task holds is the redacted one, never the model's raw words", async () => {
    sc = await seedAgentScenario(db);
    const h = harness([toolCall("escalate_exception", {
      severity: "AMBER", category: "UNKNOWN_SENDER", leg_id: null,
      summary: "Caller on (561) 555-0101 asked about the van",
      next_step_code: "STAFF_CALL",
    })]);
    await h.start(trigger());
    const [task] = await tasks();
    expect(task.summary).toContain("[REDACTED:PHONE]");
    expect(JSON.stringify(await tasks())).not.toContain("555-0101");
  });
});

describe("§11.2 close_task: evidence satisfies the predicate, else stays open", () => {
  /** A task in the state §6.3 lets the system close: staff resolved it, the agent verifies it. */
  const resolvedTask = async (predicate: string): Promise<string> => {
    const id = uuidv7();
    await db.query(
      `INSERT INTO ops.task (id, site_id, category, severity, state, summary, next_step, completion_predicate,
         created_by, updated_by, source_mode)
       VALUES ($1,$2,'AGENT_AWAIT_EXTERNAL','GREEN','RESOLVED_APPROVED','Waiting for a reply','Answer it',$3,'test','test','SIMULATED')`,
      [id, sc.siteId, predicate],
    );
    return id;
  };

  const closeCall = (taskId: string, evidenceRef: string) =>
    toolCall("close_task", { task_id: taskId, evidence_ref: evidenceRef });

  const closeHarness = (taskId: string, evidenceRef: string) =>
    liveHarness({
      db,
      script: [closeCall(taskId, evidenceRef)],
      facts: facts(),
      policy: policy({ scope: { ...sc.scope, tokens: new Set([...sc.scope.tokens, taskId, evidenceRef]) } }),
      now: () => now,
    });

  it("closes a resolved task when the evidence is the inbound reply it was waiting for", async () => {
    sc = await seedAgentScenario(db);
    const taskId = await resolvedTask(PREDICATE_INBOUND_REPLY);
    const h = closeHarness(taskId, sc.messageId);
    const r = await h.start(trigger());

    const [call] = await toolCalls(db, r.runId);
    expect(call.result).toMatchObject({ closed: true, reason_code: "SATISFIED" });
    const task = (await tasks()).find((t) => t.id === taskId)!;
    expect(task.state).toBe("CLOSED_VERIFIED");
    // The DB check `task_closed_needs_evidence` is satisfied by what the agent verified.
    expect(task.completion_evidence).toMatchObject({
      evidence_ref: sc.messageId,
      kind: "message",
      state: "IN",
      closed_by_run: r.runId,
    });
  });

  it("evidence that does not satisfy the predicate leaves the task open, and is not a failure", async () => {
    sc = await seedAgentScenario(db);
    // The task is waiting for a *sent message*; the evidence is an inbound one.
    const taskId = await resolvedTask("outbound:SENT|DELIVERED");
    const h = closeHarness(taskId, sc.messageId);
    const r = await h.start(trigger());

    const [call] = await toolCalls(db, r.runId);
    expect(call.status).toBe("EXECUTED");
    expect(call.result).toMatchObject({ closed: false, reason_code: "EVIDENCE_NOT_FOUND" });
    expect((await tasks()).find((t) => t.id === taskId)!.state).toBe("RESOLVED_APPROVED");
  });

  it("a prose predicate is a human's to judge: the task stays open", async () => {
    sc = await seedAgentScenario(db);
    const taskId = await resolvedTask("call logged confirming the family's choice");
    const h = closeHarness(taskId, sc.messageId);
    const r = await h.start(trigger());
    expect((await toolCalls(db, r.runId))[0].result).toMatchObject({
      closed: false,
      reason_code: "PREDICATE_NOT_MACHINE_READABLE",
    });
    expect((await tasks()).find((t) => t.id === taskId)!.state).toBe("RESOLVED_APPROVED");
  });

  /** A task nobody has resolved yet, in whichever unresolved state §6.3 allows. */
  const unresolvedTask = async (state: "OPEN" | "IN_PROGRESS" | "SNOOZED"): Promise<string> => {
    const id = uuidv7();
    await db.query(
      `INSERT INTO ops.task (id, site_id, category, severity, state, summary, next_step, completion_predicate,
         created_by, updated_by, source_mode)
       VALUES ($1,$2,'AGENT_AWAIT_EXTERNAL','GREEN',$4,'Waiting for a reply','Answer it',$3,'test','test','SIMULATED')`,
      [id, sc.siteId, PREDICATE_INBOUND_REPLY, state],
    );
    return id;
  };

  const taskRow = async (id: string) =>
    (await db.query<Record<string, unknown>>("SELECT * FROM ops.task WHERE id = $1", [id])).rows[0];

  it("refuses an OPEN task with an explicit reason, and leaves the row exactly as it was", async () => {
    sc = await seedAgentScenario(db);
    // The predicate *is* satisfied by this evidence — the inbound message is really there — so what
    // refuses the close is the task's state and nothing else (founder decision, 2026-10-15).
    const id = await unresolvedTask("OPEN");
    expect(await checkPredicate(db, {
      siteId: sc.siteId, predicate: PREDICATE_INBOUND_REPLY, evidenceRef: sc.messageId,
    })).toMatchObject({ satisfied: true });
    const before = await taskRow(id);

    const r = await closeHarness(id, sc.messageId).start(trigger());

    // Refused, by name, on the record: an executed call that says why, not a silent no-op.
    const [call] = await toolCalls(db, r.runId);
    expect(call.status).toBe("EXECUTED");
    expect(call.result).toMatchObject({
      closed: false,
      task_id: id,
      reason_code: CLOSE_REFUSED_OPEN,
      state: "OPEN",
      staff_message: agentRefusals.closeTaskOpen,
    });
    expect(CLOSE_REFUSED_OPEN).toBe("TASK_NOT_CLOSABLE_OPEN");
    // The model is told the same thing, as codes, so its next turn knows closing is not available.
    expect(call.result?.prompt_facts).toEqual({ task_closed: false, reason_code: CLOSE_REFUSED_OPEN });

    // And the row did not move: not its state, not its version, not its evidence, not a column.
    expect(await taskRow(id)).toEqual(before);
    expect([before.state, before.completion_evidence, before.version]).toEqual(["OPEN", null, 1]);
  });

  it("a task someone is already on stays open too, whatever the evidence says (§6.3)", async () => {
    sc = await seedAgentScenario(db);
    for (const state of ["IN_PROGRESS", "SNOOZED"] as const) {
      const id = await unresolvedTask(state);
      const r = await closeHarness(id, sc.messageId).start({ ...trigger(), id: `MSG-${state}` });
      expect((await toolCalls(db, r.runId))[0].result).toMatchObject({
        closed: false,
        reason_code: "TASK_NOT_RESOLVED",
        state,
      });
      expect((await taskRow(id)).state).toBe(state);
    }
  });

  it("closing a task twice is one close", async () => {
    sc = await seedAgentScenario(db);
    const taskId = await resolvedTask(PREDICATE_INBOUND_REPLY);
    await closeHarness(taskId, sc.messageId).start(trigger());
    const again = closeHarness(taskId, sc.messageId);
    const r = await again.start({ ...trigger(), id: "MSG-AGAIN" });
    expect((await toolCalls(db, r.runId))[0].result).toMatchObject({
      closed: true,
      reason_code: "ALREADY_CLOSED",
      idempotent: true,
    });
    expect((await tasks()).filter((t) => t.state === "CLOSED_VERIFIED")).toHaveLength(1);
  });

  it("the predicate vocabulary itself: coded parses, prose does not, and a kind must be known", async () => {
    sc = await seedAgentScenario(db);
    expect(parsePredicate(PREDICATE_INBOUND_REPLY)).toEqual({ kind: "message", states: ["IN"] });
    expect(parsePredicate("outbound:SENT|DELIVERED")).toEqual({ kind: "outbound", states: ["SENT", "DELIVERED"] });
    expect(parsePredicate("staff called the family")).toBeNull();
    expect(parsePredicate("unicorn:HAPPY")).toBeNull();
    // And the evidence is read from the database, not taken on trust.
    expect(await checkPredicate(db, {
      siteId: sc.siteId, predicate: "leg:CANCELED_TRANSPORT", evidenceRef: sc.legs[sc.children[0]].AM,
    })).toEqual({ satisfied: false, reasonCode: "EVIDENCE_DOES_NOT_SATISFY", evidence: { kind: "leg", state: "SCHEDULED" } });
  });
});

describe("§11.2 propose_*: a row for a human, and no mutation", () => {
  const stateSnapshot = async () => ({
    legs: (await db.query("SELECT id, state, version, plan_version FROM ops.trip_leg ORDER BY id", [])).rows,
    days: (await db.query("SELECT id, state, version FROM ops.attendance_day ORDER BY id", [])).rows,
    contacts: (await db.query("SELECT id, contact_token, child_token, scope FROM ops.contact_authorization ORDER BY id", [])).rows,
    outbound: (await db.query("SELECT id FROM ops.outbound_message", [])).rows,
    exceptions: (await db.query("SELECT id FROM ops.attendance_exception", [])).rows,
  });

  it("propose_contact_or_profile_change writes a change request plus an exception, and changes nothing", async () => {
    sc = await seedAgentScenario(db, { body: "my number changed, use this one" });
    const before = await stateSnapshot();
    const args = {
      family_token: sc.familyGroupId,
      category: "PHONE",
      claim_summary: "Guardian says their cell number changed",
      source_message_id: sc.messageId,
    };
    const h = harness([toolCall("propose_contact_or_profile_change", args)]);
    const r = await h.start(trigger());

    expect([r.state, r.steps]).toEqual(["SUCCEEDED", 1]);
    const [call] = await toolCalls(db, r.runId);
    expect([call.status, call.policyDecision]).toEqual(["PROPOSED", "PROPOSAL:human_tier_requires_approval"]);

    const [cr] = (await db.query<{
      id: string; kind: string; status: string; subject_child_tokens: string[]; basis_message_id: string;
      payload: Record<string, unknown>;
    }>("SELECT id, kind, status, subject_child_tokens, basis_message_id, payload FROM ops.change_request", [])).rows;
    expect([cr.kind, cr.status]).toEqual(["PHONE", "NEEDS_HUMAN"]);
    expect(cr.subject_child_tokens).toEqual([sc.children[0]]);
    expect(cr.basis_message_id).toBe(sc.messageId);
    // The approval key on the row, on the result and on the call row are one value.
    expect(cr.payload.approval_key).toBe(approvalKey("propose_contact_or_profile_change", args));
    expect(call.argsHash).toBe(cr.payload.approval_key);
    expect(call.result).toMatchObject({
      proposal_rule: "human_tier_requires_approval",
      approval_key: call.argsHash,
      change_request_id: cr.id,
      mutated: false,
    });
    expect((await tasks()).map((t) => [t.category, t.severity])).toEqual([[CHANGE_REQUEST_TASK_CATEGORY, "AMBER"]]);

    // Nothing else moved: no contact added, no profile touched, no message queued.
    expect(await stateSnapshot()).toEqual(before);
  });

  it("propose_manifest_reallocation writes a RED exception plus an approval request, and no manifest change", async () => {
    sc = await seedAgentScenario(db);
    const before = await stateSnapshot();
    const vehicle = "V-SYN-1";
    const args = {
      infeasible_vehicle_token: vehicle,
      leg_ids: [sc.legs[sc.children[0]].AM],
      options: [{ vehicle_token: "V-SYN-2", leg_ids: [sc.legs[sc.children[0]].AM], added_minutes: 12 }],
      rationale_code: "SECUREMENT",
    };
    const h = harness([toolCall("propose_manifest_reallocation", args)], {
      scope: { ...sc.scope, shared: new Set([vehicle, "V-SYN-2"]) },
    });
    const r = await h.start(trigger());

    expect(r.state).toBe("SUCCEEDED");
    const [call] = await toolCalls(db, r.runId);
    expect(call.status).toBe("PROPOSED");

    const [task] = await tasks();
    expect([task.category, task.severity, task.state]).toEqual([REALLOCATION_TASK_CATEGORY, "RED", "OPEN"]);
    const [ar] = (await db.query<{ id: string; task_id: string; proposal: Record<string, unknown>; decided_at: Date | null }>(
      "SELECT id, task_id, proposal, decided_at FROM ops.approval_request", [])).rows;
    expect([ar.task_id, ar.decided_at]).toEqual([task.id, null]);
    expect(ar.proposal).toMatchObject({
      infeasible_vehicle_token: vehicle,
      rationale_code: "SECUREMENT",
      approval_key: approvalKey("propose_manifest_reallocation", args),
    });
    expect(call.result).toMatchObject({ approval_request_id: ar.id, exception_task_id: task.id, mutated: false });
    expect(await stateSnapshot()).toEqual(before);
  });

  it("the same proposal driven twice writes one change request and one task", async () => {
    sc = await seedAgentScenario(db);
    const args = {
      family_token: sc.familyGroupId, category: "CUSTODY",
      claim_summary: "Guardian says custody changed", source_message_id: sc.messageId,
    };
    const first = harness([toolCall("propose_contact_or_profile_change", args)]);
    const r = await first.start(trigger());
    const key = `agent:${r.runId}:0`;

    // The rows are keyed off the call's idempotency key, so a re-drive conflicts rather than
    // writing a second proposal for a human to read twice.
    const ids = (await db.query<{ id: string }>("SELECT id FROM ops.change_request", [])).rows;
    expect(ids.map((x) => x.id)).toEqual([effectId(key, "change-request")]);
    expect((await tasks()).map((t) => t.id)).toEqual([effectId(key, "exception")]);
  });
});

describe("§11.2 summarize_thread_for_staff: a staff-only note, and nothing else", () => {
  it("writes one GREEN note on the thread's own step, and sends nothing", async () => {
    sc = await seedAgentScenario(db);
    const h = harness([toolCall("summarize_thread_for_staff", {
      thread_id: sc.threadId, summary: "Guardian asked about the van and was told the ETA",
    })]);
    const r = await h.start(trigger());

    expect([r.state, r.steps]).toEqual(["SUCCEEDED", 1]);
    const [note] = await tasks();
    expect([note.category, note.severity, note.state]).toEqual([THREAD_NOTE_TASK_CATEGORY, "GREEN", "OPEN"]);
    expect(note.summary).toBe(fill(agentNotes.locator, {
      summary: "Guardian asked about the van and was told the ETA",
      trigger: `msg.inbound:${sc.messageId}`,
      step: 0,
    }));
    expect([note.next_step, note.completion_predicate]).toEqual([agentNotes.nextStep, agentNotes.predicate]);
    expect(note.id).toBe(effectId(`agent:${r.runId}:0`, "thread-note"));
    // A note is for staff: nothing is queued and nothing leaves.
    expect((await db.query("SELECT 1 FROM ops.outbound_message", [])).rows).toEqual([]);
    expect((await toolCalls(db, r.runId))[0].result).toMatchObject({
      thread_id: sc.threadId, prompt_facts: { note_written: true },
    });
  });

  it("the note holds tokens and a redacted sentence, never a number", async () => {
    sc = await seedAgentScenario(db);
    const h = harness([toolCall("summarize_thread_for_staff", {
      thread_id: sc.threadId, summary: "Guardian on (561) 555-0101 wants the PM ride canceled",
    })]);
    await h.start(trigger());

    const [note] = await tasks();
    expect(note.summary).toContain("[REDACTED:PHONE]");
    expect(JSON.stringify(await tasks())).not.toContain("555-0101");
    expect(JSON.stringify(await tasks())).not.toContain(sc.number);
  });

  it("a thread of another site is NOT_FOUND, and nothing is written", async () => {
    sc = await seedAgentScenario(db);
    const other = uuidv7();
    const h = harness([toolCall("summarize_thread_for_staff", { thread_id: other, summary: "Nothing to see" })], {
      scope: { ...sc.scope, tokens: new Set([...sc.scope.tokens, other]) },
    });
    const r = await h.start(trigger());

    expect(r.state).toBe("FAILED");
    expect((await toolCalls(db, r.runId))[0].result).toMatchObject({
      error_code: "NOT_FOUND", object: "conversation_thread",
    });
    expect(await tasks()).toEqual([]);
  });

  it("the same note driven twice is one row, and the agent cannot close it", async () => {
    sc = await seedAgentScenario(db);
    const h = harness([toolCall("summarize_thread_for_staff", {
      thread_id: sc.threadId, summary: "Guardian canceled the AM ride",
    })]);
    const r = await h.start(trigger());
    const [note] = await tasks();

    // Its predicate is prose, so `close_task` has nothing it can read — and the row is OPEN, which
    // that tool refuses by name whatever the evidence says.
    expect(parsePredicate(note.completion_predicate)).toBeNull();
    const closing = harness([toolCall("close_task", { task_id: note.id, evidence_ref: sc.messageId })], {
      scope: { ...sc.scope, tokens: new Set([...sc.scope.tokens, note.id]) },
    });
    const r2 = await closing.start({ ...trigger(), id: "MSG-CLOSE-NOTE" });
    expect((await toolCalls(db, r2.runId))[0].result).toMatchObject({
      closed: false, reason_code: CLOSE_REFUSED_OPEN, staff_message: agentRefusals.closeTaskOpen,
    });
    expect(await tasks()).toHaveLength(1);
    expect((await tasks())[0].state).toBe("OPEN");
    expect(r.runId).not.toBe(r2.runId);
  });
});

/**
 * §11.2 human tier: `propose_dropoff_change` — the drop-off a family asked for (demo item 2b).
 *
 * The commonest thing a parent texts a transport desk had no tool at all, so a model reading "can
 * he be dropped at grandma's at 5?" could only cancel the ride or escalate it. This is the row a
 * coordinator decides from instead, and what it must prove is the same thing the other two
 * propose_* suites prove plus one: **the text the family would get is on the row**, as the
 * template and the vars the outbox itself renders, so the approval screen and the send cannot show
 * two different sentences.
 */
describe("§11.2 propose_dropoff_change: the text a family would get, for a person to approve", () => {
  const approvals = async () =>
    (await db.query<{ id: string; site_id: string; task_id: string; proposal: Record<string, unknown>; decision: string | null }>(
      "SELECT id, site_id, task_id, proposal, decision FROM ops.approval_request ORDER BY created_at", [])).rows;

  const untouched = async () => ({
    legs: (await db.query("SELECT id, state, version, plan_version, window_start FROM ops.trip_leg ORDER BY id", [])).rows,
    outbound: (await db.query("SELECT id FROM ops.outbound_message", [])).rows,
  });

  it("writes an approval request carrying the template and the vars, and moves nothing", async () => {
    sc = await seedAgentScenario(db, { body: "can he be dropped at the library at 5 instead" });
    const legId = sc.legs[sc.children[0]].PM;
    const before = await untouched();
    const args = {
      leg_id: legId,
      requested_dropoff_time: "17:00",
      requested_stop_token: "GA-LIBRARY",
      rationale_code: "PARENT_REQUEST",
      source_message_id: sc.messageId,
      expected_version: 1,
    };

    const h = harness([toolCall("propose_dropoff_change", args)]);
    const r = await h.start(trigger());

    expect([r.state, r.steps]).toEqual(["SUCCEEDED", 1]);
    const [call] = await toolCalls(db, r.runId);
    expect([call.status, call.policyDecision]).toEqual(["PROPOSED", "PROPOSAL:human_tier_requires_approval"]);

    const [approval] = await approvals();
    expect(approval.site_id).toBe(sc.siteId);
    expect(approval.decision).toBeNull();
    expect(approval.proposal).toMatchObject({
      kind: "DROPOFF_CHANGE",
      leg_id: legId,
      child_token: sc.children[0],
      service_date: sc.serviceDate,
      direction: "PM",
      /*
       * `plan_run.version`, not `trip_leg.plan_version` (Firia's S1-3, 2026-10-17 11:00 PM ET,
       * on Veri's S1-3.2: the board guards one counter and the leg carries another). This
       * scenario saves no plan, so the version is 0 — the same 0 `loadBoard` reports for a day
       * nobody has planned, and the same one a first Save names.
       */
      plan_run_version_basis: 0,
      requested_dropoff_time: "17:00",
      stop_token: "GA-LIBRARY",
      rationale_code: "PARENT_REQUEST",
      basis_message_id: sc.messageId,
      template_id: DROPOFF_CHANGE_TEMPLATE,
      approval_key: approvalKey("propose_dropoff_change", args),
    });
    // The key on the row is the key on the call: one human decision releases one exact call.
    expect(call.argsHash).toBe(approval.proposal.approval_key);

    // The vars render, through the outbox's own renderer, into the words the family would read.
    const body = renderTemplate(
      String(approval.proposal.template_id),
      approval.proposal.vars as Record<string, unknown>,
    );
    /*
     * The body is the one Firia asked for at 10:51 PM ET: it opens with the answer and names the
     * child and the stop ("Model draft is human and uses the child's name"). The assertion is on
     * the stop and on the shape rather than on the whole sentence, because the *words* are
     * src/ui/copy.ts's to change and this test is about the vars reaching the renderer.
     */
    expect(body).toContain("Greenacres Branch Library");
    expect(body).toMatch(/^PPEC: Yes/);
    // Still no name of a person in it, and never the 24-hour clock (COPY-GUIDE §3).
    expect(body).not.toContain("17:00");

    // An AMBER task for the board, and nothing else in the database moved.
    expect((await tasks()).map((t) => [t.category, t.severity])).toEqual([[DROPOFF_CHANGE_TASK_CATEGORY, "AMBER"]]);
    expect(await untouched()).toEqual(before);
  });

  /**
   * Only a time. The place the family is told is then the stop the leg already drops at, which
   * `ops.stop_location` cannot say — it holds a label and a lat/lng and no SMS token — so it is
   * resolved from the demo fixtures by the child's own id. A demo-seeded child, because that
   * resolution is demo-only by construction.
   */
  it("fills in the leg's own stop when only the time was asked for", async () => {
    sc = await seedAgentScenario(db);
    const child = demoChildToken("C2");
    await db.query(
      `INSERT INTO ops.child_profile (child_token, site_id, family_group_id, display_name, created_by, updated_by)
       VALUES ($1, $2, $3, 'Syn D.', 'test', 'test')`,
      [child, sc.siteId, sc.familyGroupId],
    );
    await db.query(
      `INSERT INTO ops.trip_leg (id, site_id, child_token, service_date, direction, mode, state, plan_version, created_by, updated_by)
       VALUES ($1, $2, $3, $4, 'PM', 'PROVIDER', 'SCHEDULED', 1, 'test', 'test')`,
      [demoLegId("C2", "PM"), sc.siteId, child, sc.serviceDate],
    );

    const h = harness([
      toolCall("propose_dropoff_change", {
        leg_id: demoLegId("C2", "PM"),
        requested_dropoff_time: "17:15",
        requested_stop_token: null,
        rationale_code: "PARENT_REQUEST",
        source_message_id: sc.messageId,
        expected_version: 1,
      }),
    ], { scope: { ...sc.scope, tokens: new Set([...sc.scope.tokens, demoLegId("C2", "PM")]) } });
    const r = await h.start(trigger());

    expect(r.state).toBe("SUCCEEDED");
    const [approval] = await approvals();
    // C2's own stop, out of the fixtures: Okeeheelee Park.
    expect(approval.proposal.stop_token).toBe("OKEE-PARK");
    expect(renderTemplate(DROPOFF_CHANGE_TEMPLATE, approval.proposal.vars as Record<string, unknown>))
      .toContain("Okeeheelee Park");
  });

  /**
   * A leg whose stop cannot be named, and no stop proposed. The proposal is refused by name rather
   * than defaulted: the one thing worse than not proposing a drop-off is proposing a place to leave
   * a child that nobody chose.
   */
  it("proposes nothing when neither it nor the leg can name a place", async () => {
    sc = await seedAgentScenario(db);
    const h = harness([
      toolCall("propose_dropoff_change", {
        leg_id: sc.legs[sc.children[0]].PM,
        requested_dropoff_time: "17:00",
        requested_stop_token: null,
        rationale_code: "PARENT_REQUEST",
        source_message_id: sc.messageId,
        expected_version: 1,
      }),
    ]);
    const r = await h.start(trigger());

    const [call] = await toolCalls(db, r.runId);
    expect(call.result).toMatchObject({ proposal_refused: "NO_STOP_FOR_LEG", mutated: false });
    expect(await approvals()).toEqual([]);
  });

  /** Another site's leg never gets this far: the scope check is in front of the writer. */
  it("refuses a leg outside this run's scope before anything is written", async () => {
    sc = await seedAgentScenario(db);
    const stranger = await seedAgentScenario(db, { number: "+15615550102" });
    const h = harness([
      toolCall("propose_dropoff_change", {
        leg_id: stranger.legs[stranger.children[0]].PM,
        requested_dropoff_time: "17:00",
        requested_stop_token: "GA-LIBRARY",
        rationale_code: "PARENT_REQUEST",
        source_message_id: sc.messageId,
        expected_version: 1,
      }),
    ]);
    const r = await h.start(trigger());

    const [call] = await toolCalls(db, r.runId);
    expect(call.status).toBe("BLOCKED");
    expect(call.policyDecision).toBe("BLOCK:cross_family_disclosure");
    expect(await approvals()).toEqual([]);
  });

  /** A call that proposes neither a time nor a place is refused by the gateway as invalid args. */
  it("will not accept a call that proposes nothing", () => {
    const def = TOOL_REGISTRY.propose_dropoff_change;
    const nothing = {
      leg_id: "L-C1-PM", requested_dropoff_time: null, requested_stop_token: null,
      rationale_code: "PARENT_REQUEST", source_message_id: "MSG-1", expected_version: 1,
    };
    expect(def.schema.safeParse(nothing).success).toBe(false);
    expect(def.schema.safeParse({ ...nothing, requested_dropoff_time: "17:00" }).success).toBe(true);
    expect(def.schema.safeParse({ ...nothing, requested_stop_token: "GA-LIBRARY" }).success).toBe(true);
    // A street address is not a place this tool takes: the stop list is the whole of it.
    expect(def.schema.safeParse({ ...nothing, requested_stop_token: "12 Elm St" }).success).toBe(false);
  });
});
