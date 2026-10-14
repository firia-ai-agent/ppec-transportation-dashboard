import { handleCallback } from "@vercel/queue";
import { getNeonDb } from "@/db/exec";
import { previewSkip } from "@/db/read-only";
import { handlers } from "@/modules/jobs/handlers";
import { handleWake } from "@/modules/jobs/runner";
import { redeliveryDelaySeconds } from "@/modules/jobs/scheduler";
import { vercelQueueTransport } from "@/modules/jobs/vercel-queue";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Queue trigger (topic ppec-timer, vercel.json). Not publicly invocable per Vercel Queues docs.
// On previews it is a no-op (ack, no work): previews share the one production DB read-only (DECISION-LEDGER #43).
export const POST = handleCallback(async (message: { jobId: string }) => {
  const skip = previewSkip(process.env);
  if (skip) { console.log(`[queue:timer] ${skip.skipped} (${skip.reason})`); return; }
  const r = await handleWake(getNeonDb(), message, process.env.VERCEL_DEPLOYMENT_ID ?? "local", handlers, undefined, { transport: vercelQueueTransport });
  // Handler failed (job is back to SCHEDULED): throw so Vercel Queues redelivers this message (Option A).
  if (r === "failed") throw new Error("timer handler failed; requesting queue redelivery");
}, {
  // Bounded exponential backoff instead of immediate redelivery (Veri #10, point 3): @vercel/queue 0.8.0
  // reschedules the message by `afterSeconds` when the handler throws, so a few seconds of DB or provider
  // trouble no longer burns all 5 attempts. The every-minute sweeper remains the backstop.
  retry: (_err, m) => ({ afterSeconds: redeliveryDelaySeconds(m.deliveryCount) }),
});
