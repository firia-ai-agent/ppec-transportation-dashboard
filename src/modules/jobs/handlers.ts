import { AGENT_ESCALATE_JOB_KIND, agentEscalateHandler } from "@/modules/agent/run/exec/escalate";
import { AGENT_RESUME_JOB_KIND, agentResumeHandler } from "@/modules/agent/run/timers";
import { vercelQueueAgentTransport } from "@/modules/agent/run/vercel-queue";
import { SIM_STATUS_JOB_KIND, simStatusHandler } from "@/modules/messaging/sim-provider";
import type { Handlers } from "./runner";

/**
 * Registered timer kinds. Domain timers (T−90 capability request, 10-min therapist ack, EOD, …) are added
 * by their milestones (B-04/B-06/B-14). `noop.test` exists for the TEST-INF-01 harness and smoke checks.
 */
export const handlers: Handlers = {
  "noop.test": async () => {},
  // B-04: the SIM provider's delivery status callback (SENT → DELIVERED / FAILED).
  [SIM_STATUS_JOB_KIND]: simStatusHandler,
  // B-08 slice 2 (§11.1): an awaited external response came due — re-trigger the parked run, and
  // publish the `ppec-agent` wake-up that drives it (after the claim transaction commits, which is
  // what `fire` hands handlers an `afterCommit` for). The transport is wired here, with the other
  // platform wiring, so `timers.ts` stays testable with a fake one.
  [AGENT_RESUME_JOB_KIND]: agentResumeHandler(vercelQueueAgentTransport),
  // B-08 slice 4 (§11.2 "no reply → escalate"): nobody answered — raise the exception, no model.
  [AGENT_ESCALATE_JOB_KIND]: agentEscalateHandler,
};
