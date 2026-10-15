/**
 * Tool executors: the half of §11.2 that *does* something, and in B-08 slice 2 the half that
 * deliberately still does nothing but write down what it would have done.
 *
 * Slice 1 built the catalog as schemas and the policy engine that judges a call; slice 2 builds the
 * loop that persists and drives them. The 15 "Precondition → effect" columns of §11.2 — the leg
 * read, the cancel transition, the outbound, the exception row — are each a different module's
 * write path (B-02 state, B-04 outbox, B-12 tasks) and land with those milestones. Until then the
 * default registry here records **intent**: one entry per call, keyed by the call's idempotency
 * key, with no state change and no send. `docs/agent/B08-SLICE1-DEFERRED.md` lists the per-tool
 * work that is still missing, so an intent record cannot be mistaken for an executor.
 *
 * Two contracts a real executor has to keep, and which the recorder is shaped to demonstrate:
 *
 *  - **Idempotent on `idempotencyKey`.** A crash between the persist and the effect leaves a
 *    PENDING row whose effect may or may not have happened, and the loop's only safe answer is to
 *    re-drive it with the same key. The sink is what makes the second attempt a no-op — a unique
 *    `ops.outbound_message.idempotency_key`, or a version-guarded `transition()`. An executor that
 *    is not idempotent on this key *will* double-execute on resume, and nothing above it can fix
 *    that.
 *  - **Only `promptFacts` may reach the next prompt.** A result goes in `ops.agent_tool_call.result`
 *    in full; the next model turn sees only the tokenized facts the executor declares. That keeps
 *    TEST-SEC-01 true on the resume path as well: the prompt a resumed run builds is made of
 *    tokens by construction, not by hoping the tool result was clean.
 */
import { TOOL_NAMES } from "../tools";
import type { CommittedCall } from "./store";
import type { Trigger } from "./triggers";

/** What an executor is handed. The arguments are the stored, policy-sanitized ones (store.ts). */
export type ExecutorCall = {
  readonly runId: string;
  /** `ops.agent_tool_call.id` of the row that was persisted before this call. */
  readonly callId: string;
  readonly siteId: string;
  readonly seq: number;
  readonly tool: string;
  readonly args: Record<string, unknown>;
  /** The key every external effect of this call must be idempotent on (store.ts). */
  readonly idempotencyKey: string;
  readonly trigger: Trigger;
  readonly now: Date;
  /**
   * The calls of this run that have already committed, in order — the same list the prompt's
   * results block is built from, and the same one a resumed run inherits.
   *
   * It is here because §11.1's "T2 current state with versions, fetched via tools before every
   * write" has to be *enforceable* somewhere: an executor that writes needs to know what this run
   * established by reading, and the only trustworthy record of that is the committed results. A
   * model-supplied argument is not evidence that the state was read (`exec/effects.factsOf`).
   */
  readonly committed: readonly CommittedCall[];
};

/**
 * How a timer firing past the deadline decides whether the thing we were waiting for arrived.
 *
 * Deliberately a small closed union of **row references** rather than a predicate string: the
 * escalation handler is a B-03 handler, which is DB-only and holds no memory of the run, so what it
 * needs is the one row whose state answers the question (`exec/escalate.ts`). The awaited reply
 * itself has no id when the wait starts, which is why the clarification case watches the *thread*
 * from an instant rather than a row.
 */
export type AwaitWatch =
  | { readonly kind: "inbound_reply"; readonly threadId: string }
  | { readonly kind: "acknowledgment"; readonly ackId: string }
  | { readonly kind: "capability"; readonly capabilityId: string };

/**
 * §11.2's "no reply → escalate": a **second** deadline past the first, which raises the exception
 * without a model turn (AT-02's deterministic half).
 *
 * The first deadline re-triggers the run, which may ask or escalate with a turn of its own; this
 * one is what happens when nothing answers at all, and it costs nothing — a job, a read of the one
 * row that would show an answer, and an `ops.task` row if it does not.
 */
export type NoReplyEscalation = {
  /** From the same instant as `AwaitExternal.afterSeconds`, and necessarily later than it. */
  readonly afterSeconds: number;
  /** Which wait this was, which is how the handler picks the staff-facing words (`ui/copy.ts`). */
  readonly reason: "CLARIFICATION" | "ACKNOWLEDGMENT" | "CAPABILITY";
  /** `ops.task.category` — one of §11.2 `escalate_exception`'s own categories. */
  readonly category: string;
  readonly severity: "AMBER" | "RED";
  /** §11.2 `next_step`, as a code, exactly as the tool takes one. */
  readonly nextStepCode: string;
  readonly watch: AwaitWatch;
};

