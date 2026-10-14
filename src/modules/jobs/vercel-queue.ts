import { send } from "@vercel/queue";
import type { WakeTransport } from "./scheduler";

export const TIMER_TOPIC = "ppec-timer";

/** Vercel Queues (Beta) wake transport. Messages are pinned to the publishing deployment. */
export const vercelQueueTransport: WakeTransport = {
  async publish(msg, opts) {
    await send(TIMER_TOPIC, msg, { delaySeconds: opts.delaySeconds, idempotencyKey: opts.idempotencyKey, retentionSeconds: 7 * 24 * 3600 });
  },
};
