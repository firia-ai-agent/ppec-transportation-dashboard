import { handleCallback } from "@vercel/queue";
import { getNeonDb } from "@/db/exec";
import { previewSkip } from "@/db/read-only";
import { handlers } from "@/modules/jobs/handlers";
import { handleWake } from "@/modules/jobs/runner";
import { QUEUE_VISIBILITY_TIMEOUT_SECONDS, queueRetryDirective, type WakeMessage } from "@/modules/jobs/scheduler";
import { vercelQueueTransport } from "@/modules/jobs/vercel-queue";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Queue trigger (topic ppec-timer, vercel.json). Not publicly invocable per Vercel Queues docs.
// On previews it is a no-op (ack, no work): previews share the one production DB read-only (DECISION-LEDGER #43).
//
// Delivery is at-least-once and unordered with no delay SLA, so this handler must be idempotent, and is:
// `handleWake` either claims the job once (inside one transaction that re-checks cancelled / already fired /
// superseded / not yet due) or no-ops and acks. `dueAt`/`version` are the fence — `Partial` because a message
// published by an earlier deployment predates the fence and must still be honoured, not dropped.
export const POST = handleCallback(async (message: { jobId: string } & Partial<WakeMessage>) => {
  const skip = previewSkip(process.env);
  if (skip) { console.log(`[queue:timer] ${skip.skipped} (${skip.reason})`); return; }
  const r = await handleWake(getNeonDb(), message, process.env.VERCEL_DEPLOYMENT_ID ?? "local", handlers, undefined, { transport: vercelQueueTransport });
  // Handler failed (job is back to SCHEDULED): throw so Vercel Queues redelivers this message (Option A).
  if (r === "failed") throw new Error("timer handler failed; requesting queue redelivery");
}, {
  // The queue's own lock on an in-flight message. 30 s is the package's documented floor (@minimum 30), so it
  // cannot be made to match the 2 s lease — crash recovery inside the 5 s bar comes from the re-wake we publish
  // ourselves at claim time, not from queue redelivery. See QUEUE_VISIBILITY_TIMEOUT_SECONDS.
  visibilityTimeoutSeconds: QUEUE_VISIBILITY_TIMEOUT_SECONDS,
  // Bounded exponential backoff (2 s, 4 s, … 60 s cap) instead of immediate redelivery (Veri #10, point 3), then
  // `{ acknowledge: true }` at MAX_DELIVERIES — @vercel/queue 0.8.0 has no maxDeliveries option and no DLQ, so
  // this callback is the only place the bound can live. The every-minute sweeper remains the backstop.
  retry: (_err, m) => queueRetryDirective(m.deliveryCount),
});
