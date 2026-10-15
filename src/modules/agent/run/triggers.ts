/**
 * What starts an agent run (PRD §11.1 l.924): "Triggers: msg.inbound, operational event (rules
 * first), timer/deadline, overdue sweeper (5 min), ETA threshold (deterministic → template),
 * reconciliation (hourly/EOD). Each run = job with idempotency (trigger_type, trigger_id)."
 *
 * A trigger is a *type plus an id*, and nothing else, because the pair is the run's identity: the
 * unique index `agent_run_trigger_uq` on (trigger_type, trigger_id) is what makes a redelivered
 * webhook, a redelivered queue message and a sweeper that picks the same overdue row twice all
 * produce one run (`startRun` in store.ts). The id therefore has to be the id of the *thing that
 * happened* — the message row, the event row, the job row — never a fresh uuid per attempt, and
 * never a wall-clock stamp.
 *
 * ETA threshold is in the PRD list but is not a trigger type here: §11.1 marks it
 * "deterministic → template", i.e. the ETA path renders an allow-listed template without a model
 * turn (B-06/B-05), so it starts no run. If that ever changes it is a new type on this list and a
 * new row in the §11.1 table, not an extra meaning for one of the five below.
 */

export const TRIGGER_TYPES = [
  /** An inbound family/provider message, after B-04 has written `ops.message`. Id: the message row. */
  "msg.inbound",
  /**
   * An operational event the deterministic rules did not fully handle. §11.1 is explicit that
   * rules run *first*: the agent sees the event only when the rules leave something open.
   * Id: the `ops.event_log` entry (or the domain row) the rules deferred.
   */
  "operational.event",
  /**
   * A deadline that came due: a 15-minute clarification await, a 10-minute therapist ack, T−90
   * capability. Id: the `ops.job` row that fired, so one timer can only ever re-trigger one run.
   */
  "timer.deadline",
  /** The 5-minute overdue sweeper. Id: the overdue object plus the sweep window it was seen in. */
  "sweeper.overdue",
  /** Hourly / end-of-day reconciliation. Id: the reconciliation window. */
  "reconciliation",
] as const;

export type TriggerType = (typeof TRIGGER_TYPES)[number];

export type Trigger = {
  readonly type: TriggerType;
  /** Id of the thing that happened. Half of the run's idempotency key — see the file header. */
  readonly id: string;
  /** The tenant the run belongs to. Never read from a tool argument (tools.FORBIDDEN_ARG_TOKENS.tenant). */
  readonly siteId: string;
};

export class TriggerError extends Error {}

/** Trigger ids go in a text column and in a job key: bounded, printable, no whitespace. */
const TRIGGER_ID = /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,127}$/;

/**
 * Reject a trigger the run loop could not deduplicate. An empty or oversized id, or one carrying
 * whitespace, is a caller that has not decided what "the thing that happened" is — and a run with
 * a meaningless idempotency key is worse than no run, because the second delivery makes a second
 * one.
 */
export function assertTrigger(t: Trigger): void {
  if (!TRIGGER_TYPES.includes(t.type)) throw new TriggerError(`unknown trigger type ${JSON.stringify(t.type)}`);
  if (!TRIGGER_ID.test(t.id)) throw new TriggerError(`trigger id ${JSON.stringify(t.id)} is not an identifier`);
  if (!t.siteId) throw new TriggerError("trigger has no siteId");
}

/** Human-readable label for a trigger, for job keys, task summaries and prompts. Never PHI. */
export function triggerLabel(t: Pick<Trigger, "type" | "id">): string {
  return `${t.type}:${t.id}`;
}
