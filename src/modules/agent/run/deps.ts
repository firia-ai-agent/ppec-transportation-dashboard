/**
 * What the agent queue route drives a run *with* (PRD §11.1).
 *
 * `RunDeps` (loop.ts) is six things: the database, the slice-1 gateway, the §11.1 context
 * assembler, the live executor registry, the §11.2 proposal writer and B-03's scheduler. Five of
 * them have existed since slice 4; the assembler was the missing one, and until it landed this
 * module refused every delivery by name — a run must not be driven against a scope the runtime
 * invented, and a stand-in assembler would have been exactly that
 * (`PolicyContext.scope` is what decides which family's and which site's objects a call may
 * name).
 *
 * `run/assembler.ts` is now that reader, over the operational tables and nothing else: the site
 * off the trigger's message row, the family off its thread, the children off the family, the legs
 * off the children, the consent mirror off `ops.contact_authorization` and `ops.suppression`, and
 * the kill switch off the deployment's own environment. No identity-schema read, no invented
 * scope, and a trigger it has no reader for is still a refusal rather than a guess.
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
 *
 * **One thing to get right when it does:** build the gateway's provider through
 * `run/provider-choice.liveProviderOrRefusal`, not `providers/remote.remoteProvider` directly.
 * The adapter refuses at wiring time when the demo-data guard does not hold or there is no key,
 * and a throw *here* escapes the run — so the parent's text would be left with nobody told, which
 * is the founder's 2026-10-17 rule broken by a construction order. `liveProviderOrRefusal` turns
 * that refusal into a refused *turn*, so the loop raises the one staff alert and stops.
 */
import type { Db } from "@/db/exec";
import { VercelQueueScheduler } from "@/modules/jobs/scheduler";
import { vercelQueueTransport } from "@/modules/jobs/vercel-queue";
import { vercelQueueOutboxTransport } from "@/modules/outbox/transport";
import { loadAgentConfig, type AgentConfig } from "../config";
import { createGateway } from "../gateway";
import type { LlmProvider } from "../providers/provider";
import { liveCallRefusalReason } from "../providers/remote";
import { dbContextAssembler } from "./assembler";
import { liveProviderOrRefusal } from "./provider-choice";
import { liveExecutors, liveProposalWriter } from "./exec/registry";
import { chooseProvider, type ProviderChoice } from "./model-reach";

export { chooseProvider, modelReach, modelReachLog, type ModelReach, type ProviderChoice } from "./model-reach";
import type { RunDeps } from "./loop";

export type AgentRunner =
  | { readonly ok: true; readonly deps: RunDeps; readonly refused: boolean; readonly reason: string | null }
  | { readonly ok: false; readonly skipped: string; readonly reason: string };

/**
 * The deps the agent queue consumer drives with. Shaped like `previewSkip` on purpose: the
 * route's reasons for acking without work read the same way in the log.
 */
export function agentRunner(db: Db, env: Record<string, string | undefined> = process.env): AgentRunner {
  const config = loadAgentConfig(env);
  let choice: ProviderChoice;
  try {
    choice = chooseProvider(config, env);
  } catch (e) {
    // A configuration this build cannot make any provider from — a base URL off the allow-list, a
    // provider mismatch. There is nothing to run, so the delivery is acked with the reason rather
    // than retried forever against a configuration nobody will fix in 150 seconds. (A deployment
    // that merely may not *call* a vendor does not land here: it gets the refusing provider above,
    // so the run starts, fails on the first turn, and raises the one staff alert.)
    return { ok: false, skipped: "no agent provider", reason: (e instanceof Error ? e.message : String(e)).slice(0, 280) };
  }
  const execDeps = {
    db,
    scheduler: new VercelQueueScheduler(db, vercelQueueTransport),
    transport: vercelQueueOutboxTransport,
  };
  return {
    ok: true,
    refused: choice.refused,
    reason: choice.reason,
    deps: {
      db,
      gateway: createGateway(choice.provider, config),
      assemble: dbContextAssembler(db, { env }),
      executors: liveExecutors(execDeps),
      proposals: liveProposalWriter(execDeps),
      scheduler: execDeps.scheduler,
    },
  };
}
