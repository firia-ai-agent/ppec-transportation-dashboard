import { handleCallback } from "@vercel/queue";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Queue trigger (topic ppec-delay-probe, vercel.json) for TEST-INF-01: does Vercel Queues honour
 * sub-second `delaySeconds`? DECISION-LEDGER row 56 (2 s lease + millisecond re-wake delays) is
 * conditional on this; if the measured delay is the request rounded up to a whole second, revert to the
 * row 38 parameters (3 s lease, whole-second re-wakes; row 38 itself is on the closed PR #10).
 *
 * No DB, no secrets, no work: it logs one line per delivery, so it runs on previews too, where every DB
 * session is read-only (DECISION-LEDGER #43). Started by GET /api/probe/delay.
 */
export const POST = handleCallback(async (message: { id: string; requested: number; sentAt: number }) => {
  console.log(`[delay-probe] id=${message.id} requested=${message.requested} actual=${Date.now() - message.sentAt} ms`);
});
