/**
 * TRIAGE: A FAST MODEL READS EVERY FAMILY TEXT FIRST (ledger #85; PRD RES-01, MET-02, SURF-03).
 *
 * Step 0 of a `msg.inbound` run, never in the webhook. One call to the triage gateway — a second
 * gateway over the configured `triageModel`, with the same allow-lists, demo-data guard and audit
 * as the first — offered one tool, `classify_message`, on the very prompt the full run would get
 * (the same tiers and the same untrusted wrapping), with the task swapped for the triage one.
 *
 * What it decides:
 *  - FYI / NOISE: the full agent does not run. The text is on the thread with its chip; nobody is
 *    paged and no card is drafted, because there is nothing to change.
 *  - PLAN_TODAY / PLAN_LATER: the full run goes on as before.
 *  - Triage unavailable, refused, or unconfigured: the full run goes on as before. There is no
 *    rule-based stand-in (`no-keyword-fallback.test.ts`) — a text that could not be read by a
 *    model is read by the model that always read it.
 *
 * What it writes: `message.resolved_child_tokens` / `resolve_confidence` (RES-01's columns, unused
 * until now), `message.triage_relevance`, the turn's token counts on the run, and one audit row of
 * codes and counts. Never a word of the text.
 */
import type { Exec } from "@/db/exec";
import type { LlmGateway } from "../gateway";
import { TRIAGE_RELEVANCE, TRIAGE_TOOL, type TriageRelevance } from "../tools";
import type { AssembledContext } from "./context";
import { resolveScopeTokens } from "./scope-tokens";
import { addRunTokens } from "./store";

export type Triage = { readonly gateway: LlmGateway };

export type TriageVerdict = {
  readonly relevance: TriageRelevance;
  readonly intent: string;
  readonly childTokens: readonly string[];
  readonly confidence: number;
};

/** The relevances that end the run at triage: nothing on today's or a later plan to change. */
export const ENDS_AT_TRIAGE: ReadonlySet<TriageRelevance> = new Set(["FYI", "NOISE"]);

/** The triage turn's task, in place of the full run's (`context.ts` FAMILY_TASK). */
const TRIAGE_TASK: readonly string[] = [
  `task=call ${TRIAGE_TOOL} once`,
  "guide=read the newest T3 text against T1/T2; say whether it changes a ride today, another day, is only worth a person seeing, or is nothing; name the children it is about as the tokens above",
];

/** The full run's prompt with its task lines swapped for triage's. Every tier line is kept as is. */
export function triagePrompt(prompt: string): string {
  const kept = prompt.split("\n").filter((line) => !line.startsWith("task=") && !line.startsWith("guide="));
  return [...kept, ...TRIAGE_TASK].join("\n");
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Classify the run's message, or null when triage could not (any refusal or outage): the caller
 * then runs the full agent, as it always did.
 */
export async function triageMessage(
  db: Exec,
  triage: Triage,
  run: { readonly id: string; readonly siteId: string; readonly messageId: string; readonly actor: string },
  assembled: AssembledContext,
): Promise<TriageVerdict | null> {
  let turn;
  try {
    turn = await triage.gateway.complete({
      runId: run.id,
      prompt: triagePrompt(assembled.prompt),
      tools: [TRIAGE_TOOL],
      maxCalls: 1,
    });
  } catch (e) {
    // The class of the failure, never its text: a provider message can carry an endpoint.
    console.warn(`[agent:triage] run=${run.id} not triaged (${e instanceof Error ? e.name : "error"})`);
    return null;
  }
  await addRunTokens(db, run.id, turn.usage, run.actor);
  const args = assembled.tokens ? resolveScopeTokens(turn.call.args, assembled.tokens) : turn.call.args;
  const relevance = (TRIAGE_RELEVANCE as readonly string[]).includes(String(args.relevance))
    ? (args.relevance as TriageRelevance)
    : null;
  if (relevance === null) return null;
  // Only children this run's scope could resolve: a label it does not hold stays a label, not an id.
  const childTokens = (Array.isArray(args.child_tokens) ? args.child_tokens : []).map(String).filter((t) => UUID.test(t));
  const verdict: TriageVerdict = {
    relevance,
    intent: String(args.intent ?? "OTHER"),
    childTokens,
    confidence: typeof args.confidence === "number" ? args.confidence : 0,
  };

  // A trigger id that is not a message id (a hand-built run) has no row to annotate.
  if (UUID.test(run.messageId)) await db.query(
    `UPDATE ops.message
        SET resolved_child_tokens = $3::uuid[], resolve_confidence = $4, triage_relevance = $5,
            updated_at = now(), updated_by = $6, version = version + 1
      WHERE id = $1 AND site_id = $2`,
    [run.messageId, run.siteId, verdict.childTokens, verdict.confidence, verdict.relevance, run.actor],
  );
  // MET-02 counts by intent from here: codes and counts only.
  await db.query(
    `INSERT INTO ops.audit_event (site_id, actor, action, entity, entity_id, detail)
     VALUES ($1, $2, 'agent.triage', 'message', $3, $4::jsonb)`,
    [run.siteId, run.actor, run.messageId, JSON.stringify({
      relevance: verdict.relevance, intent: verdict.intent, children: verdict.childTokens.length, confidence: verdict.confidence,
    })],
  );
  return verdict;
}
