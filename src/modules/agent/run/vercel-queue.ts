/**
 * The Vercel Queues publisher for topic `ppec-agent` (vercel.json `experimentalTriggers`), beside
 * the ones B-03 already has for timers and the outbox (`modules/jobs/vercel-queue.ts`,
 * `modules/outbox/transport.ts`).
 *
 * Its own file for the same reason as theirs: `@vercel/queue` is a platform import, and the
 * modules that decide *what* to publish stay testable without it. A lost publish is not silent —
 * `enqueueRun` throws and the caller's own retry collapses onto the same run (`startRun` is
 * idempotent on the trigger).
 */
import { send } from "@vercel/queue";
import { drivesAgentLocally, postLocalAgentWake } from "@/lib/dev-agent-wake";
import { AGENT_TOPIC, type AgentWake, type AgentWakeTransport } from "./queue";

export const vercelQueueAgentTransport: AgentWakeTransport = {
  async publish(msg: AgentWake, opts: { idempotencyKey: string }) {
    // `next dev` has no queue (ledger #76): the dev server's own consumer route runs it instead.
    if (drivesAgentLocally()) return postLocalAgentWake(msg);
    await send(AGENT_TOPIC, msg, { idempotencyKey: opts.idempotencyKey });
  },
};
