import { send } from "@vercel/queue";
import { MAX_DELAY_SECONDS, type WakeTransport } from "./scheduler";

export const TIMER_TOPIC = "ppec-timer";
/**
 * TEST-INF-01 sub-second delay probe (DECISION-LEDGER row 56 is conditional on it): GET /api/probe/delay
 * publishes here with fractional `delaySeconds` and the consumer logs the measured delivery delay.
 */
export const DELAY_PROBE_TOPIC = "ppec-delay-probe";

/**
 * Vercel Queues (Beta) wake transport.
 *
 * What the service promises (Athena's research, PR #21), and what each promise costs us:
 * - **At-least-once delivery.** The same wake can arrive twice (or ten times). Handled by the guarded claim:
 *   only one claim per job can win, so a duplicate finds the row CLAIMED or DONE and no-ops (runner.ts).
 * - **No ordering guarantee.** A wake published later can arrive first. Handled by the (dueAt, version) fence
 *   on every message: a wake is only allowed to fire the job generation it was published for.
 * - **No delay SLA.** `delaySeconds` is a "not before" floor, not an appointment; the service may deliver
 *   arbitrarily late. This is the whole reason NFR-03 is Unverified (RISKS U1/U12) and the reason the
 *   every-minute sweeper exists. TEST-INF-01 measures the real distribution.
 * - **Deployment pinning.** A message is delivered to the deployment that published it, so a new deployment
 *   re-arms every pending job on its first sweep (`runtime_marker.active_deployment_id`).
 * - **No DLQ.** Bounded by us at MAX_DELIVERIES in the consumer's `retry` callback.
 *
 * `retentionSeconds` is the 7-day maximum, matching MAX_DELAY_SECONDS: a message must outlive its own delay
 * or Queues rejects it (`delaySeconds` cannot exceed `retentionSeconds`).
 */
export const vercelQueueTransport: WakeTransport = {
  async publish(msg, opts) {
    await send(TIMER_TOPIC, msg, { delaySeconds: opts.delaySeconds, idempotencyKey: opts.idempotencyKey, retentionSeconds: MAX_DELAY_SECONDS });
  },
};
