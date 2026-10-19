import { cronAuthorized } from "@/lib/cron-auth";
import { consumeAgentWake } from "@/modules/agent/run/consume";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * `POST /api/dev/agent-wake` — the agent queue's consumer for a **local dev server**, which has no
 * Vercel Queue (ledger #76). The publisher (`agent/run/vercel-queue.ts`) posts each wake-up here on
 * `next dev`, and this runs the very function the queue route runs, so the agent answers on
 * localhost as it would deployed.
 *
 * Not on a deployment at all: on Vercel it is a 404. Machine-to-machine like the sweep, so behind
 * the cron secret (fail-closed, `lib/cron-auth.ts`).
 */
export async function POST(req: Request) {
  if (process.env.VERCEL === "1" || process.env.NODE_ENV !== "development") {
    return new Response(null, { status: 404 });
  }
  if (!cronAuthorized(req.headers.get("authorization"), process.env.CRON_SECRET)) {
    return new Response(null, { status: 401 });
  }
  const message: unknown = await req.json().catch(() => null);
  await consumeAgentWake(message);
  return Response.json({ ok: true });
}
