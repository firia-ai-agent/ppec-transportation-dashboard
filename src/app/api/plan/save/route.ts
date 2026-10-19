import { API } from "@/auth/access";
import { requireApiSession } from "@/auth/api-guard";
import { savePlanBody } from "@/modules/plan/api";
import { ACTIONS } from "@/modules/actions/registry";
import { screenCtx } from "@/modules/actions/screen";
import { apiAccess } from "@/ui/copy";

export const dynamic = "force-dynamic";

const noStore = { "cache-control": "no-store" };

/**
 * `POST /api/plan/save` — keep one board (redesign spec §1.6).
 *
 * The guard is the shared session guard with this route's own row (DIRECTOR and COORDINATOR, the
 * two roles whose row opens the screen), so a signed-out caller is a 401 and the front desk a
 * 403, in the same JSON shape every endpoint uses and before any id in the body is read. That is
 * §1.7 #5's second half: hiding Plan routes from the front desk's menu is a courtesy, and this is
 * the closed door.
 *
 * Then the thing this endpoint exists for: **the plan is re-asked of the fit rule**. The board
 * checks every drop as it is made, and a request is not the board — so the posted plan is replayed
 * van by van through the same `src/domain/plan/fit.ts` the browser used, and the first van that
 * does not fit refuses the whole save. The decision and its four answers are in
 * src/modules/plan/api.ts; this file is the shape of them.
 *
 * What changed from #58: the plan is kept in `ops.plan_run` / `ops.plan_assignment` (migration
 * 0009) instead of a `Map` in this instance's memory, which is what makes §1.7 #3 — save, then
 * reload in another browser — mean anything at all.
 */
export async function POST(req: Request) {
  const guard = await requireApiSession(API.planSave);
  if (!guard.ok) return guard.response;

  const parsed = savePlanBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ ok: false, error: apiAccess.badRequest }, { status: 400, headers: noStore });
  }

  try {
    const answer = await ACTIONS.save_plan.run(screenCtx(guard.caller), parsed.data);
    return Response.json(answer.body, { status: answer.status, headers: noStore });
  } catch {
    // The save did not reach the database. It says so and claims nothing about what was kept:
    // the screen shows "Couldn't save · Retry" and the board stays exactly as it is.
    return Response.json({ ok: false, error: apiAccess.unavailable }, { status: 503, headers: noStore });
  }
}
