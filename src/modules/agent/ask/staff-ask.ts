/**
 * A STAFF ASK — what happens when somebody types into the chat bubble and presses send.
 *
 * The founder's ask was a bubble "that opens the agent chat from any screen". This is the half
 * behind the compose bar, and the whole of its design is **that there is nothing new behind it**:
 *
 *   ask → one `ops.task` row (`raiseTask`, the writer every executor already uses)
 *       → a `staff.ask` trigger carrying that row's id
 *       → `agentRunner(db, env)` → the one run loop → the one gateway → the one policy engine
 *
 * There is no second agent, no second prompt pipeline, no second policy and no second approvals
 * table. A `propose_*` call from this run is a `PROPOSED` call row plus the `ops.approval_request`
 * / `ops.change_request` that `liveProposalWriter` already writes, decided by a person on the one
 * surface that decides them. No executor runs for a `propose_*` — the policy engine returns
 * PROPOSAL for every `human`-tier call and the loop never looks for an executor (exec/proposals.ts
 * says this at length) — so there is no code path on which an ask applies a change.
 *
 * THREE REFUSALS, all of them no-ops with a name:
 *
 *  1. **A preview.** Previews share the one production database read-only (DECISION-LEDGER #43),
 *     so an ask writes *nothing at all* — not the task, not the run. `previewSkip` is asked first,
 *     before any row is derived, for the same reason the queue routes ask it first.
 *  2. **No model.** `agentRunner(db, env)` is the real runner the agent queue consumer drives
 *     with (run/deps.ts), and two of its three answers are this refusal: `ok: false`, when no
 *     provider can be built from this deployment's configuration at all, and `ok: true` with
 *     `refused: true`, when one can be built but may not be *called* — no key, a deployment that
 *     has not confirmed demo-data-only operation, a base URL off the host allow-list. The second
 *     is a provider that refuses every turn (`run/provider-choice.ts`), so driving a run on it
 *     would spend a started run to arrive at exactly this answer; the ask stops before the run
 *     instead. That is the "model unavailable" case, and the answer to it is the **staff alert**
 *     of docs/DATA-MODEL.md — an open NEEDS_PERSON task, RED, with no proposal on it.
 *  3. **The model could not be reached** once a run was started: a gateway `PROVIDER_ERROR`, a
 *     missing key, a vendor refusal. Same answer, same row.
 *
 * What is deliberately **not** here: a keyword or text-parser fallback. The §18.1 reader was
 * deleted outright (no-keyword-fallback.test.ts), and nothing in this module's import graph is
 * named for the job it did or names one of its exports — staff-ask.db.test.ts walks that graph and
 * checks both. `providers/remote.ts` *is* on the path, and is meant to be: it is the live vendor
 * adapter, the one thing that calls the model, and its model chain ends in
 * `RemoteProviderUnavailable` with nothing behind it. The degraded mode is a person rather than a
 * worse machine (founder's rule; docs/DATA-MODEL.md M3).
 *
 * `OPENROUTER_API_KEY` is never read here. The key is the remote adapter's, by env-var name only
 * (providers/remote.ts), and nothing on this path logs, prints or returns it.
 */
import { uuidv7 } from "uuidv7";
import type { Db } from "@/db/exec";
import { previewSkip } from "@/db/read-only";
import { agentAsk } from "@/ui/copy";
import { tokenizeNames } from "@/modules/identity/names";
import { redact } from "../redact";
import { STAFF_ALERT_TASK_CATEGORY, STAFF_ASK_TASK_CATEGORY, askTextOf } from "./ask-text";
import { type AgentRunner, agentRunner } from "../run/deps";
import { effectId, raiseTask } from "../run/exec/effects";
import { askAnswer } from "./answer";
import type { RunDeps, RunResult } from "../run/loop";
import { startAndDriveRun } from "../run/loop";
import { type Trigger, assertTrigger } from "../run/triggers";

/*
 * The ask's two task categories and `askTextOf` are defined in `ask/ask-text.ts` and re-exported
 * here, where every caller already reads them from. They moved because the context assembler needs
 * the words of an ask (`run/staff-ask-context.ts`) and this module imports the run loop: defining
 * them here made that a cycle. See the header of `ask-text.ts`.
 */
export { STAFF_ASK_TASK_CATEGORY, STAFF_ALERT_TASK_CATEGORY, askTextOf };

