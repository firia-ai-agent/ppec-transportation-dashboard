import { z } from "zod";
import { API } from "@/auth/access";
import { requireApiSession } from "@/auth/api-guard";
import { ACTIONS } from "@/modules/actions/registry";
import { screenCtx } from "@/modules/actions/screen";
import { apiAccess } from "@/ui/copy";

export const dynamic = "force-dynamic";

const noStore = { "cache-control": "no-store" };
const body = z.strictObject({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), direction: z.enum(["AM", "PM"]) });

/**
 * `POST /api/plan/replan` — the ramp's Re-plan (ledger #76): Auto-plan this leg as a **draft card**
 * in the agent bubble, saying what it would change and what that does to the day. Nothing is saved
 * here; Approve on the card saves it. The same action the agent's `auto_plan` runs.
 */
export async function POST(req: Request) {
  const guard = await requireApiSession(API.planReplan);
  if (!guard.ok) return guard.response;
  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ ok: false, error: apiAccess.badRequest }, { status: 400, headers: noStore });
  }
  try {
    const answer = await ACTIONS.auto_plan.run(screenCtx(guard.caller), parsed.data);
    return Response.json(answer.body, { status: answer.status, headers: noStore });
  } catch {
    return Response.json({ ok: false, error: apiAccess.unavailable }, { status: 503, headers: noStore });
  }
}
