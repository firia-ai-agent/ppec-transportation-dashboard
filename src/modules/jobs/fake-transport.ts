import { isWholeSecondDelay, type WakeMessage, type WakeTransport } from "./scheduler";

/** In-memory wake transport for tests and local runs. Records every publish; can be told to fail. */
export class FakeTransport implements WakeTransport {
  sent: (WakeMessage & { delaySeconds: number; idempotencyKey: string })[] = [];
  failNext = 0;
  async publish(msg: WakeMessage, opts: { delaySeconds: number; idempotencyKey: string }) {
    // Whole-second delays are a contract, not a preference (DECISION-LEDGER row 60): Vercel Queues documents
    // `delaySeconds` only as "Delay in seconds", so a fractional value is a bug wherever it comes from. The
    // production transport rounds it up and warns rather than losing the wake; here it throws, so any code
    // path that regresses to a fractional delay fails the suite instead of passing quietly.
    if (!isWholeSecondDelay(opts.delaySeconds)) {
      throw new Error(`delaySeconds must be a whole number of seconds in [0, 7 days], got ${opts.delaySeconds} (${opts.idempotencyKey})`);
    }
    if (this.failNext > 0) { this.failNext--; throw new Error("fake publish failure"); }
    this.sent.push({ ...msg, ...opts });
  }
}