/** §11.1: "delayed external responses are tasks with timers, never waiting sessions." */
export type AwaitExternal = {
  /** Why the run is waiting, as a code. Goes in the task summary; never prose from a model. */
  readonly reasonCode: string;
  /** How long to wait before the timer re-triggers the run (§11.2: 15 min clarification, 10 min ack). */
  readonly afterSeconds: number;
  /** Staff-facing one-liner for the `ops.task` row. Written by the executor, not by the model. */
  readonly summary: string;
  /** `ops.task.completion_predicate`: what makes this task closable (AGT-04). */
  readonly completionPredicate: string;
  /** §11.2 "no reply → escalate", when this wait has such a deadline. */
  readonly escalation?: NoReplyEscalation;
  /**
   * The `ops.acknowledgment` this wait is for. Its `timer_job_id` is stamped with the escalation
   * job, so `record_acknowledgment` cancelling "the timer" cancels the thing that would have
   * escalated it (§11.2: "matching PENDING ack → close, cancel timer").
   */
  readonly acknowledgmentId?: string;
};

export type ToolExecution = {
  /** Defaults to "executed". "failed" records the attempt and fails the run. */
  readonly status?: "executed" | "failed";
  /** Stored in `ops.agent_tool_call.result`. */
  readonly data?: Record<string, unknown>;
  /** The only part of a result the next model turn may see. Tokens, codes and numbers only. */
  readonly promptFacts?: Record<string, string | number | boolean>;
  /** Park the run on a B-03 timer instead of taking another model turn. */
  readonly awaitExternal?: AwaitExternal;
  /** The run's work is complete after this call; no further model turn. */
  readonly done?: boolean;
};

export type ToolExecutor = (call: ExecutorCall) => Promise<ToolExecution>;
export type ToolExecutors = Readonly<Record<string, ToolExecutor>>;

/** One recorded intent. No prose, no recipients — the arguments are already policy-sanitized. */
export type ToolIntent = {
  readonly idempotencyKey: string;
  readonly runId: string;
  readonly seq: number;
  readonly tool: string;
  readonly args: Record<string, unknown>;
  readonly at: string;
};

export type IntentRecorder = {
  readonly executors: ToolExecutors;
  /** Intents in the order they were first recorded. One per idempotency key, ever. */
  readonly intents: readonly ToolIntent[];
  /** True when this call's effect has already been recorded (what a real sink's unique key does). */
  has(idempotencyKey: string): boolean;
  reset(): void;
};

/**
 * The P1 executor registry: every catalog tool records its intent and returns nothing else.
 *
 * The dedup on `idempotencyKey` is not a convenience — it is the stand-in for the sink that makes
 * resume safe, so a crash-and-resume test asserting "exactly one intent per key" is asserting the
 * same property a unique index asserts in production. `overrides` lets a caller (and the slice-2
 * suite) give one tool a real-ish executor without losing that property for the rest.
 */
export function intentRecorder(overrides: Readonly<Record<string, ToolExecutor>> = {}): IntentRecorder {
  const intents: ToolIntent[] = [];
  const seen = new Map<string, ToolExecution>();

  const record = (call: ExecutorCall, execution: ToolExecution): ToolExecution => {
    const already = seen.get(call.idempotencyKey);
    if (already) return already;
    intents.push({
      idempotencyKey: call.idempotencyKey,
      runId: call.runId,
      seq: call.seq,
      tool: call.tool,
      args: call.args,
      at: call.now.toISOString(),
    });
    seen.set(call.idempotencyKey, execution);
    return execution;
  };

  const executors: Record<string, ToolExecutor> = {};
  for (const tool of TOOL_NAMES) {
    const override = overrides[tool];
    executors[tool] = override
      ? async (call) => {
          // The override decides *what* happened; the recorder still owns the effect key, so an
          // overridden tool is as resume-safe as the default one.
          const already = seen.get(call.idempotencyKey);
          if (already) return already;
          return record(call, await override(call));
        }
      : async (call) =>
          record(call, {
            status: "executed",
            data: { intent: "recorded", tool: call.tool, prompt_facts: { [`${call.tool}_recorded`]: true } },
            promptFacts: { [`${call.tool}_recorded`]: true },
          });
  }

  return {
    executors,
    intents,
    has: (key) => seen.has(key),
    reset: () => {
      intents.length = 0;
      seen.clear();
    },
  };
}
