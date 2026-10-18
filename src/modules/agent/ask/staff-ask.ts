/**
 * A STAFF ASK — what happens when somebody types into the chat bubble and presses send.
 *
 * The founder's ask was a bubble "that opens the agent chat from any screen". This is the half
 * behind the compose bar, and the whole of its design is **that there is nothing new behind it**:
 *
 *   ask → one `ops.task` row (`raiseTask`, the writer every executor already uses)
 *       → a `staff.ask` trigger carrying that row's id
 *       → `agentRunner()` → the one run loop → the one gateway → the one policy engine
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
 *  2. **No runner.** `agentRunner()` refuses in this deployment: there is no §11.1 context
 *     assembler, and a run driven against a scope this process invented is worse than no run
 *     (run/deps.ts). That is the "model unavailable" case, and the answer to it is the **staff
 *     alert** of docs/DATA-MODEL.md — an open NEEDS_PERSON task, RED, with no proposal on it.
 *  3. **The model could not be reached** once a run was started: a gateway `PROVIDER_ERROR`, a
 *     missing key, a vendor refusal. Same answer, same row.
 *
 * What is deliberately **not** here: a keyword or text-parser fallback. `providers/keyword.ts`
 * exists on this branch and is reachable from the remote adapter's model chain, but nothing in
 * this module's import graph reaches it (staff-ask.db.test.ts walks that graph), and the degraded
 * mode is a person rather than a worse machine (founder's rule; docs/DATA-MODEL.md M3).
 *
 * `OPENROUTER_API_KEY` is never read here. The key is the remote adapter's, by env-var name only
 * (providers/remote.ts), and nothing on this path logs, prints or returns it.
 */
import { uuidv7 } from "uuidv7";
import type { Db } from "@/db/exec";
import { previewSkip } from "@/db/read-only";
import { agentAsk } from "@/ui/copy";
import { redact } from "../redact";
import { type AgentRunner, agentRunner } from "../run/deps";
import { effectId, raiseTask } from "../run/exec/effects";
import type { RunDeps, RunResult } from "../run/loop";
import { startAndDriveRun } from "../run/loop";
import { type Trigger, assertTrigger } from "../run/triggers";

/** `ops.task.category` for the ask itself. Free text in the column; no migration. */
export const STAFF_ASK_TASK_CATEGORY = "STAFF_ASK";

/**
 * `ops.task.category` for the staff alert (docs/DATA-MODEL.md: "kind NEEDS_PERSON, reason
 * MODEL_UNAVAILABLE"). Severity RED, state OPEN, no proposal attached — it is read in Family
 * texts → For you by the two roles that may decide, which is the same gate the bubble itself is
 * drawn behind.
 */
export const STAFF_ALERT_TASK_CATEGORY = "NEEDS_PERSON";

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
  /** The run this ask started, and where it got to. */
  | { readonly ok: true; readonly outcome: "ran"; readonly taskId: string; readonly run: RunResult };

export type StaffAskDeps = {
  /**
   * The deps a run is driven with, or the named refusal. Defaults to `agentRunner()`, which
   * refuses in this deployment; a suite passes a harness's deps to drive the loop for real.
   */
  readonly runner?: () => AgentRunner;
  /** How a run is started and driven. Defaults to the one the queue consumer uses. */
  readonly drive?: (deps: RunDeps, trigger: Trigger) => Promise<RunResult>;
  readonly env?: Record<string, string | undefined>;
};

/**
 * What a bounded, storable ask looks like. `null` for anything that is not one.
 *
 * `redact` is the module's own leak scrubber (agent/redact.ts): a phone number or an address
 * typed into the bubble is still a phone number or an address, and this row is read on a board.
 */
export function normalizeAsk(text: string): string | null {
  const trimmed = text.trim().replace(/\s+/g, " ");
  if (!trimmed || trimmed.length > MAX_ASK_LENGTH) return null;
  return redact(trimmed);
}

/**
 * The words of the ask, back out of the row it was stored in.
 *
 * `raiseTask` has one `summary` column and a board row has to say *what it is*, so an ask is
 * stored as "<what this row is>: <what was asked>". The thread in the bubble wants only the
 * second half — it already knows what the row is, because it is drawing it as a message — so the
 * prefix is taken off here rather than parsed at the far end. One function, both directions.
 */
export function askTextOf(summary: string): string {
  for (const prefix of [agentAsk.asked.summary, agentAsk.unavailable.summary]) {
    if (summary.startsWith(`${prefix}: `)) return summary.slice(prefix.length + 2);
  }
  return summary;
}

export async function askAgent(
  db: Db,
  input: StaffAskInput,
  deps: StaffAskDeps = {},
): Promise<StaffAskResult> {
  // 1. Previews write nothing. Asked before any row is derived, as on every queue route.
  const skip = previewSkip(deps.env ?? process.env);
  if (skip) return { ok: false, outcome: "skipped", ...skip };

  const ask = normalizeAsk(input.text);
  if (!ask) return { ok: false, outcome: "rejected" };

  /*
   * 2. Can anything answer? Asked *before* the row is written, because the answer decides what
   * the row is: the ask the agent took, or the staff alert nobody could. One ask is one row
   * either way — a second row saying the same thing twice is two things to close.
   */
  const runner = (deps.runner ?? (() => agentRunner(db, deps.env ?? process.env)))();
  const askId = uuidv7();
  const words = runner.ok ? agentAsk.asked : agentAsk.unavailable;
  const taskId = await raiseTask(db, {
    id: askId,
    siteId: input.siteId,
    category: runner.ok ? STAFF_ASK_TASK_CATEGORY : STAFF_ALERT_TASK_CATEGORY,
    severity: runner.ok ? "AMBER" : "RED",
    words: { summary: `${words.summary}: ${ask}`, nextStep: words.nextStep, predicate: words.predicate },
    by: input.by,
  });

  // 3. The staff alert is the whole of the degraded mode. No parser, no template, no proposal.
  if (!runner.ok) return { ok: false, outcome: "unavailable", taskId, reason: runner.reason };

  // 4. The one run loop, entered the way every other trigger enters it.
  const trigger: Trigger = { type: "staff.ask", id: taskId, siteId: input.siteId };
  assertTrigger(trigger);
  try {
    const run = await (deps.drive ?? startAndDriveRun)(runner.deps, trigger);
    return { ok: true, outcome: "ran", taskId, run };
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
    return { ok: false, outcome: "unavailable", taskId: alertId, reason: "the model could not be reached" };
  }
}
