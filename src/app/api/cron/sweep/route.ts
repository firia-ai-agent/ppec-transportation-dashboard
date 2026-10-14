import { getNeonDb } from "@/db/exec";
import { cronAuthorized } from "@/lib/cron-auth";
import { handlers } from "@/modules/jobs/handlers";
import { sweep } from "@/modules/jobs/runner";
import { vercelQueueTransport } from "@/modules/jobs/vercel-queue";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Production: Vercel Cron every minute (vercel.json). Previews: the harness calls this with the same header.
export async function GET(req: Request) {
  if (!cronAuthorized(req.headers.get("authorization"), process.env.CRON_SECRET)) {
    return new Response("unauthorized", { status: 401 });
  }
  const deploymentId = process.env.VERCEL_DEPLOYMENT_ID ?? "local";
  const report = await sweep(getNeonDb(), vercelQueueTransport, deploymentId, handlers);
  return Response.json({ deploymentId, ...report });
}
