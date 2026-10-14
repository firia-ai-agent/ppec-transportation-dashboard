import { send } from "@vercel/queue";
import { uuidv7 } from "uuidv7";
import { cronAuthorized } from "@/lib/cron-auth";
import { DELAY_PROBE_TOPIC } from "@/modules/jobs/vercel-queue";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Requested delays, each sent twice: around and above 1 s, so a server that floors or rounds up shows up. */
export const PROBE_DELAYS_SECONDS = [0.25, 0.5, 0.75, 1.25, 1.5, 1.75];
const PASSES = 2;

/**
 * TEST-INF-01 sub-second delay probe (DECISION-LEDGER row 44). Sends 12 delayed messages to
 * ppec-delay-probe; the consumer logs `[delay-probe] id=… requested=… actual=… ms`, so the live
 * answer is read off the Vercel function logs. Touches no DB, so it works on previews, which share
 * the one production DB read-only (DECISION-LEDGER #43).
 *
 * Guarded exactly like /api/cron/sweep: `Authorization: Bearer $CRON_SECRET`, fail-closed. The secret
 * is never echoed, logged, or included in the response.
 */
export async function GET(req: Request) {
  if (!cronAuthorized(req.headers.get("authorization"), process.env.CRON_SECRET)) {
    return new Response("unauthorized", { status: 401 });
  }
  const run = uuidv7();
  let sent = 0;
  try {
    for (let pass = 1; pass <= PASSES; pass++) {
      for (const requested of PROBE_DELAYS_SECONDS) {
        const id = `${run}:${pass}:${requested}`;
        await send(DELAY_PROBE_TOPIC, { id, requested, sentAt: Date.now() },
          { delaySeconds: requested, idempotencyKey: id, retentionSeconds: 3600 });
        sent++;
      }
    }
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    return Response.json({ sent, error }, { status: 502, headers: { "cache-control": "no-store" } });
  }
  return Response.json({ sent }, { headers: { "cache-control": "no-store" } });
}
