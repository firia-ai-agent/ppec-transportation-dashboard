import { API } from "@/auth/access";
import { requireApiSession } from "@/auth/api-guard";
import { apiAccess } from "@/ui/copy";
import { boardResponse, siteOf } from "@/modules/plan/api";
import { resolveDate, resolveLeg } from "@/modules/plan/when";

export const dynamic = "force-dynamic";

const noStore = { "cache-control": "no-store" };

/**
 * `GET /api/plan?date&direction` — the board as JSON (redesign spec §1.6).
 *
 * The page server-renders the same object, so nothing *has* to call this to draw the screen; it
 * is here for the two moments a screen has to catch up with the server rather than with itself —
 * after a save that came back a conflict ("Changed by Dana M. · Reload"), and after the front desk
 * confirms a van on the ramp, which changes what the board is planned against.
 *
 * The guard is the shared session guard with this route's own row (the two console roles, the same
 * set that opens the page), so a signed-out caller is a 401 and the front desk a 403 — before the
 * date is read and before a database connection is opened.
 *
 * A missing or unreadable `date` is today at the centre and a missing `direction` is the leg the
 * clock is in (§9.3), because a mistyped link is not something a coordinator can act on.
 */
export async function GET(req: Request) {
  const guard = await requireApiSession(API.planBoard);
  if (!guard.ok) return guard.response;

  const params = new URL(req.url).searchParams;
  const date = resolveDate(params.get("date"));
  const direction = resolveLeg(params.get("direction") ?? params.get("leg"));

  try {
    const body = await boardResponse(siteOf(guard.caller), date, direction);
    return Response.json({ ok: true, ...body }, { status: 200, headers: noStore });
  } catch {
    // A read that could not be made says so and claims nothing: the module shows
    // "Couldn't load · Retry" and the shell stays (§9.3's last rows).
    return Response.json({ ok: false, error: apiAccess.unavailable }, { status: 503, headers: noStore });
  }
}
