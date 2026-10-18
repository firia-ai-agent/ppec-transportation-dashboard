/**
 * THE WAKE-UP'S VOCABULARY, and why it is a leaf.
 *
 * What one agent delivery says, the key it is deduplicated on, and the interface something has to
 * satisfy to publish one. Three declarations with no dependency but zod, split out of `queue.ts`
 * because the module that *handles* a delivery cannot be the module that *defines* one without
 * closing a cycle:
 *
 *   queue.ts → lease.ts → loop.ts → timers.ts → queue.ts
 *
 * `timers.ts` publishes a wake-up when a parked run's timer fires, so it needs the key and the
 * transport; it has no business with the consumer. Importing the consumer for them made the five
 * modules above one evaluation cycle, and a cycle is not a style problem here — `queue.ts`'s
 * `AGENT_QUEUE_RETRY_AFTER_SECONDS` reads the lease constant at module-evaluation time, and when
 * the cycle was entered through `lease.ts` (which is what `import … from "./lease"` above an
 * `import … from "./queue"` does) that read landed before `lease.ts` had initialized and the queue
 * knob came out `undefined`. A retry directive of `{ afterSeconds: undefined }` is a redelivery
 * with no delay on it: the first retry after a crashed driver would arrive while the claim was
 * still live, be refused `leased`, and spend one of the message's MAX_DELIVERIES. `queue.test.ts`
 * is the door on the numbers; this file is why they can be read at all.
 *
 * Everything here is re-exported by `queue.ts`, so the queue is still the one name to import for
 * anybody working on the delivery itself.
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