/** The one longest ask the compose bar accepts. Longer is a document, not a question. */
export const MAX_ASK_LENGTH = 500;

export type StaffAskInput = {
  readonly siteId: string;
  /** What the person typed. Trimmed, bounded and redacted before it is stored. */
  readonly text: string;
  /** Who asked, as an audit actor — a user id, never a name. */
  readonly by: string;
};

export type StaffAskResult =
  /** A preview: nothing written, nothing driven. */
  | { readonly ok: false; readonly outcome: "skipped"; readonly skipped: string; readonly reason: string }
  /** Empty or oversized: nothing written. */
  | { readonly ok: false; readonly outcome: "rejected" }
  /**
   * No model could answer. The ask is on the board as the staff alert and nothing was driven.
   * `reason` is the runner's own sentence, for the log — never for a screen.
   */
  | { readonly ok: false; readonly outcome: "unavailable"; readonly taskId: string; readonly reason: string }
  /**
   * The run this ask started, where it got to, and what it said: the model's answer in names
   * (`ask/answer.ts`) and the proposal it made, if any.
   */
  | {
      readonly ok: true;
      readonly outcome: "ran";
      readonly taskId: string;
      readonly run: RunResult;
      readonly answer: string | null;
      readonly proposalId: string | null;
    };

/**
 * The log sentence for a runner that is `ok` and `refused` without words of its own. `run/deps.ts`
 * always has words, so this is the shape-level default rather than a message anybody should see.
 */
const NO_MODEL_CONFIGURED = "no model configured for this deployment";

export type StaffAskDeps = {
  /**
   * The deps a run is driven with, or the named refusal. Defaults to `agentRunner(db, env)`, the
   * one the agent queue consumer drives with; a suite passes a harness's deps instead, to drive
   * the loop against a scripted provider.
   */
  readonly runner?: () => AgentRunner;
  /** How a run is started and driven. Defaults to the one the queue consumer uses. */
  readonly drive?: (deps: RunDeps, trigger: Trigger) => Promise<RunResult>;
  readonly env?: Record<string, string | undefined>;
};

/**
 * What a bounded, storable ask looks like. `null` for anything that is not one.
 *
 * People first become the tokens the rest of the system uses (`identity/names.tokenizeNames`:
 * "what's wrong with Noah?" → "what's wrong with C2?"), so the model can answer about the child the
 * coordinator meant — redaction would leave it "[REDACTED:NAME]" and nothing to look up. Then
 * `redact`, the module's own leak scrubber (agent/redact.ts), takes whatever is still a phone
 * number or an address: this row is read on a board. The bubble turns the tokens back into first
 * names when it shows the ask (`ask/thread.ts`).
 */
export function normalizeAsk(text: string): string | null {
  const trimmed = text.trim().replace(/\s+/g, " ");
  if (!trimmed || trimmed.length > MAX_ASK_LENGTH) return null;
  return redact(tokenizeNames(trimmed));
}

/**
 * The runner's two answers as the two rows an ask can become: the deps to drive, or the sentence
 * saying why nothing will.
 *
 * `ok: true` with `refused: true` is folded in with `ok: false` on purpose, and that is the whole
 * of rule (1): a refused provider throws this deployment's refusal on the first turn, so a run
 * driven on it ends in the same staff alert with an `ops.agent_run` row and an audited failed call
 * behind it. One ask, one row, whichever way the runner refused.
 */
function askRunner(runner: () => AgentRunner): { readonly deps: RunDeps } | { readonly refused: string } {
  let answer: AgentRunner;
  try {
    answer = runner();
  } catch (e) {
    /*
     * A configuration no provider can be built from at all — a base URL off the host allow-list, a
     * model off it, a number that will not parse. `run/deps.ts` means that to be its `ok: false`
     * answer and reads the config outside the `try` that produces it, so the throw arrives here
     * instead. It is the same fact and it gets the same row: a person told, rather than a 503 with
     * nothing on the board, which is the founder's rule broken by a construction order.
     *
     * One sentence, bounded, for the log. An `AgentConfigError` names env vars and never carries a
     * value (config.ts), and this `reason` is not a field the route forwards.
     */
    return { refused: (e instanceof Error ? e.message : String(e)).slice(0, 280) };
  }
  if (!answer.ok) return { refused: answer.reason };
  if (answer.refused) return { refused: answer.reason ?? NO_MODEL_CONFIGURED };
  return { deps: answer.deps };
}

