/**
 * The agent run loop (PRD §11.1 l.924). Four sentences of the PRD, in the order they happen:
 *
 *   "Each run = job with idempotency (trigger_type, trigger_id)"  → `startAndDriveRun`, which
 *      returns the existing run for a duplicate trigger and never makes a second one (store.ts).
 *   "tool calls persisted before execution"                       → every step writes its row,
 *      with its policy decision and its idempotency key, and *commits that write*, before an
 *      executor is called. The two are deliberately in different transactions: a persist that
 *      could roll back with the effect would prove nothing.
 *   "resumes from last committed result"                          → `driveRun` starts by reading
 *      the run's committed calls. A call that committed is never re-executed; a call that was
 *      persisted but never committed is re-driven with the same idempotency key, which is what
 *      makes the second attempt a no-op at the sink rather than a second effect.
 *   "delayed external responses are tasks with timers, never waiting sessions"  → an executor that
 *      returns `awaitExternal` parks the run on a B-03 timer and the loop *returns* (timers.ts).
 *
 * Everything above the gateway and below the tool is unchanged from slice 1: the model is reached
 * only through `LlmGateway.complete` (one schema-valid catalog call or a refusal), every accepted
 * call is judged by `policy.evaluate`, and the §11.2 tiers decide what a send may do on its own: a
 * templated or fixed-copy send is allowed and executed, one carrying the model's own words is a
 * proposal that executes nothing until a human approval is bound to that exact call. The loop adds
 * no way around any of that — it cannot, because the only thing it may execute is a call the
 * gateway accepted and the policy engine allowed.
 *
 * Fail-shut is the default everywhere a step cannot complete: a gateway refusal, a policy block, a
 * missing executor and a failed execution all end the run rather than taking another model turn.
 * A hijacked thread must not be able to drive the loop, and a run that stopped is cheap to restart.
 */
import type { Db } from "@/db/exec";
import { type Clock, type JobScheduler, systemClock } from "@/modules/jobs/scheduler";
import type { LlmGateway, GatewayResult } from "../gateway";
import { type PolicyDecision, evaluate } from "../policy";
import type { ContextAssembler } from "./context";
import type { ExecutorCall, ToolExecution, ToolExecutors } from "./executors";
import {
  AgentRunError,
  type RunRow,
  type RunState,
  type ToolCallRow,
  TERMINAL_RUN_STATES,
  commitCall,
  committedCalls,
  loadRun,
  pendingCall,
  persistCall,
  recordPromptHash,
  resumableRuns,
  runActor,
  setRunState,
  startRun,
  storableArgs,
  toolCalls,
} from "./store";
import { type ParkedAwait, parkRunOnTimer } from "./timers";
import type { Trigger } from "./triggers";

export type RunDeps = {
  readonly db: Db;
  /** The slice-1 gateway. Its `config` is also where the loop's step budget comes from. */
  readonly gateway: LlmGateway;
  /** §11.1 tier assembly, called fresh on every model turn (context.ts). */
  readonly assemble: ContextAssembler;
  readonly executors: ToolExecutors;
  /** B-03. Used only to arm an await timer (ADR-001). */
  readonly scheduler: JobScheduler;
  readonly now?: Clock;
  /**
   * Errors for which this process is considered gone: they propagate instead of being recorded as
   * a failed step, so the run's rows are left exactly as they were and the next driver resumes
   * from them. The same seam as `FireOpts.isFatal` in the job runner, and for the same reason —
   * "the process died here" is otherwise not expressible in a test. Production passes nothing.
   */
  readonly isFatal?: (err: unknown) => boolean;
};

export type RunResult = {
  readonly runId: string;
  /** False when the trigger was a duplicate and this is the run that already existed. */
  readonly created: boolean;
  readonly state: RunState;
  /** Steps taken in *this* drive (a resume does not re-count the steps it inherited). */
  readonly steps: number;
  readonly reason?: string;
  readonly awaiting?: ParkedAwait;
};

/** How one step ended. `continue` is the only outcome that takes another model turn. */
type StepOutcome =
  | { kind: "continue" }
  | { kind: "done" }
  | { kind: "awaiting"; parked: ParkedAwait }
  | { kind: "blocked"; reason: string }
  | { kind: "failed"; reason: string }
  /** The commit was fenced out: another driver settled this step. Stop, and touch nothing. */
  | { kind: "lost"; reason: string };

