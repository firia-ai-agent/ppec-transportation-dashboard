import { handleCallback } from "@vercel/queue";
import { getNeonDb } from "@/db/exec";
import { handlers } from "@/modules/jobs/handlers";
import { handleWake } from "@/modules/jobs/runner";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Queue trigger (topic ppec-timer, vercel.json). Not publicly invocable per Vercel Queues docs.
export const POST = handleCallback(async (message: { jobId: string }) => {
  await handleWake(getNeonDb(), message, process.env.VERCEL_DEPLOYMENT_ID ?? "local", handlers);
});
