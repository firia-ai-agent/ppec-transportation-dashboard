import { send } from "@vercel/queue";
import { isWholeSecondDelay, MAX_DELAY_SECONDS, wholeSecondDelay, type WakeTransport } from "./scheduler";

export const TIMER_TOPIC = "ppec-timer";
/**
 * TEST-INF-01 sub-second delay probe: GET /api/probe/delay publishes here with fractional `delaySeconds` and
 * the consumer logs the measured delivery delay. This is the **one** place a fractional delay is deliberate —
 * it is the measurement. The timer path no longer depends on the answer (DECISION-LEDGER row 60: whole-second
 * delays + an inline lease re-check), so the probe now only tells us how much precision we are leaving on the
 * table, not whether NFR-03 holds.
 */
export const DELAY_PROBE_TOPIC = "ppec-delay-probe";

/**
 * Vercel Queues (Beta) wake transport.
 *
 * What the service promises (Athena's research, PR #21), and what each promise costs us:
 * - **At-least-once delivery.** The same wake can arrive twice (or ten times). Handled by the guarded claim:
 *   only one claim per job can win, so a duplicate finds the row CLAIMED or DONE and no-ops (runner.ts).
 * - **No ordering guarantee.** A wake published later can arrive first. Handled by the (dueAt, version) fence
 *   on every message: a wake is only allowed to fire the job generation it was published for.
 * - **No delay SLA.** `delaySeconds` is a "not before" floor, not an appointment; the service may deliver
 *   arbitrarily late. This is the whole reason NFR-03 is Unverified (RISKS U1/U12) and the reason the
 *   every-minute sweeper exists. TEST-INF-01 measures the real distribution.
 * - **Deployment pinning.** A message is delivered to the deployment that published it, so a new deployment
 *   re-arms every pending job on its first sweep (`runtime_marker.active_deployment_id`).
 * - **No DLQ.** Bounded by us at MAX_DELIVERIES in the consumer's `retry` callback.
 *
 * `retentionSeconds` is the 7-day maximum, matching MAX_DELAY_SECONDS: a message must outlive its own delay
 * or Queues rejects it (`delaySeconds` cannot exceed `retentionSeconds`).
 *
 * **Delays are whole seconds (DECISION-LEDGER row 60).** @vercel/queue 0.8.0 types the field
 * `delaySeconds?: number` and neither validates it as an integer nor rounds it — it sends
 * `options.delaySeconds.toString()` as the `Vqs-Delay-Seconds` header (index.mjs `buildHeaders`) — but the
 * Queues docs describe it only as "Delay in seconds" and promise no sub-second precision, so what the server
 * does with `0.251` is undocumented behaviour of a Beta service. Row 58's millisecond re-wake delays rested on
 * that; row 60 takes it off the critical path: every delay is rounded up to a whole second
 * (`wholeSecondDelay`) and the sub-second part of a lease is waited out inside the invocation instead
 * (scheduler.ts `INLINE_RECHECK_MAX_MS`). The guard below is the last line: callers already round up, so a
 * fractional value here means a regression upstream, and a published wake is worth more than a strict error —
 * we round it up, log once, and let the fake transport's hard assertion (fake-transport.ts) be what fails CI.
 */
export const vercelQueueTransport: WakeTransport = {
  async publish(msg, opts) {
    let delaySeconds = opts.delaySeconds;
    if (!isWholeSecondDelay(delaySeconds)) {
      delaySeconds = wholeSecondDelay(delaySeconds);
      console.warn(`[queue:timer] non-integer delaySeconds ${opts.delaySeconds} (${opts.idempotencyKey}); published ${delaySeconds}`);
    }
    await send(TIMER_TOPIC, msg, { delaySeconds, idempotencyKey: opts.idempotencyKey, retentionSeconds: MAX_DELAY_SECONDS });
  },
};
