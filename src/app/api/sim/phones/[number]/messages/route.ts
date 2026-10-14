import { auth } from "@/auth";
import { getNeonDb } from "@/db/exec";
import { DEFAULT_LIMIT, personaMailboxResponse } from "@/modules/messaging/mailbox";

export const dynamic = "force-dynamic";

/**
 * Persona phone contents for the demo panel (MOCKS §3, DESIGN-DIRECTION §6.3). Staff session required; the
 * authorization and read live in modules/messaging/mailbox.ts so they are testable without the Auth.js runtime.
 */
export async function GET(req: Request, ctx: { params: Promise<{ number: string }> }) {
  const pepper = process.env.HMAC_PEPPER;
  if (!pepper) return Response.json({ error: "NOT_CONFIGURED" }, { status: 503 });
  const session = await auth();
  const { number } = await ctx.params;
  const limit = Number(new URL(req.url).searchParams.get("limit") ?? DEFAULT_LIMIT);
  const r = await personaMailboxResponse(getNeonDb(), {
    number, pepper, userId: session?.user?.id, limit: Number.isFinite(limit) ? limit : DEFAULT_LIMIT,
  });
  return Response.json(r.body, { status: r.status, headers: { "cache-control": "no-store" } });
}
