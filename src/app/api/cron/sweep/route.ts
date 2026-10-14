import { getNeonDb } from "@/db/exec";
import { previewSkip } from "@/db/read-only";
import { cronAuthorized } from "@/lib/cron-auth";
import { handlers } from "@/modules/jobs/handlers";
import { sweep } from "@/modules/jobs/runner";
import { vercelQueueTransport } from "@/modules/jobs/vercel-queue";
import { sweepOutbox } from "@/modules/outbox/outbox";
import { outboxDeps } from "@/modules/outbox/deps";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Production: Vercel Cron every minute (vercel.json).
// Previews share the one production DB and run read-only (DECISION-LEDGER #43), so the sweep — which
// claims jobs and sends outbox messages — refuses there: 200 + {skipped}, so it does not spam errors.
export async function GET(req: Request) {
  if (!cronAuthorized(req.headers.get("authorization"), process.env.CRON_SECRET)) {
    return new Response("unauthorized", { status: 401 });
  }
  const skip = previewSkip(process.env);
  if (skip) return Response.json(skip, { headers: { "cache-control": "no-store" } });
  const deploymentId = process.env.VERCEL_DEPLOYMENT_ID ?? "local";
  const db = getNeonDb();
  const report = await sweep(db, vercelQueueTransport, deploymentId, handlers);
  const outbox = await sweepOutbox(db, outboxDeps());
  return Response.json({ deploymentId, ...report, outbox });
}
