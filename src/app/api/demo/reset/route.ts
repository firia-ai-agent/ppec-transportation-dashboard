import { z } from "zod";
import { auth } from "@/auth";
import { getNeonDb } from "@/db/exec";
import { handleDemoReset } from "@/modules/demo/reset";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const body = z.object({ siteId: z.string().uuid().optional() });

/**
 * Reset & seed the standard synthetic scenario (MOCKS-AND-DEMO §6). DIRECTOR only, behind the ADR-014
 * demo flags; the authorization and the data-class refusal both live in handleDemoReset.
 */
export async function POST(req: Request) {
  const session = await auth();
  const parsed = body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return Response.json({ ok: false, error: "Bad request." }, { status: 400 });
  const r = await handleDemoReset(getNeonDb(), process.env, {
    userId: session?.user?.id, siteId: parsed.data.siteId, now: new Date(),
  });
  return Response.json(r.body, { status: r.status, headers: { "cache-control": "no-store" } });
}
