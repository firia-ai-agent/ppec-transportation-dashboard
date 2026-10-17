import { API } from "@/auth/access";
import { requireApiSession } from "@/auth/api-guard";
import { putVanSetupRequest, siteOf, vanSetupBody } from "@/modules/plan/api";
import { apiAccess } from "@/ui/copy";

export const dynamic = "force-dynamic";

const noStore = { "cache-control": "no-store" };

/**
 * `POST /api/vans/:id/setup` — what is on this van today (redesign spec §1.6, §2).
 *
 * Open to all three roles, because counting a van is the front desk's own job: this is the write
 * behind "Confirm Van 1" on the ramp iPad, and the hint under that button — "Tomorrow starts from
 * this" — is this row becoming tomorrow's default (src/domain/plan/setup.ts).
 *
 * The role still decides *what* may be written, and the module enforces it: the front desk may
 * confirm what arrived and may not plan a van (`CHECKED` only), and `DEFAULT` is nobody's to
 * write. A van this board does not run is a uniform 404.
 *
 * §1.6 writes this as a `PUT`. It is a POST, like every other write in this app, so the one
 * `methods` vocabulary in the access table stays as it is.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const guard = await requireApiSession(API.vanSetup);
  if (!guard.ok) return guard.response;

  const parsed = vanSetupBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ ok: false, error: apiAccess.badRequest }, { status: 400, headers: noStore });
  }
  const { id } = await ctx.params;

  try {
    const answer = await putVanSetupRequest(siteOf(guard.caller), guard.caller, id, parsed.data);
    return Response.json(answer.body, { status: answer.status, headers: noStore });
  } catch {
    return Response.json({ ok: false, error: apiAccess.unavailable }, { status: 503, headers: noStore });
  }
}
