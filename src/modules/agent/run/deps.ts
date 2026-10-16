/**
 * What the agent queue route would drive a run *with* — and why this deployment has none yet.
 *
 * `RunDeps` (loop.ts) is five things: the database, the slice-1 gateway, the live executor registry,
 * the §11.2 proposal writer, and **`assemble`** — the §11.1 context assembler. Four of the five
 * exist and are tested: `getNeonDb()`, `createGateway` over `providers/remote.ts`,
 * `exec/registry.liveExecutors` and `liveProposalWriter`. The fifth does not, and cannot be
 * invented here.
 *
 * `ContextAssembler` has to return two things per turn: `TierFacts` (§11.1's T1–T4 — approved facts
 * and authorization scopes from B-02, tokenized through B-07's identity vault, the last N
 * family-scoped messages from B-04's threads, preferences from a store that does not exist) and a
 * `PolicyContext` whose `scope`, `sendableSubjects` and `paused` flag come from the session the
 * trigger arrived on. Both are **Partial** rows in the §11.1 table of
 * `docs/agent/B08-SLICE1-DEFERRED.md`, and the scope half is VERI-3: the session → scope builder
 * lands with the B-04/B-12 callers.
 *
 * So the honest answer at this boundary is to refuse, and to refuse the way everything else in this
 * module refuses — **fail shut, by name, with nothing executed**. A standin assembler would be
 * strictly worse than no runner: `PolicyContext.scope` is what decides which family's and which
 * site's objects a call may name, and a scope this process made up for itself is the one shape of
 * cross-tenant write the family-scope post-validator cannot see (loop.ts `scopeSiteRefusal`). A
 * guessed `sendableSubjects` would be a consent decision nobody made, and a guessed `paused` would
 * be the kill switch answered by the runtime instead of by a person.
 *
 * The route therefore acks its deliveries and logs this reason, which is the same shape as the
 * preview skip beside it (`previewSkip`): a delivery nobody can act on is a no-op, not an error.
 * Nothing publishes to `ppec-agent` in production yet either — `enqueueRun`'s callers are the five
 * §11.1 triggers, all of which belong to other milestones — so this refusal is what *would* happen
 * rather than what does.
 *
 * When the assembler's sources land, this function returns the deps and the route does not change.
 */
import type { RunDeps } from "./loop";

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
