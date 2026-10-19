import { handleCallback } from "@vercel/queue";
import { getNeonDb } from "@/db/exec";
import { previewSkip } from "@/db/read-only";
import { agentRunner } from "@/modules/agent/run/deps";
import {
  AGENT_QUEUE_VISIBILITY_TIMEOUT_SECONDS,
  agentRetryDirective,
  agentWakeLog,
  handleAgentWake,
} from "@/modules/agent/run/queue";
import { modelReach, modelReachLog } from "@/modules/agent/run/model-reach";
import { settleStaffAsk } from "@/modules/agent/ask/staff-ask";

export const dynamic = "force-dynamic";
// AGENT_RUN_MAX_DURATION_SECONDS, spelled out: Next parses the segment config statically and rejects
// the build ("Invalid segment configuration export detected") if this is anything but a literal.
// route.test.ts asserts the two are equal, so the constant is still the one place to change it.
export const maxDuration = 120;

// Queue trigger (topic ppec-agent, vercel.json). Not publicly invocable per the Vercel Queues docs,
// and a staff session grants nothing here (src/auth/access.ts, `queue-callback`).
//
// One message = one agent run (ARCHITECTURE §2). Delivery is at-least-once and unordered with no
// delay SLA, so this handler must be idempotent, and is: `handleAgentWake` takes the per-run lease
// before it drives anything (F2), and every refusal it can give — the run is finished, parked on its
// own timer, held by another driver, another tenant's, or unknown — is a no-op + ack. A drive that
// throws is the one case a redelivery helps, and it propagates for exactly that reason.
//
// Two reasons to ack without work, both logged rather than silent:
//  * previews share the one production DB read-only (DECISION-LEDGER #43), as on every queue route;
//  * this deployment can build no provider at all (`agentRunner`) — a base URL off the
//    allow-list is not a thing a redelivery fixes. A *missing key* is not one of these: the run
//    is driven, the first turn is refused, and the family's text ends in front of a person
//    (`agent/staff-alert.ts`) rather than being answered by anything deterministic.
export const POST = handleCallback(async (message: unknown) => {
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
}, {
  // Longer than the per-run lease, so the first redelivery after a dead driver finds a run it can
  // reclaim instead of spending a delivery on a `leased` refusal (queue.ts).
  visibilityTimeoutSeconds: AGENT_QUEUE_VISIBILITY_TIMEOUT_SECONDS,
  // Wait out the lease, then acknowledge at MAX_DELIVERIES — @vercel/queue 0.8.0 has no
  // maxDeliveries option and no DLQ, so this callback is the only place the bound can live.
  retry: (_err, m) => agentRetryDirective(m.deliveryCount),
});
