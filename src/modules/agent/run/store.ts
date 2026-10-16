/**
 * Everything the run loop keeps in `ops.agent_run` and `ops.agent_tool_call` (PRD §11.1 l.924).
 * Two guarantees live here, and both are the database's rather than the loop's:
 *
 *  1. **One run per trigger.** `startRun` inserts with `ON CONFLICT (trigger_type, trigger_id) DO
 *     NOTHING` and, on conflict, returns the run that already exists. The uniqueness is the
 *     pre-existing index `agent_run_trigger_uq`, so two concurrent deliveries of the same trigger
 *     cannot make two runs however they interleave — the loser of the insert blocks on the
 *     winner's row lock, gets zero rows back, and reads the winner's id.
 *  2. **Persist before execute.** `persistCall` writes the row — tool, canonical args fingerprint,
 *     redaction-safe args, the policy decision, status PENDING, and the call's idempotency key —
 *     and *then* returns, so the caller executes nothing until that row is committed. `commitCall`
 *     is the only thing that moves a row out of PENDING. A PENDING row found later is a call whose
 *     effect may or may not have happened, which is exactly what `idempotencyKey` is for.
 *
 * Nothing here calls a model, evaluates a policy or executes a tool: the loop (loop.ts) owns the
 * order, this module owns what a step looks like once it is written down.
 */
import { uuidv7 } from "uuidv7";
import { z } from "zod";
import type { Db, Exec } from "@/db/exec";
import { type PolicyTask, approvalKey, sanitizeStaffText } from "../policy";
import { redact } from "../redact";
import { type Trigger, type TriggerType, assertTrigger } from "./triggers";

/** `ops.agent_run_state`. The run's whole lifecycle; no state outside this list exists. */
export type RunState =
  | "QUEUED"
  | "RUNNING"
  | "WAITING_TOOL"
  | "SUCCEEDED"
  | "FAILED"
  | "ABORTED_SUPERSEDED_BY_HUMAN";

/** `ops.agent_tool_call_status` (migration 0007). */
export type CallStatus = "PENDING" | "EXECUTED" | "BLOCKED" | "PROPOSED" | "FAILED";

/** A run has ended: nothing re-drives it, and a trigger that returns one of these is simply done. */
export const TERMINAL_RUN_STATES: ReadonlySet<RunState> = new Set<RunState>([
  "SUCCEEDED",
  "FAILED",
  "ABORTED_SUPERSEDED_BY_HUMAN",
]);

/**
 * Allowed run-state edges. Deliberately local rather than a row in `src/domain/machines.ts`:
 * `transition()` is for the operational machines §6.3 freezes, whose edges are actor-typed and
 * counted by `machines.test.ts`; an agent run is infrastructure, its only actor is the runner, and
 * its edges are the resume protocol below. The *shape* of the guard is the repo's — every move is
 * `UPDATE … WHERE id = $1 AND state = $from`, 0 rows meaning someone else moved it first.
 *
 *  QUEUED       → RUNNING                     a driver claims it
 *  RUNNING      → RUNNING                     a crashed run is re-claimed by the next driver; safe
 *                                             because the (run_id, seq) index and the per-call
 *                                             idempotency key, not a lease, are what bound effects
 *  RUNNING      → WAITING_TOOL                a delayed external response became a task + a timer
 *  WAITING_TOOL → QUEUED                      the timer fired (timers.ts `agentResumeHandler`)
 *  *            → SUCCEEDED | FAILED          the loop finished or fail-shut
 *  QUEUED/RUNNING/WAITING_TOOL → ABORTED_…    a human took the work over (surface is a later slice)
 */
const RUN_EDGES: Readonly<Record<RunState, readonly RunState[]>> = {
  QUEUED: ["RUNNING", "FAILED", "ABORTED_SUPERSEDED_BY_HUMAN"],
  RUNNING: ["RUNNING", "WAITING_TOOL", "SUCCEEDED", "FAILED", "ABORTED_SUPERSEDED_BY_HUMAN"],
  WAITING_TOOL: ["QUEUED", "FAILED", "ABORTED_SUPERSEDED_BY_HUMAN"],
  SUCCEEDED: [],
  FAILED: [],
  ABORTED_SUPERSEDED_BY_HUMAN: [],
};