/* ──────────────────────────────── entry points ──────────────────────────────── */

/**
 * Start (or find) the run for a trigger and drive it. The idempotent half of §11.1: calling this
 * twice with the same trigger runs the loop against **one** run row, whatever the interleaving.
 */
export async function startAndDriveRun(deps: RunDeps, trigger: Trigger): Promise<RunResult> {
  const { runId, created } = await startRun(deps.db, trigger, {
    model: deps.gateway.config.model,
    provider: deps.gateway.config.provider,
  });
  const result = await driveRun(deps, runId);
  return { ...result, created };
}

/**
 * Drive one run to its next stopping point: finished, parked on a timer, or stopped fail-shut.
 *
 * Safe to call on a run that is already finished (no-op), already waiting on a timer (no-op — the
 * timer is what re-triggers it), or interrupted mid-step (resume). Not safe to call twice
 * concurrently on the same run and not claimed to be: what bounds a double driver is the
 * (run_id, seq) unique index and the per-call idempotency key, so the worst case is wasted model
 * turns rather than duplicated effects. A per-run lease — the equivalent of the B-03 job claim —
 * belongs with the agent queue route, which is a later slice.
 */
export async function driveRun(deps: RunDeps, runId: string): Promise<RunResult> {
  const clock = deps.now ?? systemClock;
  const loaded = await loadRun(deps.db, runId);
  if (!loaded) throw new AgentRunError(`no agent run ${runId}`);
  if (TERMINAL_RUN_STATES.has(loaded.state)) {
    return { runId, created: false, state: loaded.state, steps: 0, reason: "run already finished" };
  }
  if (loaded.state === "WAITING_TOOL") {
    // §11.1: the timer re-triggers the run. Resuming it now would be the waiting session the PRD
    // forbids, one function call later.
    return { runId, created: false, state: loaded.state, steps: 0, reason: "run is parked on a timer" };
  }
  const claimed = await setRunState(deps.db, runId, loaded.state, "RUNNING", runActor(runId));
  if (!claimed) {
    const fresh = await loadRun(deps.db, runId);
    return { runId, created: false, state: fresh?.state ?? loaded.state, steps: 0, reason: "run moved on before this driver claimed it" };
  }
  const run: RunRow = { ...loaded, state: "RUNNING" };

  let steps = 0;
  let calls = await toolCalls(deps.db, runId);

  // 1. Resume: a step that was persisted but never committed. Its policy decision is the one it
  //    was persisted with — re-deciding it against a context that has moved since would be a
  //    different call, not a resume — and its idempotency key is the original, so an effect that
  //    did happen before the crash is not repeated.
  const interrupted = pendingCall(calls);
  if (interrupted) {
    steps += 1;
    const outcome = await settleCall(deps, run, interrupted, clock());
    const finished = await finish(deps, run, outcome, steps);
    if (finished) return finished;
    calls = await toolCalls(deps.db, runId);
  }

  // 2. Fresh steps. The budget is the slice-1 config's `maxCallsPerRun`, counted from the
  //    persisted rows rather than in memory, so it survives a restart (the gateway's own
  //    per-instance counter does not, and a resumed run must not get a fresh allowance).
  const maxSteps = deps.gateway.config.rateLimits.maxCallsPerRun;
  while (calls.length < maxSteps) {
    // Re-read the run before every turn, so a human takeover (ABORTED_SUPERSEDED_BY_HUMAN) or an
    // ops stop lands within one step instead of at the end of the loop. A model turn costs money
    // and a tool call has effects; neither should be spent on a run somebody has taken away.
    const live = await loadRun(deps.db, runId);
    if (live?.state !== "RUNNING") {
      return { runId, created: false, state: live?.state ?? loaded.state, steps, reason: "run was taken over before the next turn" };
    }
    const at = clock();
    const assembled = await deps.assemble({ runId, trigger: run.trigger, committed: committedCalls(calls), now: at });
    let turn: GatewayResult;
    try {
      turn = await deps.gateway.complete({ runId, prompt: assembled.prompt, tools: assembled.tools });
    } catch (e) {
      if (deps.isFatal?.(e)) throw e;
      // A refusal (leaking prompt, free text, unknown tool, invalid args, rate limit) is already a
      // row in the gateway's audit log, and nothing was executed. The run stops there.
      return fail(deps, run, `gateway refused the turn: ${message(e)}`, steps);
    }
    await recordPromptHash(deps.db, runId, turn.promptHash);

    const decision = evaluate(turn.call, assembled.policy);
    const row = await persistCallFor(deps, run, calls.length, turn, decision);
    steps += 1;

    // Nothing above this line executed anything; nothing below it runs without that row committed.
    const outcome = await settleCall(deps, run, row, at);
    const finished = await finish(deps, run, outcome, steps);
    if (finished) return finished;
    calls = await toolCalls(deps.db, runId);
  }

  return fail(deps, run, `step budget of ${maxSteps} tool calls exhausted`, steps);
}

