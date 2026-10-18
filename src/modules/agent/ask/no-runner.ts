/**
 * Main's staff-ask runner, kept as-is for the demo (Veri PPE-91): #75's run/deps.ts builds a real
 * runner, and #84's ruled bubble behaviour is the staff alert only. Reconcile after the demo.
 */
import type { RunDeps } from "../run/loop";

/** Why no run can be driven in this deployment. One string, so the route and its test share it. */
export const AGENT_RUNNER_NO_CONTEXT_SOURCE =
  "no §11.1 context assembler: the tier sources (B-02/B-07/B-04) and the session → scope builder (VERI-3, B-04/B-12) are not built, and a run must not be driven against a scope this process invented";

export type AgentRunner =
  | { readonly ok: true; readonly deps: RunDeps }
  | { readonly ok: false; readonly skipped: string; readonly reason: string };

/**
 * The deps the agent queue consumer drives with, or the named refusal above. Shaped like
 * `previewSkip` on purpose: the route's two reasons for acking without work read the same way in
 * the log.
 */
export function agentRunner(): AgentRunner {
  return { ok: false, skipped: "no agent runner", reason: AGENT_RUNNER_NO_CONTEXT_SOURCE };
}
