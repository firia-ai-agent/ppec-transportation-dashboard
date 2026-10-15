import { handleCallback } from "@vercel/queue";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Queue trigger (topic ppec-delay-probe, vercel.json) for TEST-INF-01: how late is a Vercel Queues
 * delivery, and does it honour sub-second `delaySeconds` at all? The timer path no longer depends on the
 * second question — DECISION-LEDGER row 60 publishes whole seconds and waits out the sub-second part of a
 * lease in-invocation — so this measures how much precision that gave up, and (the part that still
 * matters) the real lateness distribution ADR-001's simulated worst case assumes is ≤1 s per delivery.
 *
 * No DB, no secrets, no work: it logs one line per delivery, so it runs on previews too, where every DB
 * session is read-only (DECISION-LEDGER #43). Started by GET /api/probe/delay.
 */
export const POST = handleCallback(async (message: { id: string; requested: number; sentAt: number }) => {
  console.log(`[delay-probe] id=${message.id} requested=${message.requested} actual=${Date.now() - message.sentAt} ms`);
});
