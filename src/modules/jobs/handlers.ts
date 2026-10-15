import { AGENT_ESCALATE_JOB_KIND, agentEscalateHandler } from "@/modules/agent/run/exec/escalate";
import { AGENT_RESUME_JOB_KIND, agentResumeHandler } from "@/modules/agent/run/timers";
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
  // B-08 slice 2 (§11.1): an awaited external response came due — re-trigger the parked run.
  [AGENT_RESUME_JOB_KIND]: agentResumeHandler,
  // B-08 slice 4 (§11.2 "no reply → escalate"): nobody answered — raise the exception, no model.
  [AGENT_ESCALATE_JOB_KIND]: agentEscalateHandler,
};
