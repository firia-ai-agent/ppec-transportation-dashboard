/**
 * A SIMULATED TEXT, THROUGH THE SAME DOOR A REAL TEXT COMES IN BY.
 *
 * The demo's parent texts are handed, Twilio-shaped, to `ingestInbound` — the function behind
 * `POST /api/webhooks/sms` — with the same agent hook the webhook passes. This module writes no
 * message row, run, proposal or task of its own; everything after the hand-off is the product:
 *
 *   ingestInbound → known sender (a seeded guardian, by blind index) → `ops.message`
 *     → agentRunInboundHook → `ops.agent_run` (msg.inbound) → `ppec-agent` wake-up after commit
 *     → /api/queues/agent → driveRun → the model reads the thread and the plan with its tools.
 *
 * What the parent says and who says it are the caller's (`demo/parent-text.ts` builds them from the
 * day); nothing here reads the words back. A `MessageSid` seen before is the webhook's own duplicate
 * — a 200 no-op that starts no second run. Never waits for the model; never logs the pepper or the
 * number.
 */
import type { Db } from "@/db/exec";
import { agentRunInboundHook } from "@/modules/agent/run/inbound-hook";
import type { AgentWakeTransport } from "@/modules/agent/run/wake";
import { normalizeE164 } from "@/modules/identity/phone";
import { ingestInbound, type InboundBody } from "@/modules/messaging/inbound";
import { SIM_CENTER_NUMBER } from "@/modules/messaging/sim-numbers";
import type { OutboxTransport } from "@/modules/outbox/outbox";

export type SimulatedInboundDeps = {
  readonly env: Record<string, string | undefined>;
  readonly now: Date;
  /** The agent wake-up, and the outbox the ingest enqueues a HELP answer on. Injected by the caller. */
  readonly agentTransport: AgentWakeTransport;
  readonly outboxTransport: OutboxTransport;
};

/** One text as a phone would send it: a provider id, the sender's number, the words. */
export type SimulatedText = { readonly sid: string; readonly from: string; readonly body: string };

export type SimulatedInboundResult =
  | { readonly sent: true; readonly body: InboundBody }
  | { readonly sent: false; readonly reason: string };

/** Send one text in. Never throws: the caller answers a person either way. */
export async function sendSimulatedInbound(db: Db, deps: SimulatedInboundDeps, text: SimulatedText): Promise<SimulatedInboundResult> {
  const pepper = deps.env.HMAC_PEPPER;
  if (!pepper) return { sent: false, reason: "HMAC_PEPPER is not set, so no sender can be recognised" };
  const form = {
    MessageSid: text.sid,
    From: normalizeE164(text.from) ?? text.from,
    To: SIM_CENTER_NUMBER,
    Body: text.body,
    SimSentAt: deps.now,
  };
  const raw = new URLSearchParams({ ...form, SimSentAt: form.SimSentAt.toISOString() }).toString();
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
