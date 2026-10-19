import { API } from "@/auth/access";
import { requireApiSession } from "@/auth/api-guard";
import { getNeonDb } from "@/db/exec";
import { threadPulseOrQuiet } from "@/modules/agent/ask/pulse";
import { siteOf } from "@/modules/plan/api";

export const dynamic = "force-dynamic";

/**
 * `GET /api/agent/thread/pulse` — has the agent's thread moved since this page rendered (ledger
 * #75 b)? A stamp and a flag, nothing about any person, child or message: the page compares the
 * stamp with the one it rendered with and re-renders when they differ. Same roles as the bubble.
 */
export async function GET() {
  const guard = await requireApiSession(API.agentPulse);
  if (!guard.ok) return guard.response;
  const pulse = await threadPulseOrQuiet(getNeonDb, siteOf(guard.caller));
  return Response.json(pulse, { headers: { "cache-control": "no-store" } });
}
