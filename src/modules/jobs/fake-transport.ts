import type { WakeMessage, WakeTransport } from "./scheduler";

/** In-memory wake transport for tests and local runs. Records every publish; can be told to fail. */
export class FakeTransport implements WakeTransport {
  sent: (WakeMessage & { delaySeconds: number; idempotencyKey: string })[] = [];
  failNext = 0;
  async publish(msg: WakeMessage, opts: { delaySeconds: number; idempotencyKey: string }) {
    if (this.failNext > 0) { this.failNext--; throw new Error("fake publish failure"); }
    this.sent.push({ ...msg, ...opts });
  }
}
