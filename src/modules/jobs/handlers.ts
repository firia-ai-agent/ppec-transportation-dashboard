import { AGENT_ESCALATE_JOB_KIND, agentEscalateHandler } from "@/modules/agent/run/exec/escalate";
import { AGENT_RESUME_JOB_KIND, AGENT_RETRY_JOB_KIND, agentResumeHandler, agentRetryHandler } from "@/modules/agent/run/timers";
import { vercelQueueAgentTransport } from "@/modules/agent/run/vercel-queue";
import { getNeonDb } from "@/db/exec";
import { SCRIPTED_REPLY_JOB_KIND, scheduleScriptedReply, scriptedReplyHandler } from "@/modules/demo/scripted-reply";
import { SIM_STATUS_JOB_KIND, simStatusHandler } from "@/modules/messaging/sim-provider";
import { vercelQueueOutboxTransport } from "@/modules/outbox/transport";
import { VercelQueueScheduler } from "./scheduler";
import { vercelQueueTransport } from "./vercel-queue";
import type { Handlers } from "./runner";

/**
 * Registered timer kinds. Domain timers (T−90 capability request, 10-min therapist ack, EOD, …) are added
 * by their milestones (B-04/B-06/B-14). `noop.test` exists for the TEST-INF-01 harness and smoke checks.
 */
export const handlers: Handlers = {
  "noop.test": async () => {},
  // B-04: the SIM provider's delivery status callback (SENT → DELIVERED / FAILED). On a demo
  // deployment a delivered re-plan late text to the scenario's family also schedules that
  // parent's reply (demo/scripted-reply.ts), in the same transaction as the status.
  [SIM_STATUS_JOB_KIND]: async (tx, job, afterCommit) => {
    await simStatusHandler(tx, job, afterCommit);
    const p = job.payload as { outboundMessageId?: string; to?: string };
    await scheduleScriptedReply(tx, afterCommit, new VercelQueueScheduler(getNeonDb(), vercelQueueTransport), {
      outboundMessageId: String(p.outboundMessageId ?? ""),
      status: String(p.to ?? ""),
      now: new Date(),
      env: process.env,
    });
  },
  // The scenario parent's reply, through the real inbound path (demo only, gated again inside).
  [SCRIPTED_REPLY_JOB_KIND]: scriptedReplyHandler({
    agentTransport: vercelQueueAgentTransport,
    outboxTransport: vercelQueueOutboxTransport,
  }),
  // B-08 slice 2 (§11.1): an awaited external response came due — re-trigger the parked run, and
  // publish the `ppec-agent` wake-up that drives it (after the claim transaction commits, which is
  // what `fire` hands handlers an `afterCommit` for). The transport is wired here, with the other
  // platform wiring, so `timers.ts` stays testable with a fake one.
  [AGENT_RESUME_JOB_KIND]: agentResumeHandler(vercelQueueAgentTransport),
  [AGENT_RETRY_JOB_KIND]: agentRetryHandler(vercelQueueAgentTransport),
  // B-08 slice 4 (§11.2 "no reply → escalate"): nobody answered — raise the exception, no model.
  [AGENT_ESCALATE_JOB_KIND]: agentEscalateHandler,
};