/**
 * Drive every unfinished run of a site: QUEUED (a timer fired and `agentResumeHandler` re-triggered
 * it) and RUNNING (a run whose process died mid-step). This is the shape the agent queue route and
 * the sweeper both want; until that route exists it is also how a timer-driven resume is exercised.
 */
export async function resumeQueuedRuns(deps: RunDeps, siteId: string, limit = 100): Promise<RunResult[]> {
  const runs = await resumableRuns(deps.db, siteId, limit);
  const out: RunResult[] = [];
  for (const r of runs) out.push(await driveRun(deps, r.id));
  return out;
}

/* ──────────────────────────────── one step ──────────────────────────────── */

/** `ops.agent_tool_call.policy_decision`: the verdict, and the rule when there is one. */
export function decisionLabel(decision: PolicyDecision): string {
  switch (decision.verdict) {
    case "ALLOW":
      return `ALLOW:${decision.effect}`;
    case "PROPOSAL":
      return `PROPOSAL:${decision.rule}`;
    case "BLOCK":
      return `BLOCK:${decision.rule}`;
  }
}

/** The verdict a persisted row was written with. The row, not a re-evaluation, decides a resume. */
export function persistedVerdict(policyDecision: string): { verdict: "ALLOW" | "PROPOSAL" | "BLOCK"; detail: string } {
  const [verdict, ...rest] = policyDecision.split(":");
  if (verdict !== "ALLOW" && verdict !== "PROPOSAL" && verdict !== "BLOCK") {
    throw new AgentRunError(`unreadable policy decision ${JSON.stringify(policyDecision)}`);
  }
  return { verdict, detail: rest.join(":") };
}

async function persistCallFor(
  deps: RunDeps,
  run: RunRow,
  seq: number,
  turn: GatewayResult,
  decision: PolicyDecision,
): Promise<ToolCallRow> {
  const blocked = decision.verdict === "BLOCK";
  return persistCall(deps.db, {
    runId: run.id,
    siteId: run.siteId,
    seq,
    tool: turn.call.tool,
    // Hashed as the model sent them; stored only in a form a table may hold (store.ts).
    args: turn.call.args,
    storeArgs: storableArgs(turn.call.tool, blocked ? turn.call.args : decision.args, blocked),
    policyDecision: decisionLabel(decision),
  });
}

/**
 * Take one persisted call to its committed outcome. Called both for a fresh step and for a step
 * being resumed, and it cannot tell the difference — which is the point: the row is the whole
 * input, so "execute it" and "finish executing it" are one code path.
 */