export async function askAgent(
  db: Db,
  input: StaffAskInput,
  deps: StaffAskDeps = {},
): Promise<StaffAskResult> {
  const env = deps.env ?? process.env;

  // 1. Previews write nothing. Asked before any row is derived, as on every queue route.
  const skip = previewSkip(env);
  if (skip) return { ok: false, outcome: "skipped", ...skip };

  const ask = normalizeAsk(input.text);
  if (!ask) return { ok: false, outcome: "rejected" };

  /*
   * 2. Can anything answer? Asked *before* the row is written, because the answer decides what
   * the row is: the ask the agent took, or the staff alert nobody could. One ask is one row
   * either way — a second row saying the same thing twice is two things to close.
   */
  const answer = askRunner(deps.runner ?? (() => agentRunner(db, env)));
  const canRun = "deps" in answer;
  const askId = uuidv7();
  const words = canRun ? agentAsk.asked : agentAsk.unavailable;
  const taskId = await raiseTask(db, {
    id: askId,
    siteId: input.siteId,
    category: canRun ? STAFF_ASK_TASK_CATEGORY : STAFF_ALERT_TASK_CATEGORY,
    severity: canRun ? "AMBER" : "RED",
    words: { summary: `${words.summary}: ${ask}`, nextStep: words.nextStep, predicate: words.predicate },
    by: input.by,
  });

  // 3. The staff alert is the whole of the degraded mode. No parser, no template, no proposal.
  if (!("deps" in answer)) return { ok: false, outcome: "unavailable", taskId, reason: answer.refused };

  // 4. The one run loop, entered the way every other trigger enters it.
  const trigger: Trigger = { type: "staff.ask", id: taskId, siteId: input.siteId };
  assertTrigger(trigger);
  try {
    /*
     * A HARD DEADLINE ON THE WHOLE ASK. The run is driven inside this request, and a request that
     * outlives the route's `maxDuration` is a 504 nobody is told about. So the ask gets
     * `askTimeoutMs` (config, default 45 s) and, if the model has not finished by then, it ends
     * the same way a model that could not be reached does: one alert, a person told.
     */
    const run = await withDeadline(
      (deps.drive ?? startAndDriveRun)(answer.deps, trigger),
      answer.deps.gateway.config.askTimeoutMs,
    );
    if (run === TIMED_OUT) throw new AskTimedOut();
    const said = await askAnswer(db, run.runId);
    /*
     * NEVER SILENT. A run can end with nothing to show for the ask — the model escalated, wrote a
     * note this roster cannot name, or the gateway refused its turn — and a panel that then says
     * nothing leaves the person staring at their own question. That is the same outcome for them
     * as a model that could not be reached, so it gets the same answer: one alert, a person told.
     */
    if (said.answer === null && said.proposalId === null) throw new AskUnanswered();
    return { ok: true, outcome: "ran", taskId, run, answer: said.answer, proposalId: said.proposalId };
  } catch (err) {
    /*
     * The model could not be reached after all — a gateway PROVIDER_ERROR, a missing key, a
     * vendor refusal. Same answer as (2): a person. A second row, because the first one said the
     * agent had taken it and that turned out not to be true; `effectId` makes it idempotent, so a
     * retried ask raises one alert rather than one per attempt.
     *
     * The error is never returned and never logged here: a provider's message can carry an
     * endpoint, a model name or — in the worst case — a header. The caller gets the fact.
     */
    void err;
    const alertId = await raiseTask(db, {
      id: effectId(taskId, "needs-person"),
      siteId: input.siteId,
      category: STAFF_ALERT_TASK_CATEGORY,
      severity: "RED",
      words: {
        summary: `${agentAsk.unavailable.summary}: ${ask}`,
        nextStep: agentAsk.unavailable.nextStep,
        predicate: agentAsk.unavailable.predicate,
      },
      by: input.by,
    });
    return {
      ok: false,
      outcome: "unavailable",
      taskId: alertId,
      reason:
        err instanceof AskTimedOut
          ? "TIMEOUT"
          : err instanceof AskUnanswered
            ? "NO_ANSWER"
            : "the model could not be reached",
    };
  }
}

class AskTimedOut extends Error {}
class AskUnanswered extends Error {}
const TIMED_OUT = Symbol("timed out");

/** `promise`, or TIMED_OUT once `ms` have passed. The loser is not awaited. */
function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(TIMED_OUT), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}
