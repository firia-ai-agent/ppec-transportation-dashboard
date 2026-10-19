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
 * thing worse than a missing executor is a lying one. `SEQUENCED_EXECUTORS` names them, and
 * `docs/agent/B08-SLICE1-DEFERRED.md` says what each still owes.
 */
import { MESSAGE_SEND_TOOLS } from "@/modules/approvals/message-send";
import type { ToolExecutors } from "../executors";
import { TOOL_NAMES } from "../../tools";
import { cancelAttendanceOrLegExecutor } from "./cancel";
import { reportBoardingExecutor } from "./boarding";
import { recordCapabilityReportExecutor, requestProviderCapabilityExecutor } from "./capability";
import { recordAcknowledgmentExecutor } from "./clarify";
import type { ExecutorDeps } from "./effects";
import { type ProposalWriter, proposalWriter } from "./proposals";
import { getLegStateExecutor, readGuardianThreadExecutor, resolveSenderExecutor } from "./reads";
import { closeTaskExecutor, escalateExceptionExecutor, replyToStaffExecutor, summarizeThreadForStaffExecutor } from "./staff";
import { notifyAffectedTherapistExecutor } from "./therapist";

export type { ExecutorDeps } from "./effects";

/** The §11.2 tools with a live executor, in catalog order. */
export function liveExecutors(deps: ExecutorDeps): ToolExecutors {
  return {
    resolve_sender: resolveSenderExecutor(deps),
    get_leg_state: getLegStateExecutor(deps),
    /*
     * The read the bubble's answer comes from (Firia and Vera, 11:13 AM ET). `read` effect, so it
     * is one of the tools that stay available while the agent is paused: a paused deployment must
     * still be able to tell a coordinator what a parent asked for.
     */
    read_guardian_thread: readGuardianThreadExecutor(deps),
    cancel_attendance_or_leg: cancelAttendanceOrLegExecutor(deps),
    /*
     * NO `request_clarification` and NO `send_followup` here any more (Firia's S1-7 ruling,
     * 2026-10-18). Both are `human`-tier `propose` tools now, so the loop must have no executor
     * to reach for them: they are in `PROPOSAL_ONLY_TOOLS` below, and what they write is a
     * `MESSAGE_SEND` approval row for a person to decide.
     */
    record_acknowledgment: recordAcknowledgmentExecutor(deps),
    notify_affected_therapist: notifyAffectedTherapistExecutor(deps),
    request_provider_capability: requestProviderCapabilityExecutor(deps),
    record_capability_report: recordCapabilityReportExecutor(deps),
    report_boarding: reportBoardingExecutor(deps),
    escalate_exception: escalateExceptionExecutor(deps),
    close_task: closeTaskExecutor(deps),
    summarize_thread_for_staff: summarizeThreadForStaffExecutor(deps),
    reply_to_staff: replyToStaffExecutor(),
  };
}

/**
 * The `human`-tier writer. A proposal is not an executor — the loop never calls one for a
 * `human`-tier call, because §11.2 says those tools mutate nothing — so the proposal rows are
 * written in the same transaction that commits the PROPOSED call (loop.ts).
 */
export function liveProposalWriter(deps: ExecutorDeps): ProposalWriter {
  return proposalWriter(deps);
}

/**
 * Catalog tools with no live executor. **Empty as of slice 4**: all thirteen `auto`-tier tools act
 * on real state, and the three `human`-tier ones write proposals instead, which is what §11.2
 * gives them. The constant stays because the *rule* it stands for does — a tool absent from
 * `liveExecutors` fails its step shut with `NO_EXECUTOR` rather than letting a stub answer "done",
 * and the seventeenth tool has to be placed in one of these three groups deliberately
 * (`unaccountedTools`).
 */
export const SEQUENCED_EXECUTORS: readonly string[] = [];

/**
 * The `human`-tier tools: §11.2 gives them a proposal, never an effect (policy.ts step 11).
 *
 * `propose_dropoff_change` is here rather than in `liveExecutors` for the reason the whole tier
 * exists: a requested drop-off time is a thing a person decides. The agent writes the row;
 * `modules/approvals/decide.ts` is the only code that moves the leg.
 *
 * `send_followup` and `request_clarification` joined them on Firia's S1-7 ruling (2026-10-18).
 * They are not proposals *about* the plan — they send nothing and change nothing, and what waits
 * for a person is the message itself (`MESSAGE_SEND`, `modules/approvals/message-send.ts`). A
 * tool in this list has no executor by construction: the loop's `PROPOSAL` branch never reaches
 * for one, so there is no code path on which the agent texts a family on its own authority.
 */
export const PROPOSAL_ONLY_TOOLS: readonly string[] = [
  "propose_manifest_reallocation",
  "propose_dropoff_change",
  "propose_contact_or_profile_change",
  ...MESSAGE_SEND_TOOLS,
];

/**
 * Every catalog tool is accounted for exactly once: live, proposal-only, or named as deferred.
 * Asserted against `TOOL_NAMES` in the suite, so the sixteenth tool has to be placed.
 */
export function unaccountedTools(deps: ExecutorDeps): string[] {
  const placed = new Set([...Object.keys(liveExecutors(deps)), ...PROPOSAL_ONLY_TOOLS, ...SEQUENCED_EXECUTORS]);
  return TOOL_NAMES.filter((t) => !placed.has(t));
}
