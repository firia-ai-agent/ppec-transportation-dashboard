/**
 * The live executor registry: which §11.2 tools act on real state, and which do not yet.
 *
 * `run/executors.ts` `intentRecorder` is the slice-2 registry — every tool records intent and
 * nothing else — and it stays, because the loop suites test the loop and not the tools. This is the
 * other one: the executors that read and write the operational tables, through the existing domain
 * modules (`domain/transition`, `modules/outbox`, `modules/messaging`, B-03's `JobScheduler`).
 *
 * A tool **absent** from here has no live executor, and the loop's answer to that is
 * `NO_EXECUTOR`: the call is recorded FAILED and the run stops (loop.ts). That is deliberate —
 * a stub that answered "done" would be a tool reporting an effect it did not have, and the one
 * thing worse than a missing executor is a lying one. `DEFERRED_EXECUTORS` names them, and
 * `docs/agent/B08-SLICE1-DEFERRED.md` says what each still owes.
 */
import type { ToolExecutors } from "../executors";
import { TOOL_NAMES } from "../../tools";
import type { ExecutorDeps } from "./effects";
import { getLegStateExecutor, resolveSenderExecutor } from "./reads";

export type { ExecutorDeps } from "./effects";

/** The §11.2 tools slice 3 implements, in catalog order. */
export function liveExecutors(deps: ExecutorDeps): ToolExecutors {
  return {
    resolve_sender: resolveSenderExecutor(deps),
    get_leg_state: getLegStateExecutor(deps),
  };
}

/**
 * Catalog tools with no live executor yet. Each one fails its step shut rather than pretending,
 * and each is a row in B08-SLICE1-DEFERRED.md.
 */
export const DEFERRED_EXECUTORS: readonly string[] = [
  "cancel_attendance_or_leg",
  "request_clarification",
  "record_acknowledgment",
  "send_followup",
  "notify_affected_therapist",
  "request_provider_capability",
  "record_capability_report",
  "report_boarding",
  "escalate_exception",
  "close_task",
  "summarize_thread_for_staff",
];

/** The two `human`-tier tools: §11.2 gives them a proposal, never an effect (policy.ts step 11). */
export const PROPOSAL_ONLY_TOOLS: readonly string[] = [
  "propose_manifest_reallocation",
  "propose_contact_or_profile_change",
];

/**
 * Every catalog tool is accounted for exactly once: live, proposal-only, or named as deferred.
 * Asserted against `TOOL_NAMES` in the suite, so the sixteenth tool has to be placed.
 */
export function unaccountedTools(deps: ExecutorDeps): string[] {
  const placed = new Set([...Object.keys(liveExecutors(deps)), ...PROPOSAL_ONLY_TOOLS, ...DEFERRED_EXECUTORS]);
  return TOOL_NAMES.filter((t) => !placed.has(t));
}
