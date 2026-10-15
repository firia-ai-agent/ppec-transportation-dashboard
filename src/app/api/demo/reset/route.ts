import { z } from "zod";
import { API } from "@/auth/access";
import { requireApiSession } from "@/auth/api-guard";
import { getNeonDb } from "@/db/exec";
import { demoControlsGate, handleDemoReset } from "@/modules/demo/reset";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const body = z.object({ siteId: z.string().uuid().optional() });
const noStore = { "cache-control": "no-store" };

/**
 * Reset & seed the standard synthetic scenario (MOCKS-AND-DEMO §6). Behind the ADR-014 demo flags and
 * open to the role the access table names for this route — DIRECTOR — at the caller's own site.
 *
 * Three guards, in this order, and each one is here rather than inside the next because of what it
 * protects:
 *  1. the environment gate, first, before the session lookup and before getNeonDb(), so a preview
 *     deployment (served production's DATABASE_URL — DECISION-LEDGER #43) refuses without opening a
 *     connection at all. handleDemoReset re-checks it, so the module is safe on its own too;
 *  2. the shared session guard (src/auth/api-guard.ts), which answers 401 without a session and 403
 *     for a role this route does not serve — the same JSON shape every endpoint uses;
 *  3. handleDemoReset, which re-checks the role **against the site being reset** and answers a
 *     uniform 404 for any site the caller is not a member of.
 */
export async function POST(req: Request) {
  const gate = demoControlsGate(process.env);
  if (!gate.allowed) return Response.json({ ok: false, error: gate.reason }, { status: gate.status, headers: noStore });
  const guard = await requireApiSession(API.demoReset);
  if (!guard.ok) return guard.response;
  const parsed = body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return Response.json({ ok: false, error: "Bad request." }, { status: 400, headers: noStore });
  const r = await handleDemoReset(getNeonDb(), process.env, {
    userId: guard.caller.userId, siteId: parsed.data.siteId, now: new Date(),
  });
  return Response.json(r.body, { status: r.status, headers: noStore });
}
