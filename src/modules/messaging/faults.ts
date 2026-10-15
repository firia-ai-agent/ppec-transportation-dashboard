/**
 * Messaging fault switches for the demo panel (MOCKS-AND-DEMO §3, DESIGN-DIRECTION §6.1 "Faults":
 * SMS fail / delay / duplicate / out-of-order). Faults are keyed by persona phone number, with "*" as the
 * every-persona default, which is exactly how the panel targets them ("pick target vehicle/persona").
 *
 * SCHEMA GAP (reported with this change): there is no table for messaging sim faults. `ops.sim_run` is the
 * location simulator's (it requires a vehicle_id), and nothing else fits. Rather than add a migration for a
 * demo-only switch, the store is a seam with a process-local implementation: good for tests, for `next dev`
 * and for a single demo session, NOT shared across serverless instances. The demo-panel milestone (B-15)
 * should either widen `ops.sim_run` to a (track, target) shape or add `ops.sim_fault`, then implement
 * SimFaultStore over it; nothing outside this file changes.
 */
export type SimMessagingFaults = {
  /** The delivery callback reports a failure: SENT → FAILED. */
  deliveryFailure: boolean;
  /** The delivery callback arrives late (still inside the 30-minute callback window, so it lands DELIVERED late). */
  delayedDelivery: boolean;
  /** The sim posts each inbound webhook twice (same provider message id). */
  duplicateInbound: boolean;
  /** The sim posts a batch of inbound webhooks newest-first. */
  outOfOrderInbound: boolean;
};

export const NO_FAULTS: SimMessagingFaults = {
  deliveryFailure: false, delayedDelivery: false, duplicateInbound: false, outOfOrderInbound: false,
};

/** Every persona, unless a number has its own entry. */
export const ALL_PERSONAS = "*";

export interface SimFaultStore {
  /** Faults for one persona number, merged over the "*" defaults. */
  get(number: string): Promise<SimMessagingFaults>;
  set(number: string, faults: Partial<SimMessagingFaults>): Promise<SimMessagingFaults>;
  clear(number?: string): Promise<void>;
}

export class InMemorySimFaultStore implements SimFaultStore {
  private byNumber = new Map<string, Partial<SimMessagingFaults>>();
  async get(number: string): Promise<SimMessagingFaults> {
    return { ...NO_FAULTS, ...this.byNumber.get(ALL_PERSONAS), ...this.byNumber.get(number) };
  }
  async set(number: string, faults: Partial<SimMessagingFaults>) {
    this.byNumber.set(number, { ...this.byNumber.get(number), ...faults });
    return this.get(number);
  }
  async clear(number?: string) {
    if (number) this.byNumber.delete(number); else this.byNumber.clear();
  }
}

let store: SimFaultStore | undefined;
/** One store per server process (see the schema gap above). */
export function simFaultStore(): SimFaultStore {
  return (store ??= new InMemorySimFaultStore());
}

/**
 * Turn one persona message into the webhook posts the sim should actually deliver. The duplicate and
 * out-of-order faults live here, so the handler under test is the same code a real Twilio post hits:
 * the fault is in the delivery, never in the handler.
 */
export function simInboundPosts<T>(posts: readonly T[], faults: SimMessagingFaults): T[] {
  const ordered = faults.outOfOrderInbound ? [...posts].reverse() : [...posts];
  return faults.duplicateInbound ? ordered.flatMap((p) => [p, p]) : ordered;
}
