import { handleCallback } from "@vercel/queue";
import { getNeonDb } from "@/db/exec";
import { drain } from "@/modules/outbox/outbox";
import { outboxDeps } from "@/modules/outbox/deps";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Queue trigger (topic ppec-outbox, vercel.json). drain() is idempotent: duplicates and late wakes are no-ops.
export const POST = handleCallback(async (message: { messageId: string }) => {
  await drain(getNeonDb(), message.messageId, outboxDeps());
});
