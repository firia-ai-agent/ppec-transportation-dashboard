import { API } from "@/auth/access";
import { requireApiSession } from "@/auth/api-guard";
import { getNeonDb } from "@/db/exec";
import { askAgent } from "@/modules/agent/ask/staff-ask";
import { siteOf } from "@/modules/plan/api";
import { apiAccess } from "@/ui/copy";

export const dynamic = "force-dynamic";
// The ask drives its run inside this request under `askTimeoutMs` (20 s by default), so the
// platform's own ceiling sits above it: an ask that runs out is a staff alert, never a 504.
export const maxDuration = 60;

const noStore = { "cache-control": "no-store" };

/**
 * `POST /api/agent/ask` — one ask, typed into the chat bubble's compose bar.
 *
 * The route is a guard, a parse and a call: everything that decides what happens is in
 * src/modules/agent/ask/staff-ask.ts, including the preview skip, so a second entry point added
 * later cannot get a different answer than this one.
 *
 * The roles are `APPROVAL_ROLES`, read from the access table's own row — the same constant the
 * For you tab is gated by. An ask can only come back as a proposal, and a proposal is decided in
 * For you, so a role that may not decide may not raise one. That the bubble is not *drawn* for
 * the front desk is a courtesy on top of this, never instead of it.
 *
 * What comes back is one sentence for the panel and nothing else: no run id, no trigger, no
 * reason code, and never the runner's own sentence about why it refused — that names build
 * milestones and belongs in a log.
 */
export async function POST(req: Request) {
  const guard = await requireApiSession(API.agentAsk);
  if (!guard.ok) return guard.response;

  const body: unknown = await req.json().catch(() => null);
  const text = typeof body === "object" && body !== null ? (body as { text?: unknown }).text : null;
  if (typeof text !== "string") {
    return Response.json({ ok: false, error: apiAccess.badRequest }, { status: 400, headers: noStore });
  }

  try {
    const result = await askAgent(getNeonDb(), {
      siteId: siteOf(guard.caller),
      text,
      // The audit actor is an id, never a name (ADR-004: the token carries only a user id).
      by: `staff:${guard.caller.userId ?? "session"}`,
    });
    if (result.outcome === "rejected") {
      return Response.json({ ok: false, error: apiAccess.badRequest }, { status: 400, headers: noStore });
    }
    // A preview and a missing model are both "nothing happened that you asked for", and the
    // panel says the same line for both: it is on your list now.
    // The model's answer in names and the proposal it made, when it ran; never a reason or a code.
    const said = result.outcome === "ran" ? { answer: result.answer, proposalId: result.proposalId } : {};
    return Response.json({ ok: result.ok, outcome: result.outcome, ...said }, { status: 200, headers: noStore });
  } catch {
    return Response.json({ ok: false, error: apiAccess.unavailable }, { status: 503, headers: noStore });
  }
}