async function settleCall(deps: RunDeps, run: RunRow, row: ToolCallRow, at: Date): Promise<StepOutcome> {
  const by = runActor(run.id);
  const { verdict, detail } = persistedVerdict(row.policyDecision);

  // A blocked call never executes. The row and its exception task (policy.evaluate raises the
  // task payload) are the AGT-02 evidence: "out-of-policy tool call rejected + logged".
  if (verdict === "BLOCK") {
    if (!(await commitCall(deps.db, row.id, "BLOCKED", { blocked_rule: detail }, by))) return lost(row);
    return { kind: "blocked", reason: `policy blocked ${row.tool} (${detail})` };
  }
  // A proposal mutates nothing and sends nothing; it waits for a human. The run is finished —
  // §11.1 has no notion of a run that waits for an approval, it has a proposal row and a task.
  if (verdict === "PROPOSAL") {
    const ok = await commitCall(deps.db, row.id, "PROPOSED", { proposal_rule: detail, approval_key: row.argsHash }, by);
    return ok ? { kind: "done" } : lost(row);
  }

  const executor = deps.executors[row.tool];
  if (!executor) {
    await commitCall(deps.db, row.id, "FAILED", { error_code: "NO_EXECUTOR" }, by);
    return { kind: "failed", reason: `no executor for ${row.tool}` };
  }

  const call: ExecutorCall = {
    runId: run.id,
    callId: row.id,
    siteId: run.siteId,
    seq: row.seq,
    tool: row.tool,
    args: row.args,
    idempotencyKey: row.idempotencyKey,
    trigger: run.trigger,
    now: at,
  };

  let execution: ToolExecution;
  try {
    execution = await executor(call);
  } catch (e) {
    if (deps.isFatal?.(e)) throw e;
    await commitCall(deps.db, row.id, "FAILED", { error_code: "EXECUTOR_ERROR", error: message(e) }, by);
    return { kind: "failed", reason: `executor for ${row.tool} failed: ${message(e)}` };
  }

  const result = resultRow(execution);
  if (execution.status === "failed") {
    await commitCall(deps.db, row.id, "FAILED", result, by);
    return { kind: "failed", reason: `${row.tool} reported failure` };
  }

  // §11.1: a delayed external response is a task with a timer. The commit, the task, the timer and
  // the run's move to WAITING_TOOL are one transaction (timers.ts).
  if (execution.awaitExternal) {
    const parked = await deps.db.tx((tx, afterCommit) =>
      parkRunOnTimer(tx, afterCommit, deps.scheduler, { run, call: row, await: execution.awaitExternal!, result, now: at }),
    );
    return { kind: "awaiting", parked };
  }

  // A commit fenced out by another driver means that driver owns the rest of this run: the effect
  // was idempotent on the same key, so nothing has happened twice — but taking the next turn from
  // here would be two drivers writing the same sequence.
  if (!(await commitCall(deps.db, row.id, "EXECUTED", result, by))) return lost(row);
  return execution.done ? { kind: "done" } : { kind: "continue" };
}

const lost = (row: ToolCallRow): StepOutcome => ({
  kind: "lost",
  reason: `tool call ${row.seq} (${row.tool}) was committed by another driver`,
});

/** `ops.agent_tool_call.result`, with the prompt-safe facts kept where context.ts reads them. */
function resultRow(execution: ToolExecution): Record<string, unknown> | null {
  const data = execution.data ?? {};
  const facts = execution.promptFacts ?? {};
  if (Object.keys(data).length === 0 && Object.keys(facts).length === 0) return null;
  return { ...data, prompt_facts: facts };
}

/* ──────────────────────────────── run outcomes ──────────────────────────────── */

/** Map a step outcome onto the run's state. `null` means the loop takes another turn. */
async function finish(deps: RunDeps, run: RunRow, outcome: StepOutcome, steps: number): Promise<RunResult | null> {
  switch (outcome.kind) {
    case "continue":
      return null;
    case "awaiting":
      // parkRunOnTimer already moved the run inside its own transaction.
      return { runId: run.id, created: false, state: "WAITING_TOOL", steps, awaiting: outcome.parked, reason: `awaiting ${outcome.parked.jobKey}` };
    case "done":
      return move(deps, run, "SUCCEEDED", steps);
    case "blocked":
    case "failed":
      return fail(deps, run, outcome.reason, steps);
    case "lost":
      // Someone else owns this run now. Leave its state to them and report what it is.
      return { runId: run.id, created: false, state: (await loadRun(deps.db, run.id))?.state ?? run.state, steps, reason: outcome.reason };
  }
}

async function fail(deps: RunDeps, run: RunRow, reason: string, steps: number): Promise<RunResult> {
  return move(deps, run, "FAILED", steps, reason);
}

/**
 * The run's last guarded move. `false` means it is not RUNNING any more — a human took it over
 * (ABORTED_SUPERSEDED_BY_HUMAN) or another driver finished it — so the state reported is the one
 * the row actually holds rather than the one this driver intended.
 */
async function move(deps: RunDeps, run: RunRow, to: RunState, steps: number, reason?: string): Promise<RunResult> {
  const moved = await setRunState(deps.db, run.id, "RUNNING", to, runActor(run.id));
  if (moved) return { runId: run.id, created: false, state: to, steps, reason };
  const fresh = await loadRun(deps.db, run.id);
  return {
    runId: run.id, created: false, state: fresh?.state ?? run.state, steps,
    reason: `run moved on before this driver could mark it ${to}`,
  };
}

function message(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).slice(0, 300);
}
