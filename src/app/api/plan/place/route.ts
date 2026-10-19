import { API } from "@/auth/access";
import { requireApiSession } from "@/auth/api-guard";
import { placeChildBody } from "@/modules/plan/api";
import { ACTIONS } from "@/modules/actions/registry";
import { screenCtx } from "@/modules/actions/screen";
import { apiAccess } from "@/ui/copy";

export const dynamic = "force-dynamic";

const noStore = { "cache-control": "no-store" };

/**
 * `POST /api/plan/place` — move one child (founder 2026-10-17 7:17 PM ET, gate (b)).
 *
 * One drag between vans, one drop on Absent or Family drives, one `Move to…` on a phone: all of
 * them are this request, and all of them end in `setChildPlacement`
 * (src/modules/plan/place.ts), which is the single writer of a child's bucket. Each one saves a
 * **new plan version**, so a move survives a reload and two coordinators moving at once get a
 * 409 naming the other rather than one of them silently winning.
 *
 * The guard is the shared session guard with this route's own row — the two console roles, the
 * same set that opens the screen — so the front desk gets a flat 403 here even though they can
 * read the same board on Today. Hiding a drag handle is a courtesy; this is the closed door.
 */
export async function POST(req: Request) {
  const guard = await requireApiSession(API.planPlace);
  if (!guard.ok) return guard.response;

  const parsed = placeChildBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ ok: false, error: apiAccess.badRequest }, { status: 400, headers: noStore });
  }

  try {
    const answer = await ACTIONS.place_child.run(screenCtx(guard.caller), parsed.data);
    return Response.json(answer.body, { status: answer.status, headers: noStore });
  } catch {
    return Response.json({ ok: false, error: apiAccess.unavailable }, { status: 503, headers: noStore });
  }
}
