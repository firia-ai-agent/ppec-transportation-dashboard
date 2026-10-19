import { API } from "@/auth/access";
import { requireApiSession } from "@/auth/api-guard";
import { childNeedsBody } from "@/modules/plan/api";
import { ACTIONS } from "@/modules/actions/registry";
import { screenCtx } from "@/modules/actions/screen";
import { apiAccess } from "@/ui/copy";

export const dynamic = "force-dynamic";

const noStore = { "cache-control": "no-store" };

/**
 * `POST /api/children/:token/needs` — what the board's child panel saves (founder 7:17 PM ET).
 *
 * Three Yes/No answers (Wheelchair, Car seat, Oxygen) become `APPROVED` or `UNKNOWN` items on
 * the child's **existing approved** transport profile (src/modules/roster/needs-write.ts — no
 * new profile version, no migration: the category column is text), and then the plan for this
 * date and leg is **re-run on the new needs** and saved as a new version. A Save that did not
 * move the board would be a Save that changed nothing a coordinator can see.
 *
 * The two console roles only. The front desk sees the same three values on the same panel and
 * has no Save button; this is the half of that which a request cannot talk its way past.
 */
export async function POST(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const guard = await requireApiSession(API.childNeeds);
  if (!guard.ok) return guard.response;

  const { token } = await params;
  const parsed = childNeedsBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ ok: false, error: apiAccess.badRequest }, { status: 400, headers: noStore });
  }

  try {
    const answer = await ACTIONS.set_child_needs.run(screenCtx(guard.caller), { ...parsed.data, childToken: token });
    return Response.json(answer.body, { status: answer.status, headers: noStore });
  } catch {
    return Response.json({ ok: false, error: apiAccess.unavailable }, { status: 503, headers: noStore });
  }
}
