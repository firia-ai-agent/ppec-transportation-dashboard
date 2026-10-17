import { API } from "@/auth/access";
import { requireApiSession } from "@/auth/api-guard";
import { readinessResponse, siteOf } from "@/modules/plan/api";
import { resolveDate, resolveLeg } from "@/modules/plan/when";
import { apiAccess } from "@/ui/copy";

export const dynamic = "force-dynamic";

const noStore = { "cache-control": "no-store" };

/**
 * `GET /api/day/readiness?date&leg` — the three steps of the day (redesign spec §9.4).
 *
 * The same object the step strip is rendered from on the server, for the moments a screen has to
 * catch up: after a plan is saved, and after a van is confirmed on the ramp. Vera's §9 rule is
 * that there is one helper and no screen re-implements the check, so this endpoint is a second
 * *reader* of `getDayReadiness` and never a second copy of it.
 *
 * All three roles: both surfaces that read it are. It answers counts — how many vans are
 * confirmed, whether a plan is saved, how many vans have moved — and names no child.
 */
export async function GET(req: Request) {
  const guard = await requireApiSession(API.dayReadiness);
  if (!guard.ok) return guard.response;

  const params = new URL(req.url).searchParams;
  const date = resolveDate(params.get("date"));
  const leg = resolveLeg(params.get("leg") ?? params.get("direction"));

  try {
    const readiness = await readinessResponse(siteOf(guard.caller), date, leg);
    return Response.json({ ok: true, readiness }, { status: 200, headers: noStore });
  } catch {
    return Response.json({ ok: false, error: apiAccess.unavailable }, { status: 503, headers: noStore });
  }
}
