/**
 * THE DEMO DAY'S ONE INBOUND TEXT — Dara's, through the same door a real text comes in by.
 *
 * Founder, 2026-10-18: "Dara's text comes in through the same inbound path a real text would use.
 * On Restart, the seed drops in her message only. No pre-built card and no canned alert." So this
 * module does not write a message row, a run, a proposal or a task. It hands one Twilio-shaped form
 * to `ingestInbound` — the function behind `POST /api/webhooks/sms` — with the same agent hook the
 * webhook passes, and everything after that is the product:
 *
 *   ingestInbound → known sender (the seeded F2 guardian, by blind index) → `ops.message`
 *     → agentRunInboundHook → `ops.agent_run` (msg.inbound) → `ppec-agent` wake-up after commit
 *     → /api/queues/agent → driveRun → the model reads the thread and the plan with its tools
 *     → `propose_dropoff_change`, held as a PROPOSAL → the card, written by the proposal writer.
 *
 * The words are the parent's — the scenario's input, not the app's output (`familyTexts.demoReply`,
 * about the child `fixtures/standard.ts DEMO_INBOUND` names) — and nothing reads them back for a
 * time or a place (`agent/no-keyword-fallback.test.ts`).
 *
 * ## Exactly once per Restart
 *
 * The seed truncates `ops.message` and `ops.agent_run` first, and the `MessageSid` is fixed per
 * service date, so a second Restart is a fresh day with one message, and a retried call inside one
 * Restart is the webhook's own duplicate (`ON CONFLICT (provider, external_id)`) — a 200 no-op that
 * starts no second run. The run itself is keyed on `(msg.inbound, message id)`.
 *
 * ## What it never does
 *
 * It does not wait for the model. The run is driven by the queue consumer, so Restart finishes in
 * the time a webhook takes and the card appears when the model has written it — or the staff alert
 * does, when it could not (`agent/staff-alert.ts`). It does not log the pepper or the number.
 */
import type { Db } from "@/db/exec";
import { agentRunInboundHook } from "@/modules/agent/run/inbound-hook";
import type { AgentWakeTransport } from "@/modules/agent/run/wake";
import { normalizeE164 } from "@/modules/identity/phone";
import { ingestInbound, type InboundBody } from "@/modules/messaging/inbound";
import { SIM_CENTER_NUMBER } from "@/modules/messaging/sim-numbers";
import type { OutboxTransport } from "@/modules/outbox/outbox";
import { familyTexts, fill } from "@/ui/copy";
import { DEMO_INBOUND, childByKey, familyByKey } from "./fixtures/standard";

export type DemoInboundDeps = {
  readonly env: Record<string, string | undefined>;
  readonly now: Date;
  /** The service date the seed just wrote, which keys the message id. */
  readonly serviceDate: string;
  /** The agent wake-up, and the outbox the ingest enqueues a HELP answer on. Injected by the route. */
  readonly agentTransport: AgentWakeTransport;
  readonly outboxTransport: OutboxTransport;
};

export type DemoInboundResult =
  | { readonly sent: true; readonly body: InboundBody }
  | { readonly sent: false; readonly reason: string };

/** The scenario's inbound text, as the parent's phone would send it. */
export function demoInboundForm(serviceDate: string, now: Date) {
  const child = childByKey(DEMO_INBOUND.childKey);
  const { guardian } = familyByKey(child.familyKey);
  return {
    MessageSid: `SIMDEMO-${serviceDate}-${child.familyKey}-1`,
    From: normalizeE164(guardian.phone) ?? guardian.phone,
    To: SIM_CENTER_NUMBER,
    Body: fill(familyTexts.demoReply, { child: child.firstName }),
    SimSentAt: now,
  };
}

/** Send Dara's text in. Never throws: Restart has already reset the day and must still answer. */
export async function sendDemoInbound(db: Db, deps: DemoInboundDeps): Promise<DemoInboundResult> {
  const pepper = deps.env.HMAC_PEPPER;
  if (!pepper) return { sent: false, reason: "HMAC_PEPPER is not set, so no sender can be recognised" };
  const form = demoInboundForm(deps.serviceDate, deps.now);
  const raw = new URLSearchParams({
    MessageSid: form.MessageSid,
    From: form.From,
    To: form.To,
    Body: form.Body,
    SimSentAt: form.SimSentAt.toISOString(),
  }).toString();
  try {
    const r = await ingestInbound(
      db,
      { pepper, transport: deps.outboxTransport, hook: agentRunInboundHook(deps.agentTransport) },
      raw,
      form,
    );
    return r.status === 200 && r.body.ok
      ? { sent: true, body: r.body }
      : { sent: false, reason: `ingest answered ${r.status}${r.body.error ? `: ${r.body.error}` : ""}` };
  } catch (e) {
    return { sent: false, reason: (e instanceof Error ? e.message : String(e)).slice(0, 200) };
  }
}
