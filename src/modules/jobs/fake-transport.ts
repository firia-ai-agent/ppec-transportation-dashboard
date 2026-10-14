import type { WakeTransport } from "./scheduler";

/** In-memory wake transport for tests and local runs. Records every publish; can be told to fail. */
export class FakeTransport implements WakeTransport {
  sent: { jobId: string; dueAt: string; delaySeconds: number; idempotencyKey: string }[] = [];
  failNext = 0;
  async publish(msg: { jobId: string; dueAt: string }, opts: { delaySeconds: number; idempotencyKey: string }) {
    if (this.failNext > 0) { this.failNext--; throw new Error("fake publish failure"); }
    this.sent.push({ ...msg, ...opts });
  }
}