export function runEdgeAllowed(from: RunState, to: RunState): boolean {
  return RUN_EDGES[from].includes(to);
}

export class AgentRunError extends Error {}

export type RunRow = {
  readonly id: string;
  readonly siteId: string;
  readonly trigger: Trigger;
  readonly state: RunState;
  readonly version: number;
  /**
   * `ops.agent_run.updated_by` — who last wrote this row, and the **lease's holder slot**
   * (`run/lease.ts`, F2). While a driver holds the per-run lease this is its claim token, and the
   * loop stamps that same token on every write *it* makes to the row, so a value that is not this
   * driver's means somebody else is driving. With no lease it is `runActor(id)`, which is also what
   * a release puts back: a token here is the whole difference between "claimed" and "free".
   */
  readonly updatedBy: string;
  /** `ops.agent_run.updated_at` — when, and so how fresh a lease in `updatedBy` still is. */
  readonly updatedAt: Date;
};

export type ToolCallRow = {
  readonly id: string;
  readonly runId: string;
  readonly seq: number;
  readonly tool: string;
  readonly argsHash: string;
  /** The stored, redaction-safe arguments — see `storableArgs`. Authority on resume. */
  readonly args: Record<string, unknown>;
  /** The policy verdict, decided and written *before* execution and never rewritten. */
  readonly policyDecision: string;
  readonly status: CallStatus;
  readonly idempotencyKey: string;
  readonly result: Record<string, unknown> | null;
  readonly committedAt: Date | null;
};

type RunDbRow = {
  id: string; site_id: string; trigger_type: string; trigger_id: string; state: RunState; version: number;
  updated_by: string; updated_at: Date | string;
};
type CallDbRow = {
  id: string; run_id: string; seq: number; tool: string; args_hash: string; args: Record<string, unknown>;
  policy_decision: string; status: CallStatus; idempotency_key: string;
  result: Record<string, unknown> | null; committed_at: Date | string | null;
};

const RUN_COLUMNS = "id, site_id, trigger_type, trigger_id, state, version, updated_by, updated_at";
const CALL_COLUMNS = "id, run_id, seq, tool, args_hash, args, policy_decision, status, idempotency_key, result, committed_at";

const toRun = (r: RunDbRow): RunRow => ({
  id: r.id,
  siteId: r.site_id,
  trigger: { type: r.trigger_type as TriggerType, id: r.trigger_id, siteId: r.site_id },
  state: r.state,
  version: r.version,
  updatedBy: r.updated_by,
  updatedAt: new Date(r.updated_at),
});

const toCall = (r: CallDbRow): ToolCallRow => ({
  id: r.id,
  runId: r.run_id,
  seq: Number(r.seq),
  tool: r.tool,
  argsHash: r.args_hash,
  args: r.args ?? {},
  policyDecision: r.policy_decision,
  status: r.status,
  idempotencyKey: r.idempotency_key,
  result: r.result ?? null,
  committedAt: r.committed_at === null ? null : new Date(r.committed_at),
});

/** `created_by` / `updated_by` for everything a run writes (schema.ts audit convention). */
export function runActor(runId: string): string {
  return `agent:${runId}`;
}

/* ─────────────────────────────────── runs ─────────────────────────────────── */

/**
 * The §11.1 idempotent start: "Each run = job with idempotency (trigger_type, trigger_id)".
 * Returns the existing run for a duplicate trigger — `created` says which happened, so a caller
 * can tell a redelivery from a first delivery without being able to make a second run either way.
 *
 * `model` / `provider_routed` are stamped from the slice-1 config at start, so a run records which
 * model it was routed to even if it never reaches a model turn.
 */
