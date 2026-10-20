import { API } from "@/auth/access";
import { requireApiSession } from "@/auth/api-guard";
import { getNeonDb } from "@/db/exec";
import { isReadOnlyDbEnv } from "@/db/read-only";
import { addFeedback, feedbackBody } from "@/modules/feedback/store";
import { siteOf } from "@/modules/plan/site";
import { apiAccess, feedbackCopy } from "@/ui/copy";

export const dynamic = "force-dynamic";

const noStore = { "cache-control": "no-store" };

/**
 * `POST /api/feedback` — the DEMO bar's Feedback button (ledger #82): one line from any member of
 * staff, saved at their own site. The words are never logged; a failure says only that it failed.
 */
export async function POST(req: Request) {
  const guard = await requireApiSession(API.feedback);
  if (!guard.ok) return guard.response;
  if (isReadOnlyDbEnv(process.env)) {
    return Response.json({ ok: false, error: feedbackCopy.previewRefusal }, { status: 403, headers: noStore });
  }
  const parsed = feedbackBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ ok: false, error: apiAccess.badRequest }, { status: 400, headers: noStore });
  }
  try {
    const saved = await addFeedback(getNeonDb(), {
      ...parsed.data,
      siteId: siteOf(guard.caller),
      by: guard.caller.userId ? `staff:${guard.caller.userId}` : "staff:unknown",
      now: new Date(),
    });
    return Response.json({ ok: true, id: saved.id }, { status: 201, headers: noStore });
  } catch {
    return Response.json({ ok: false, error: apiAccess.unavailable }, { status: 503, headers: noStore });
  }
}
