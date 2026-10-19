import { z } from "zod";
import { API } from "@/auth/access";
import { requireApiSession } from "@/auth/api-guard";
import { getNeonDb } from "@/db/exec";
import { vercelQueueAgentTransport } from "@/modules/agent/run/vercel-queue";
import { demoControlsGate } from "@/modules/demo/gate";
import { simulateParentText } from "@/modules/demo/parent-text";
import { vercelQueueOutboxTransport } from "@/modules/outbox/transport";
import { siteOf } from "@/modules/plan/site";
import { dayDataSource, planStore } from "@/modules/plan/store";

export const dynamic = "force-dynamic";
export const maxDuration = 10;

const KEY = z.string().regex(/^[A-Za-z0-9-]{1,16}$/);
const body = z.object({ child: KEY.nullable().optional(), among: z.array(KEY).max(50).optional() });
const noStore = { "cache-control": "no-store" };

/**
 * "SIMULATE PARENT TEXT" (ledger #78): a parent texts that they won't be home at their child's
 * estimated drop-off, through the real inbound path (`modules/demo/parent-text.ts`). The demo gate
 * first, before a session or a connection; then the access row's roles; the site is the caller's.
 * It answers with the child whose family texted, so the screen can open that thread.
 */
export async function POST(req: Request) {
  const gate = demoControlsGate(process.env);
  if (!gate.allowed) return Response.json({ ok: false, error: gate.reason }, { status: gate.status, headers: noStore });
  const guard = await requireApiSession(API.demoParentText);
  if (!guard.ok) return guard.response;
  const parsed = body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return Response.json({ ok: false, error: "BAD_REQUEST" }, { status: 400, headers: noStore });
  const siteId = siteOf(guard.caller);
  const r = await simulateParentText(
    getNeonDb(),
    {
      env: process.env,
      now: new Date(),
      agentTransport: vercelQueueAgentTransport,
      outboxTransport: vercelQueueOutboxTransport,
      store: planStore(),
      source: dayDataSource(siteId),
    },
    { siteId, childKey: parsed.data.child ?? null, among: parsed.data.among },
  );
  if (!r.sent) console.log(`[demo:parent-text] not sent (${r.reason}${r.detail ? `: ${r.detail}` : ""})`);
  return Response.json(
    r.sent ? { ok: true, child: r.childKey } : { ok: false, error: r.reason },
    { status: r.sent ? 200 : 409, headers: noStore },
  );
}
