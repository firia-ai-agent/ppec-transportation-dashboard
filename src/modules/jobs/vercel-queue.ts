import { send } from "@vercel/queue";
import type { WakeTransport } from "./scheduler";

export const TIMER_TOPIC = "ppec-timer";
/**
 * TEST-INF-01 sub-second delay probe (DECISION-LEDGER row 44 is conditional on it): GET /api/probe/delay
 * publishes here with fractional `delaySeconds` and the consumer logs the measured delivery delay.
 */
export const DELAY_PROBE_TOPIC = "ppec-delay-probe";

/** Vercel Queues (Beta) wake transport. Messages are pinned to the publishing deployment. */
export const vercelQueueTransport: WakeTransport = {
  async publish(msg, opts) {
    await send(TIMER_TOPIC, msg, { delaySeconds: opts.delaySeconds, idempotencyKey: opts.idempotencyKey, retentionSeconds: 7 * 24 * 3600 });
  },
};
