import { API } from "@/auth/access";
import { requireApiSession } from "@/auth/api-guard";
import { getNeonDb } from "@/db/exec";
import { openFeedback } from "@/modules/feedback/store";
import { siteOf } from "@/modules/plan/site";
import { apiAccess } from "@/ui/copy";

export const dynamic = "force-dynamic";

const noStore = { "cache-control": "no-store" };

/** `GET /api/feedback/open` — the site's open feedback, newest first, for the director (ledger #82). */
export async function GET() {
  const guard = await requireApiSession(API.feedbackOpen);
  if (!guard.ok) return guard.response;
  try {
    const items = await openFeedback(getNeonDb(), siteOf(guard.caller));
    return Response.json({ ok: true, items }, { status: 200, headers: noStore });
  } catch {
    return Response.json({ ok: false, error: apiAccess.unavailable }, { status: 503, headers: noStore });
  }
}
