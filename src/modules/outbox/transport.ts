import { send } from "@vercel/queue";
import { OUTBOX_TOPIC, type OutboxTransport } from "./outbox";

/** Vercel Queues wake-up for the outbox drainer. A lost publish is recovered by sweepOutbox(). */
export const vercelQueueOutboxTransport: OutboxTransport = {
  async publish(msg, opts) { await send(OUTBOX_TOPIC, msg, { idempotencyKey: opts.idempotencyKey }); },
};

/** In-memory transport for tests; can be told to fail. */
export class FakeOutboxTransport implements OutboxTransport {
  sent: string[] = [];
  failNext = 0;
  async publish(msg: { messageId: string }) {
    if (this.failNext > 0) { this.failNext--; throw new Error("fake publish failure"); }
    this.sent.push(msg.messageId);
  }
}
