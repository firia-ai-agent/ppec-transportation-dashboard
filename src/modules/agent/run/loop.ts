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
 *      makes the second attempt a no-op at the sink rather than a second effect — and it is
 *      re-decided **tighten-only** first (`tightenOnResume`), so a pause or a withdrawn consent
 *      that landed during the outage refuses the step instead of being outrun by it.
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
import { type PolicyContext, type PolicyDecision, evaluate } from "../policy";
import type { ContextAssembler } from "./context";
import type { ProposalWriter } from "./exec/proposals";
import type { ExecutorCall, ToolExecution, ToolExecutors } from "./executors";
import {
  AgentRunError,
  type CommittedCall,
  type RunRow,
  type RunState,
  type ToolCallRow,
  TERMINAL_RUN_STATES,
  commitCall,
  committedCalls,
  loadRun,
  pendingCall,
  pendingPolicyTasks,
  persistCall,
  recordPromptHash,
  resumableRuns,
  runActor,
  setRunState,
  startRun,
  storableArgs,
  toolCalls,
} from "./store";
import { policyTaskIds, writePolicyTasks } from "./tasks";
import { type ParkedAwait, parkRunOnTimer } from "./timers";
import type { Trigger } from "./triggers";

export type RunDeps = {
  readonly db: Db;
  /** The slice-1 gateway. Its `config` is also where the loop's step budget comes from. */
  readonly gateway: LlmGateway;
  /** §11.1 tier assembly, called fresh on every model turn (context.ts). */
  readonly assemble: ContextAssembler;
  readonly executors: ToolExecutors;
  /**
   * What a `human`-tier call writes instead of executing: the §11.2 proposal rows, written in the
   * transaction that commits the PROPOSED call (exec/proposals.ts). Optional — with none, a
   * proposal is a recorded decision and nothing else.
   */
  readonly proposals?: ProposalWriter;
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

export type DriveOpts = {
  /**
   * The site this driver is driving runs **for**, and the tenant fence on a run id (PR #35 review,
   * F3). A run belonging to any other site is refused rather than driven: a run id arrives from a
   * queue payload or an HTTP route, and neither is an authorization to touch a row. `startAndDriveRun`
   * passes the trigger's site and `resumeQueuedRuns` passes the site it selected by, so every entry
   * point into the loop is fenced; a caller with no site in hand may omit it, which is what the
   * suites that drive a run they just started do.
   */
  readonly siteId?: string;
  /**
   * What this driver stamps on `ops.agent_run.updated_by` — its own identity, defaulting to the
   * run's (`runActor`). The per-run lease passes its claim token here (`run/lease.ts`, F2), which
   * is what makes the lease hold *across* a drive: `updated_by` is the holder slot, so every write
   * the loop makes to the run row re-states the claim instead of standing it down, and a row that
   * comes back stamped with somebody else's actor means this driver has been taken over — checked
   * before each turn, so a reclaimed run costs at most the turn in flight.
   *
   * Only the **run row** is stamped with it. The tool-call rows keep `runActor(runId)`: a call
   * belongs to the run, not to whichever process happened to settle it.
   */
  readonly actor?: string;
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
  const result = await driveRun(deps, runId, { siteId: trigger.siteId });
  return { ...result, created };
}

/**
 * Drive one run to its next stopping point: finished, parked on a timer, or stopped fail-shut.
 *
 * Safe to call on a run that is already finished (no-op), already waiting on a timer (no-op — the
 * timer is what re-triggers it), or interrupted mid-step (resume).
 *
 * **Two drivers on one run are kept apart by the per-run lease, not by this function** (F2,
 * `run/lease.ts`). The lease is the queue route's, for the same reason B-03's claim belongs to its
 * consumer and not to its handlers: `driveRunLeased` claims the run, hands the claim token down as
 * `opts.actor`, and releases it. Reached that way, a second driver is refused before it takes a
 * turn, and this loop re-checks the claim before every turn so a reclaim ends the drive it lost.
 * Called **without** a lease — the in-process callers and the suites, which drive a run they just
 * started — what bounds a double driver is what always did: the `(run_id, seq)` unique index and
 * the per-call idempotency key, so the worst case there is a wasted model turn and never a second
 * effect.
 *
 * `opts.siteId` is the tenant fence: a run of another site is refused, with no state touched. The
 * refusal is a throw rather than a `RunResult` because it is not an outcome of *that run* — the run
 * is innocent and must not be recorded FAILED because somebody else asked about it.
 */
export async function driveRun(deps: RunDeps, runId: string, opts: DriveOpts = {}): Promise<RunResult> {
  const clock = deps.now ?? systemClock;
  const loaded = await loadRun(deps.db, runId);
  if (!loaded) throw new AgentRunError(`no agent run ${runId}`);
  // 404 rather than 403, as everywhere else (policy.ts step 7): the message does not say whose it
  // is, because a driver that could tell "no such run" from "another tenant's run" is an existence
  // oracle for every other site in the database.
  if (opts.siteId !== undefined && loaded.siteId !== opts.siteId) {
    throw new AgentRunError(`no agent run ${runId} in this site`);
  }
  if (TERMINAL_RUN_STATES.has(loaded.state)) {
    return { runId, created: false, state: loaded.state, steps: 0, reason: "run already finished" };
  }
  if (loaded.state === "WAITING_TOOL") {
    // §11.1: the timer re-triggers the run. Resuming it now would be the waiting session the PRD
    // forbids, one function call later.
    return { runId, created: false, state: loaded.state, steps: 0, reason: "run is parked on a timer" };
  }
  // The actor every write to *this row* carries from here on, the lease's claim token included.
  // Stamped first by the claim below, which is why a run re-queued by its timer handler (whose own
  // actor is `system:job:…`) is this driver's from its first turn rather than looking taken over.
  const actor = opts.actor ?? runActor(runId);
  const claimed = await setRunState(deps.db, runId, loaded.state, "RUNNING", actor);
  if (!claimed) {
    const fresh = await loadRun(deps.db, runId);
    return { runId, created: false, state: fresh?.state ?? loaded.state, steps: 0, reason: "run moved on before this driver claimed it" };
  }
  const run: RunRow = { ...loaded, state: "RUNNING", updatedBy: actor };

  let steps = 0;
  let calls = await toolCalls(deps.db, runId);

  // 1. Resume: a step that was persisted but never committed. Its idempotency key is the original,
  //    so an effect that did happen before the crash is not repeated — and its decision is the one
  //    it was persisted with, except that it may be **tightened** first (`tightenOnResume`).
  const interrupted = pendingCall(calls);
  if (interrupted) {
    steps += 1;
    const at = clock();
    const committed = committedCalls(calls);
    const redecided = await retighten(deps, run, interrupted, committed, at);
    if (!redecided.ok) return fail(deps, run, redecided.reason, steps);
    const outcome = await settleCall(deps, run, interrupted, committed, at, redecided.tightened);
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
    // And whose it is, not only what state it is in: the row's actor is the lease's holder slot
    // (`opts.actor`), so a different one means a reclaiming driver owns the run now. Stop here —
    // the next turn would be the second driver the lease exists to prevent, and this one has
    // already lost the right to settle a step (`commitCall` is fenced on PENDING either way).
    if (live.updatedBy !== actor) {
      return { runId, created: false, state: live.state, steps, reason: "run was reclaimed by another driver" };
    }
    const at = clock();
    const committed = committedCalls(calls);
    const assembled = await deps.assemble({ runId, trigger: run.trigger, committed, now: at });
    const wrongSite = scopeSiteRefusal(run, assembled.policy);
    if (wrongSite) return fail(deps, run, wrongSite, steps);
    let turn: GatewayResult;
    try {
      turn = await deps.gateway.complete({ runId, prompt: assembled.prompt, tools: assembled.tools });
    } catch (e) {
      if (deps.isFatal?.(e)) throw e;
      // A refusal (leaking prompt, free text, unknown tool, invalid args, rate limit) is already a
      // row in the gateway's audit log, and nothing was executed. The run stops there.
      return fail(deps, run, `gateway refused the turn: ${message(e)}`, steps);
    }
    await recordPromptHash(deps.db, runId, turn.promptHash, actor);

    const decision = evaluate(turn.call, assembled.policy);
    const row = await persistCallFor(deps, run, calls.length, turn, decision);
    steps += 1;

    // Nothing above this line executed anything; nothing below it runs without that row committed.
    const outcome = await settleCall(deps, run, row, committed, at);
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
  // The fence is redundant here — `resumableRuns` selected by site — and passed anyway, so that
  // the site a run is driven for is stated at every entry point rather than implied by a query.
  for (const r of runs) out.push(await driveRun(deps, r.id, { siteId }));
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

/* ──────────────────── the run's site, and the context's ──────────────────── */

/**
 * Why the context this turn was assembled from is not this run's to use, or null when it is
 * (PR #35 review, F3).
 *
 * `FamilyScope.siteToken` is the tenant the assembler built the scope for, and `run.site_id` is the
 * site the run was started in. Everything downstream trusts both and compares neither: the policy
 * engine checks an argument against `scope.tokens`, while every executor reads and writes
 * `WHERE … site_id = call.siteId`, which comes off the run row. A context assembled for the wrong
 * site would therefore pass the scope check against *that* site's tokens and then be executed
 * against *this* site's rows — the one shape of cross-tenant write that the family-scope
 * post-validator cannot see, because each half is self-consistent.
 *
 * Checked before the model turn, so a mismatch costs no tokens, and fail-shut: the run stops. A
 * caller whose session and whose run disagree about the tenant has a bug that no retry fixes.
 */
function scopeSiteRefusal(run: RunRow, policy: PolicyContext): string | null {
  return policy.scope.siteToken === run.siteId
    ? null
    : "assembled context is scoped to another site than this run";
}

/* ──────────────────── re-deciding a resumed step, tighten-only ──────────────────── */

/** Loosest to tightest. A resume may move a step up this list and never down it. */
const VERDICT_RANK: Readonly<Record<PolicyDecision["verdict"], number>> = { ALLOW: 0, PROPOSAL: 1, BLOCK: 2 };

/** The rule a decision blocked or proposed on; for an ALLOW, its effect (`decisionLabel`'s tail). */
function decisionDetail(decision: PolicyDecision): string {
  return decision.verdict === "ALLOW" ? decision.effect : decision.rule;
}

/**
 * What a resumed step's verdict becomes, given the verdict it was persisted with and the verdict
 * the *current* context produces: the fresh one when it is strictly tighter, and `null` — keep the
 * persisted one — otherwise.
 *
 * Both halves matter, and they are not symmetrical.
 *
 * **Tighten.** A PENDING ALLOW row is a step that was permitted when it was written down and whose
 * effect may not have happened yet. If the agent was paused in the meantime, or the family withdrew
 * consent, or a human took the thread over, then executing it now is the paused agent sending a
 * message — the crash would have bought the model an exemption from the kill switch. So the current
 * context gets to refuse it, through the same `policy.evaluate` a fresh call goes through.
 *
 * **Never loosen.** The reverse is not allowed for the reason the original slice-2 comment gives: a
 * BLOCK was decided against the context of the turn that produced it, and re-deciding it against a
 * context that has since become permissive is not a resume, it is a different call that nobody's
 * model asked for. A persisted BLOCK therefore stays BLOCKED however agreeable policy has become
 * (`resume.test.ts`), and a PROPOSAL never becomes an ALLOW.
 */
export function tightenOnResume(
  persisted: PolicyDecision["verdict"],
  fresh: PolicyDecision,
): PolicyDecision | null {
  return VERDICT_RANK[fresh.verdict] > VERDICT_RANK[persisted] ? fresh : null;
}

/** `null` tightened = settle the row on the decision it was persisted with. */
type Redecided =
  | { readonly ok: true; readonly tightened: PolicyDecision | null }
  | { readonly ok: false; readonly reason: string };

/**
 * Re-decide one resumed step against the context as it is now, and refuse to loosen it.
 *
 * The re-decision is taken on the **stored** arguments, which for an allowed call are the ones the
 * policy engine sanitized and the executor is about to be handed — so what is judged is what would
 * run. A persisted BLOCK is skipped: it is already the tightest verdict there is, and asking again
 * could only produce a looser one.
 */
async function retighten(
  deps: RunDeps,
  run: RunRow,
  row: ToolCallRow,
  committed: readonly CommittedCall[],
  at: Date,
): Promise<Redecided> {
  const persisted = persistedVerdict(row.policyDecision).verdict;
  if (persisted === "BLOCK") return { ok: true, tightened: null };
  const assembled = await deps.assemble({ runId: run.id, trigger: run.trigger, committed, now: at });
  const wrongSite = scopeSiteRefusal(run, assembled.policy);
  if (wrongSite) return { ok: false, reason: wrongSite };
  const fresh = evaluate({ tool: row.tool, args: row.args }, assembled.policy);
  return { ok: true, tightened: tightenOnResume(persisted, fresh) };
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
    // The decision's tasks ride on the row, because the decision itself does not survive a
    // restart: whichever driver commits this block is the one that raises them (store.ts).
    tasks: blocked ? decision.tasks : undefined,
  });
}

/**
 * Take one persisted call to its committed outcome. Called both for a fresh step and for a step
 * being resumed, and it cannot tell the difference — which is the point: the row is the whole
 * input, so "execute it" and "finish executing it" are one code path.
 *
 * `tightened` is the one thing a resume may add: the stricter verdict the *current* context gives
 * the same call (`tightenOnResume`). It replaces the persisted verdict for this settlement and is
 * recorded on the committed row as `tightened_on_resume`, so a step that was allowed when it was
 * written down and refused when it ran says both things. The row's `policy_decision` column is
 * never rewritten — it is the decision the call was persisted with, which is a different fact.
 */
async function settleCall(
  deps: RunDeps,
  run: RunRow,
  row: ToolCallRow,
  committed: readonly CommittedCall[],
  at: Date,
  tightened: PolicyDecision | null = null,
): Promise<StepOutcome> {
  const by = runActor(run.id);
  const persisted = persistedVerdict(row.policyDecision);
  const verdict = tightened?.verdict ?? persisted.verdict;
  const detail = tightened ? decisionDetail(tightened) : persisted.detail;
  /** What the committed row says about having been re-decided at effect time, when it was. */
  const retightened = tightened ? { tightened_on_resume: `${persisted.verdict}:${persisted.detail}` } : {};

  // A blocked call never executes, and the AGT-02 evidence — "out-of-policy tool call rejected +
  // logged" — is two writes, not one: the row goes BLOCKED with its rule, and every task the
  // decision raised (a staff_review for the refused step, an identity_change_request when the
  // thread claims a new number) becomes an `ops.task` row a coordinator can act on.
  //
  // One transaction, because the fence is what makes the tasks exactly-once: the commit matches a
  // row only while it is PENDING, so a second driver — or this one, resuming after a crash — gets
  // zero rows, writes no tasks, and reports the step as someone else's. The task payload is read
  // off the row rather than from a re-evaluation (store.ts), and the task ids are derived from the
  // call's idempotency key, so a replay that got past the fence would still write nothing
  // (tasks.ts).
  if (verdict === "BLOCK") {
    // The tasks of whichever decision is being recorded: the persisted one's, parked on the row at
    // persist time, or — when the resume is what refused the step — the fresh decision's.
    const tasks = tightened?.verdict === "BLOCK" ? tightened.tasks : pendingPolicyTasks(row);
    // Derived, not read back, so the committed row can name the tasks it opened in the same write.
    const taskIds = policyTaskIds(row, tasks);
    const result = {
      blocked_rule: detail,
      ...retightened,
      ...(taskIds.length === 0 ? {} : { task_ids: taskIds }),
    };
    const committed = await deps.db.tx(async (tx) => {
      if (!(await commitCall(tx, row.id, "BLOCKED", result, by))) return false;
      await writePolicyTasks(tx, { run, call: row, tasks, by });
      return true;
    });
    if (!committed) return lost(row);
    return { kind: "blocked", reason: `policy blocked ${row.tool} (${detail})` };
  }
  // A proposal mutates nothing and sends nothing; it waits for a human. The run is finished —
  // §11.1 has no notion of a run that waits for an approval, it has a proposal row and a task.
  //
  // `proposals` is the seam for the rows a §11.2 `propose_*` call implies (an `ops.change_request`,
  // an `ops.approval_request`, the exception task). It is deliberately *not* an executor: the loop
  // must have no code path on which a human-tier call runs one. The writer runs inside the
  // transaction that commits the PROPOSED row, so a proposal and the record of it cannot come
  // apart; with no writer configured the behaviour is the slice-2 one, a recorded decision.
  if (verdict === "PROPOSAL") {
    const result: Record<string, unknown> = { proposal_rule: detail, approval_key: row.argsHash, ...retightened };
    const writer = deps.proposals;
    const ok = writer
      ? await deps.db.tx(async (tx) => {
          const extra = await writer(tx, {
            runId: run.id, callId: row.id, siteId: run.siteId, seq: row.seq, tool: row.tool,
            args: row.args, idempotencyKey: row.idempotencyKey, approvalKey: row.argsHash, now: at,
          });
          return commitCall(tx, row.id, "PROPOSED", { ...result, ...extra }, by);
        })
      : await commitCall(deps.db, row.id, "PROPOSED", result, by);
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
    committed,
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
  // `run.updatedBy` is this driver's actor (`DriveOpts.actor`), so the run's last write re-states
  // the claim it was driven under instead of handing the row to a generic one.
  const moved = await setRunState(deps.db, run.id, "RUNNING", to, run.updatedBy);
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
