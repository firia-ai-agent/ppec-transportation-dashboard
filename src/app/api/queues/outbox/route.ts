import { handleCallback } from "@vercel/queue";
import { getNeonDb } from "@/db/exec";
import { previewSkip } from "@/db/read-only";
import { drain } from "@/modules/outbox/outbox";
import { outboxDeps } from "@/modules/outbox/deps";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Queue trigger (topic ppec-outbox, vercel.json). drain() is idempotent: duplicates and late wakes are no-ops.
// On previews it is a no-op (ack, no work): previews share the one production DB read-only (DECISION-LEDGER #43).
export const POST = handleCallback(async (message: { messageId: string }) => {
  const skip = previewSkip(process.env);
  if (skip) { console.log(`[queue:outbox] ${skip.skipped} (${skip.reason})`); return; }
  await drain(getNeonDb(), message.messageId, outboxDeps());
});
