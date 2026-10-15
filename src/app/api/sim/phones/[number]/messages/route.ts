import { API } from "@/auth/access";
import { requireApiSession } from "@/auth/api-guard";
import { getNeonDb } from "@/db/exec";
import { clampLimit, personaMailboxResponse } from "@/modules/messaging/mailbox";

export const dynamic = "force-dynamic";

const noStore = { "cache-control": "no-store" };

/**
 * Persona phone contents for the demo panel (MOCKS §3, DESIGN-DIRECTION §6.3).
 *
 * Three steps, in this order, and the order is the guard:
 *  1. the shared session guard (src/auth/api-guard.ts) with this route's own row, so a signed-out
 *     caller is a 401 before the phone number is read and before a database connection is opened —
 *     the persona lookup never runs for someone with no session — and a role the row does not name
 *     is a 403 in the same JSON shape every endpoint uses;
 *  2. the pepper, without which the blind index cannot be computed at all;
 *  3. personaMailboxResponse, which re-checks the role **against the site that phone belongs to**
 *     and answers a uniform 404 for a phone at any other site — identical to the answer for a
 *     number that belongs to nobody. The site comes from the data, never from the request.
 *
 * `?limit=` is clamped in the module (`clampLimit`), so a negative, huge or unreadable value is a
 * page size in range rather than an error or an unbounded read.
 */
export async function GET(req: Request, ctx: { params: Promise<{ number: string }> }) {
  const guard = await requireApiSession(API.simPhoneMessages);
  if (!guard.ok) return guard.response;
  const pepper = process.env.HMAC_PEPPER;
  if (!pepper) return Response.json({ error: "NOT_CONFIGURED" }, { status: 503, headers: noStore });
  const { number } = await ctx.params;
  const r = await personaMailboxResponse(getNeonDb(), {
    number, pepper, userId: guard.caller.userId, limit: clampLimit(new URL(req.url).searchParams.get("limit")),
  });
  return Response.json(r.body, { status: r.status, headers: noStore });
}