export async function startRun(
  db: Exec,
  trigger: Trigger,
  routing: { model: string; provider: string },
): Promise<{ runId: string; created: boolean }> {
  assertTrigger(trigger);
  const id = uuidv7();
  const ins = await db.query<{ id: string }>(
    `INSERT INTO ops.agent_run (id, site_id, trigger_type, trigger_id, state, model, provider_routed, created_by, updated_by, source_mode)
     VALUES ($1, $2, $3, $4, 'QUEUED', $5, $6, $7, $7, 'SIMULATED')
     ON CONFLICT (trigger_type, trigger_id) DO NOTHING RETURNING id`,
    [id, trigger.siteId, trigger.type, trigger.id, routing.model, routing.provider, runActor(id)],
  );
  if (ins.rows[0]) return { runId: ins.rows[0].id, created: true };
  const existing = await db.query<RunDbRow>(
    `SELECT ${RUN_COLUMNS} FROM ops.agent_run WHERE trigger_type = $1 AND trigger_id = $2`,
    [trigger.type, trigger.id],
  );
  const row = existing.rows[0];
  // Unreachable: the conflict means the row is there and nothing deletes agent runs.
  if (!row) throw new AgentRunError(`trigger ${trigger.type}:${trigger.id} conflicted but no run exists`);
  // `agent_run_trigger_uq` is global, not per-site, so a trigger id reused across tenants would
  // silently hand this run another site's work. Refuse: the id is supposed to be the id of a row.
  if (row.site_id !== trigger.siteId) {
    throw new AgentRunError(`trigger ${trigger.type}:${trigger.id} already belongs to another site`);
  }
  return { runId: row.id, created: false };
}

export async function loadRun(db: Exec, runId: string): Promise<RunRow | null> {
  const r = await db.query<RunDbRow>(`SELECT ${RUN_COLUMNS} FROM ops.agent_run WHERE id = $1`, [runId]);
  return r.rows[0] ? toRun(r.rows[0]) : null;
}

/** Runs this site has left unfinished: QUEUED (a timer re-triggered one) or RUNNING (a crash). */
export async function resumableRuns(db: Exec, siteId: string, limit = 100): Promise<RunRow[]> {
  const r = await db.query<RunDbRow>(
    `SELECT ${RUN_COLUMNS} FROM ops.agent_run WHERE site_id = $1 AND state IN ('QUEUED', 'RUNNING')
     ORDER BY created_at LIMIT ${Number(limit) | 0}`,
    [siteId],
  );
  return r.rows.map(toRun);
}

/**
 * Guarded run-state move, the same shape as `transition()`: illegal edges are refused in code,
 * and the UPDATE is fenced on the state it claims to be moving from. `false` means the row was not
 * in `from` any more — another driver, a human takeover, or a timer got there first.
 */
export async function setRunState(db: Exec, runId: string, from: RunState, to: RunState, by: string): Promise<boolean> {
  if (!runEdgeAllowed(from, to)) throw new AgentRunError(`agent_run: ${from} -> ${to} is not an allowed edge`);
  const r = await db.query(
    `UPDATE ops.agent_run SET state = $3, version = version + 1, updated_at = now(), updated_by = $4
     WHERE id = $1 AND state = $2 RETURNING id`,
    [runId, from, to, by],
  );
  return r.rows.length === 1;
}

/**
 * The prompt hash of the model turn just taken. Hash only — §11.2 keeps no prompt text anywhere.
 *
 * `by` is the actor the driver stamps on the run row, and it defaults to this run's own. It is a
 * parameter because of the lease (`run/lease.ts`): `updated_by` is the holder slot, so a driver
 * that writes a turn must re-state its claim token rather than overwrite it with a generic actor
 * and silently free the run it is still driving.
 */
export async function recordPromptHash(db: Exec, runId: string, promptHash: string, by = runActor(runId)): Promise<void> {
  await db.query(
    `UPDATE ops.agent_run SET prompt_hash = $2, updated_at = now(), updated_by = $3 WHERE id = $1`,
    [runId, promptHash, by],
  );
}

/* ──────────────────────────────── tool calls ──────────────────────────────── */

/**
 * The key every external effect of this call must be idempotent on, derived from the call's
 * identity rather than from a clock or a uuid, so the resume of a crashed step derives the same
 * one. (run_id, seq) is already unique — `agent_tool_call_seq_uq` — which is what makes the
 * derivation safe to recompute instead of having to be read back.
 *
 * It is also the value a sink keys on: `ops.outbound_message.idempotency_key` is unique, so the
 * second attempt at a send whose first attempt committed is a conflict, not another message. The
 * backfill in migration 0007 spells this derivation out in SQL for the same reason.
 */
export function callIdempotencyKey(runId: string, seq: number): string {
  return `agent:${runId}:${seq}`;
}

/**
 * The canonical fingerprint of one call, stored as `args_hash`. Deliberately `approvalKey(tool,
 * args)` — the same string a human approval binds to (policy.ts) — so a PROPOSED row and the
 * approval that would release it are matched by this column rather than by re-serializing the
 * arguments and hoping the key order agrees.
 */
