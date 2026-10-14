/** MessagingProvider seam (ADR-006). P1 uses the SIM provider only; real adapters stay stubs. */
export type OutboundPayload = {
  messageId: string; siteId: string; idempotencyKey: string; channel: string;
  recipientToken: string; templateId: string; vars: Record<string, unknown>;
};

/** The provider did not answer in time: the message may or may not have gone out. Never resend. */
export class ProviderTimeout extends Error {}

export interface MessagingProvider {
  readonly name: string;
  send(msg: OutboundPayload, opts: { signal: AbortSignal }): Promise<{ providerMessageId: string }>;
}

/** In-memory SIM provider for tests and the synthetic demo. Idempotent on idempotencyKey. */
export class SimMessagingProvider implements MessagingProvider {
  readonly name = "SIM";
  sent: OutboundPayload[] = [];
  private byKey = new Map<string, string>();
  /** Test hooks: hang until aborted, or throw a definitive error, for the next N sends. */
  hangNext = 0;
  failNext = 0;
  async send(msg: OutboundPayload, opts: { signal: AbortSignal }) {
    if (this.hangNext > 0) {
      this.hangNext--;
      this.sent.push(msg); // the provider got it; we just never heard back
      await new Promise((_, rej) => opts.signal.addEventListener("abort", () => rej(new ProviderTimeout("sim timeout")), { once: true }));
    }
    if (this.failNext > 0) { this.failNext--; throw new Error("sim rejected"); }
    const existing = this.byKey.get(msg.idempotencyKey);
    if (existing) return { providerMessageId: existing };
    const id = `SIM-${msg.messageId}`;
    this.byKey.set(msg.idempotencyKey, id);
    this.sent.push(msg);
    return { providerMessageId: id };
  }
}

/** Twilio stub (ADR-006): refuses unless the data class is not SYNTHETIC and live gates pass. Never in P1. */
export const twilioStub: MessagingProvider = {
  name: "TWILIO",
  async send() { throw new Error("Twilio adapter is not enabled in P1 (APP_DATA_CLASS=SYNTHETIC, live gates closed)"); },
};
