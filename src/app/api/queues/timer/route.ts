import { handleCallback } from "@vercel/queue";
import { getNeonDb } from "@/db/exec";
import { previewSkip } from "@/db/read-only";
import { handlers } from "@/modules/jobs/handlers";
import { handleWake } from "@/modules/jobs/runner";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Queue trigger (topic ppec-timer, vercel.json). Not publicly invocable per Vercel Queues docs.
// On previews it is a no-op (ack, no work): previews share the one production DB read-only (DECISION-LEDGER #43).
export const POST = handleCallback(async (message: { jobId: string }) => {
  const skip = previewSkip(process.env);
  if (skip) { console.log(`[queue:timer] ${skip.skipped} (${skip.reason})`); return; }
  await handleWake(getNeonDb(), message, process.env.VERCEL_DEPLOYMENT_ID ?? "local", handlers);
});
