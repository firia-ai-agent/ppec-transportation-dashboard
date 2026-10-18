/**
 * The handoff B-04 left open: an inbound family message starts an agent run (PRD §11.1
 * "Triggers: msg.inbound …; each run = job with idempotency (trigger_type, trigger_id)").
 *
 * `messaging/hook.ts` describes exactly this implementation and ships the no-op: "the agent runner
 * replaces the implementation with one that inserts `ops.agent_run` (unique on trigger_type +
 * trigger_id) and publishes a queue wake-up after commit". This is that implementation, and the
 * two halves of that sentence are the two things it has to get right:
 *
 *  - **the row goes in the webhook's own transaction**, with the message already written, so an
 *    agent run can never exist without its trigger message and a rolled-back ingest leaves no run
 *    behind. `startRun` is idempotent on `(trigger_type, trigger_id)` and the trigger id is the
 *    message row's id, so a redelivered webhook — the same provider message id — makes one run;
 *  - **the wake-up is published after commit**, because a consumer that reads the run row before
 *    the transaction lands finds nothing to drive. A failed publish is recoverable and a failed
 *    insert is not, which is why they are in that order and not the other.
 *
 * It is called only for a known sender on a message that is not our own echo (`ingestInbound`):
 * AT-09's unknown number starts no run, and MSG-03's echo starts no run, and neither decision is
 * this module's to re-make.
 *
 * The model and provider recorded on the run are the configured ones (`loadAgentConfig`) — the
 * routing a driver will use, written at trigger time so a run says which vendor it was started
 * for even if the config changes under it.
 */
import type { Exec } from "@/db/exec";
import type { InboundMessageHook } from "@/modules/messaging/hook";
import { loadAgentConfig } from "../config";
import { runWakeKey, type AgentWakeTransport } from "./queue";
import { startRun } from "./store";

export type InboundRunRouting = { readonly model: string; readonly provider: string };

/** The routing a run started now would use: the configured model and vendor, never a literal. */
export function configuredRouting(env: Record<string, string | undefined> = process.env): InboundRunRouting {
  const config = loadAgentConfig(env);
  return { model: config.model, provider: config.provider };
}

/**
 * The hook the SMS webhook passes to `ingestInbound`. One run per inbound message, one wake-up
 * per run, both idempotent.
 */
export function agentRunInboundHook(
  transport: AgentWakeTransport,
  routing: InboundRunRouting = configuredRouting(),
): InboundMessageHook {
  return async (tx: Exec, event, afterCommit) => {
    const { runId } = await startRun(
      tx,
      { type: "msg.inbound", id: event.messageId, siteId: event.siteId },
      routing,
    );
    afterCommit(() =>
      transport.publish({ runId, siteId: event.siteId }, { idempotencyKey: runWakeKey(runId) }),
    );
  };
}