export function callArgsHash(tool: string, args: Record<string, unknown>): string {
  return approvalKey(tool, args);
}

/**
 * What may be written to `ops.agent_tool_call.args`.
 *
 * For an allowed or proposed call the policy engine has already handed us its own sanitized
 * arguments (`sanitizeStaffText` over the staff-facing prose fields) and has already refused any
 * untokenized number or address in a structured field — so those arguments are storable as they
 * are, and must be, because they are what gets executed and what a human approves.
 *
 * A **blocked** call is the opposite case: it was blocked *because* of what is in it. A
 * raw_recipient_selection block means the arguments carry a phone number, and the row exists so
 * staff can see that the model tried — not so the number lands in a table. Every string leaf is
 * therefore run through `redact()`. The fingerprint in `args_hash` is taken from the arguments as
 * the model sent them, so the audit trail still identifies the exact attempt.
 */
export function storableArgs(tool: string, args: Record<string, unknown>, blocked: boolean): Record<string, unknown> {
  return blocked ? (redactDeep(sanitizeStaffText(tool, args)) as Record<string, unknown>) : args;
}

function redactDeep(value: unknown): unknown {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map(redactDeep);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, redactDeep(v)]));
  }
  return value;
}

export async function toolCalls(db: Exec, runId: string): Promise<ToolCallRow[]> {
  const r = await db.query<CallDbRow>(`SELECT ${CALL_COLUMNS} FROM ops.agent_tool_call WHERE run_id = $1 ORDER BY seq`, [runId]);
  return r.rows.map(toCall);
}

export type PersistCallInput = {
  readonly runId: string;
  readonly siteId: string;
  readonly seq: number;
  readonly tool: string;
  /** The arguments as the model sent them. Hashed as-is; stored through `storableArgs`. */
  readonly args: Record<string, unknown>;
  /** The arguments to store — the policy engine's sanitized set for an allowed/proposed call. */
  readonly storeArgs: Record<string, unknown>;
  /** The policy verdict (and rule, when it blocked): "ALLOW", "BLOCK:cross_family_disclosure", … */
  readonly policyDecision: string;
  /**
   * The decision's tasks (`PolicyDecision.tasks`, a BLOCK only), parked on the row so the driver
   * that commits the block can raise them — see `PENDING_TASKS_KEY`.
   */
  readonly tasks?: readonly PolicyTask[];
};

/**
 * Where a persisted-but-uncommitted blocked call keeps the tasks its decision raised, inside the
 * row's own `result` jsonb.
 *
 * It has to be *on the row*, because a BLOCK decision does not survive a restart: `policy_decision`
 * records the verdict and the rule, and re-evaluating the call against a context that has moved is
 * not a resume. So the tasks are written with the row, before anything is committed, and the
 * driver that wins the BLOCKED commit reads them back and writes the `ops.task` rows in that same
 * transaction (run/tasks.ts). `result` is free until then: nothing reads a PENDING row's result
 * (`committedCalls` skips PENDING), and the commit overwrites it with the committed outcome.
 */
const PENDING_TASKS_KEY = "policy_tasks";

const policyTaskSchema = z.object({
  type: z.enum(["identity_change_request", "unknown_sender", "staff_review"]),
  familyToken: z.string().nullable(),
  sourceMessageId: z.string().nullable(),
  evidenceHash: z.string(),
  rule: z.string().nullable(),
});

/**
 * The tasks a PENDING blocked row is carrying. Parsed rather than trusted: the row is the input to
 * a resume, and a payload that is not the shape this slice wrote raises nothing rather than
 * throwing a run away — the block itself is still recorded either way.
 */
export function pendingPolicyTasks(row: ToolCallRow): PolicyTask[] {
  const parsed = z.array(policyTaskSchema).safeParse(row.result?.[PENDING_TASKS_KEY]);
  return parsed.success ? (parsed.data as PolicyTask[]) : [];
}

