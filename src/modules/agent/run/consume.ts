/**
 * ONE AGENT WAKE-UP, DRIVEN (ledger #74, #76): the whole of what the `ppec-agent` queue consumer
 * does with a message, in one function so the queue route and a local dev server run the same
 * code — the same lease, the same driver, the same settle. On Vercel the route calls it per
 * delivery; on `next dev`, which has no queue, the publisher calls it in-process
 * (`vercel-queue.ts`), so the agent answers on localhost exactly as it would on a deployment.
 */
import { getNeonDb } from "@/db/exec";
import { previewSkip } from "@/db/read-only";
import { settleStaffAsk } from "../ask/staff-ask";
import { agentRunner } from "./deps";
import { modelReach, modelReachLog } from "./model-reach";
import { agentWakeLog, handleAgentWake } from "./queue";

export async function consumeAgentWake(message: unknown): Promise<void> {
  const skip = previewSkip(process.env);
  if (skip) { console.log(`[queue:agent] ${skip.skipped} (${skip.reason})`); return; }
  const db = getNeonDb();
  const runner = agentRunner(db);
  if (!runner.ok) { console.log(`[queue:agent] ${runner.skipped} (${runner.reason})`); return; }
  // Said once per delivery when it applies: this run has no model to call, so its first turn will
  // be refused and the family's text will go in front of a person. The log is no longer the *only*
  // place it is visible — `modelReach` is the same function the phone panel reads to say it on
  // screen (Vera's review, 2026-10-17), so a log line and a sentence a coordinator reads cannot
  // disagree about whether a model answered.
  if (runner.refused) console.log(`[queue:agent] no model available: ${modelReachLog(modelReach())}`);
  const outcome = await handleAgentWake(db, message, { deps: runner.deps });
  console.log(`[queue:agent] ${agentWakeLog(outcome)}`);
  // A staff ask that ended with nothing to say gets its "couldn't answer" alert (ledger #74).
  if (outcome.ok) await settleStaffAsk(db, outcome.runId);
}
