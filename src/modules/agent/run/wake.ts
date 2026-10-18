/**
 * THE AGENT WAKE-UP MESSAGE — a leaf module, so every publisher can import it without the run loop.
 *
 * Two publishers send it: the §11.1 start (`queue.ts enqueueRun`, the inbound hook) and the timer
 * that re-queues a parked run (`timers.ts agentResumeHandler`). It used to be defined in `queue.ts`,
 * which imports the lease and through it the run loop, and the loop imports `timers.ts` — so the
 * timer importing it from there was a cycle.
 */
import { z } from "zod";

/**
 * What one message says: **which run, in which tenant**.
 *
 * The site is on the payload and is not read off the run row, which is the F3 rule stated once more
 * at the queue boundary: the publisher knows whose run it is, and the consumer's claim is fenced on
 * what the publisher said. A payload that names another tenant's run is refused `wrong-site`
 * rather than driven — so a forged or mis-copied message is a no-op instead of a cross-tenant
 * drive.
 *
 * The *trigger* is deliberately not on it. A trigger makes a run (`startRun`, idempotent on
 * `(trigger_type, trigger_id)`) and the run id is what the queue carries, so a duplicate delivery
 * cannot make a second run however the payload is replayed.
 */
export const agentWakeSchema = z.object({
  runId: z.string().uuid(),
  siteId: z.string().uuid(),
});
export type AgentWake = z.infer<typeof agentWakeSchema>;

/** Queues-side idempotency: one in-flight wake-up per run, whoever publishes it. */
export function runWakeKey(runId: string): string {
  return `agent:run:${runId}`;
}

export interface AgentWakeTransport {
  publish(msg: AgentWake, opts: { idempotencyKey: string }): Promise<void>;
}