/**
 * Write the call before it runs, and hand back the row that is now the authority on it.
 *
 * Idempotent on (run_id, seq) — the pre-existing unique index — so a resume that re-reaches the
 * same step gets the row that is already there, with its original policy decision and its original
 * idempotency key, instead of a second row or an overwrite. That is what makes "resumes from the
 * last committed result" safe: the decision this call was persisted with was taken against the
 * context of the turn that produced it, and re-deciding it against a context that has since moved
 * is not a resume, it is a different call.
 */
export async function persistCall(db: Exec, input: PersistCallInput): Promise<ToolCallRow> {
  const id = uuidv7();
  const tasks = input.tasks ?? [];
  const ins = await db.query<CallDbRow>(
    `INSERT INTO ops.agent_tool_call
       (id, site_id, run_id, seq, tool, args_hash, args, policy_decision, status, idempotency_key, result, created_by, updated_by, source_mode)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'PENDING', $9, $11, $10, $10, 'SIMULATED')
     ON CONFLICT (run_id, seq) DO NOTHING
     RETURNING ${CALL_COLUMNS}`,
    [
      id, input.siteId, input.runId, input.seq, input.tool,
      callArgsHash(input.tool, input.args), JSON.stringify(input.storeArgs), input.policyDecision,
      callIdempotencyKey(input.runId, input.seq), runActor(input.runId),
      tasks.length === 0 ? null : JSON.stringify({ [PENDING_TASKS_KEY]: tasks }),
    ],
  );
  if (ins.rows[0]) return toCall(ins.rows[0]);
  const existing = await db.query<CallDbRow>(
    `SELECT ${CALL_COLUMNS} FROM ops.agent_tool_call WHERE run_id = $1 AND seq = $2`,
    [input.runId, input.seq],
  );
  if (!existing.rows[0]) throw new AgentRunError(`tool call ${input.runId}#${input.seq} conflicted but no row exists`);
  return toCall(existing.rows[0]);
}

/**
 * Move a persisted call out of PENDING and commit its result. Fenced on PENDING, so a second
 * attempt at a call that already committed writes nothing and returns false — the loop treats that
 * as "someone else finished this step", which is the same answer the job claim gives.
 */
export async function commitCall(
  db: Exec,
  callId: string,
  status: Exclude<CallStatus, "PENDING">,
  result: Record<string, unknown> | null,
  by: string,
): Promise<boolean> {
  const r = await db.query(
    `UPDATE ops.agent_tool_call SET status = $2, result = $3, committed_at = now(),
       version = version + 1, updated_at = now(), updated_by = $4
     WHERE id = $1 AND status = 'PENDING' RETURNING id`,
    [callId, status, result === null ? null : JSON.stringify(result), by],
  );
  return r.rows.length === 1;
}

/* ───────────────────────────── the resume cursor ───────────────────────────── */

/**
 * A committed call, as the next model turn gets to see it. `promptFacts` is the only part of a
 * result that may reach a prompt (executors.ts); everything else stays in the row.
 */
export type CommittedCall = {
  readonly seq: number;
  readonly tool: string;
  readonly status: CallStatus;
  readonly argsHash: string;
  readonly promptFacts: Readonly<Record<string, string | number | boolean>>;
};

/** The §11.1 resume cursor: the calls that have committed, in order, newest last. */
export function committedCalls(calls: readonly ToolCallRow[]): CommittedCall[] {
  return calls
    .filter((c) => c.status !== "PENDING")
    .map((c) => ({
      seq: c.seq,
      tool: c.tool,
      status: c.status,
      argsHash: c.argsHash,
      promptFacts: promptFactsOf(c.result),
    }));
}

/** The pending call of a run, if a step was interrupted between its persist and its commit. */
export function pendingCall(calls: readonly ToolCallRow[]): ToolCallRow | null {
  return calls.find((c) => c.status === "PENDING") ?? null;
}

function promptFactsOf(result: Record<string, unknown> | null): Record<string, string | number | boolean> {
  const facts = result?.prompt_facts;
  if (!facts || typeof facts !== "object" || Array.isArray(facts)) return {};
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(facts as Record<string, unknown>)) {
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") out[k] = v;
  }
  return out;
}

/** Convenience: run + its calls in one read, for a driver that is about to resume. */
export async function loadRunWithCalls(db: Db, runId: string): Promise<{ run: RunRow; calls: ToolCallRow[] } | null> {
  const run = await loadRun(db, runId);
  if (!run) return null;
  return { run, calls: await toolCalls(db, runId) };
}
