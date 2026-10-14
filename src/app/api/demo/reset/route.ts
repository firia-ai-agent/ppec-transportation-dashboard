import { z } from "zod";
import { auth } from "@/auth";
import { getNeonDb } from "@/db/exec";
import { demoControlsGate, handleDemoReset } from "@/modules/demo/reset";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const body = z.object({ siteId: z.string().uuid().optional() });
const noStore = { "cache-control": "no-store" };

/**
 * Reset & seed the standard synthetic scenario (MOCKS-AND-DEMO §6). DIRECTOR only, behind the ADR-014
 * demo flags; the authorization and the data-class refusal both live in handleDemoReset.
 *
 * The environment gate runs here first, before the session lookup and before getNeonDb(), so a preview
 * deployment (which is served production's DATABASE_URL — DECISION-LEDGER #43) refuses without opening
 * a connection at all. handleDemoReset re-checks it, so the module is safe on its own too.
 */
export async function POST(req: Request) {
  const gate = demoControlsGate(process.env);
  if (!gate.allowed) return Response.json({ ok: false, error: gate.reason }, { status: gate.status, headers: noStore });
  const session = await auth();
  const parsed = body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return Response.json({ ok: false, error: "Bad request." }, { status: 400, headers: noStore });
  const r = await handleDemoReset(getNeonDb(), process.env, {
    userId: session?.user?.id, siteId: parsed.data.siteId, now: new Date(),
  });
  return Response.json(r.body, { status: r.status, headers: noStore });
}
