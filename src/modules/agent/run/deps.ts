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
 * What is left to refuse for is the **vendor**: the live provider is only usable where the
 * ADR-015 data class, the operator's demo-data confirmation and the key all agree
 * (`liveCallRefusalReason`). Where they do not, the run is driven on the PRD §18.1 degraded
 * provider — the keyword parser, which emits one `escalate_exception` and puts the message in
 * front of a person — rather than not at all. A family text that produced nothing because a key
 * was missing is worse than one that produced a triage item: it looks handled.
 */
import type { Db } from "@/db/exec";
import { VercelQueueScheduler } from "@/modules/jobs/scheduler";
import { vercelQueueTransport } from "@/modules/jobs/vercel-queue";
import { vercelQueueOutboxTransport } from "@/modules/outbox/transport";
import { loadAgentConfig, type AgentConfig } from "../config";
import { createGateway } from "../gateway";
import { keywordProvider } from "../providers/keyword";
import type { LlmProvider } from "../providers/provider";
import { liveCallRefusalReason, remoteProvider } from "../providers/remote";
import { dbContextAssembler } from "./assembler";
import { liveExecutors, liveProposalWriter } from "./exec/registry";
import type { RunDeps } from "./loop";

/**
 * The vendor this deployment can actually reach, and why.
 *
 * `reason` is null on the live path and is the refusal's own words otherwise — a missing
 * `$OPENROUTER_API_KEY`, an unconfirmed demo-data deployment, a base URL this build may not send
 * a key to. It names the *variable*, never a value: the key is read inside the adapter and
 * appears in no log line, no error and no property (providers/remote.ts).
 */
export type ProviderChoice = {
  readonly provider: LlmProvider;
  readonly degraded: boolean;
  readonly reason: string | null;
};

export function chooseProvider(
  config: AgentConfig = loadAgentConfig(),
  env: Record<string, string | undefined> = process.env,
): ProviderChoice {
  const reason = liveCallRefusalReason(config, env);
  if (reason) return { provider: keywordProvider(config), degraded: true, reason };
  // The adapter's own chain is primary model → backup model → keyword parser, so a 429 degrades
  // inside the call rather than failing the run (providers/remote.ts).
  return { provider: remoteProvider(config, env), degraded: false, reason: null };
}

/**
 * WHICH READER WILL ANSWER, SAID ONCE, FOR THE LOG AND FOR THE SCREEN.
 *
 * The queue route used to be the only thing that knew: it logged "degraded provider (…)" per
 * delivery and the screens said nothing, so a deployment whose model was unreachable looked
 * perfectly healthy to the coordinator reading a family's thread — the keyword reader's answer
 * arrived with no sign that a model had never seen the text. Vera's review (2026-10-17): say it
 * plainly on the screen, not only in a server log.
 *
 * So the route and the panel read the same function, which is the point of it being here rather
 * than in the panel: a log line and a sentence on screen that could disagree would be worse than
 * either alone. Three answers, and they are the three things that can actually be true:
 *
 *  - `model` — a vendor this deployment may call, named by its model id, which is what a reviewer
 *    checks. (A model that is reachable but *fails* is not this: the adapter's own chain degrades
 *    inside the call, and the turn comes back labelled `keyword` by `DemoAgentTurn.source`.)
 *  - `keyword` — no live call is allowed or possible, so the PRD §18.1 keyword reader will answer
 *    and the message still ends in front of a person. Degraded, working, and said so.
 *  - `unavailable` — there is no reader at all: a config this build cannot parse, a base URL off
 *    the host allow-list. Nothing runs, so the screen has to say that and say what to do instead.
 *
 * `reason` is the refusal's own words — the name of an environment variable, never a value. The
 * key is read inside the adapter and appears in no log line, no error and no property
 * (providers/remote.ts), and `key-never-leaves.test.ts` holds that. It is **not** rendered: the
 * sentences a coordinator reads live in `ui/copy.ts` and name no variable at all. This field is
 * for the server log.
 *
 * Reads the environment only — no database — so a server component can call it.
 */
export type ModelReach =
  | { readonly kind: "model"; readonly model: string }
  | { readonly kind: "keyword"; readonly reason: string }
  | { readonly kind: "unavailable"; readonly reason: string };

export function modelReach(env: Record<string, string | undefined> = process.env): ModelReach {
  try {
    const config = loadAgentConfig(env);
    const choice = chooseProvider(config, env);
    if (choice.degraded) return { kind: "keyword", reason: choice.reason ?? "no live call allowed" };
    return { kind: "model", model: config.model };
  } catch (e) {
    return { kind: "unavailable", reason: (e instanceof Error ? e.message : String(e)).slice(0, 280) };
  }
}

/** The one log line for a reach, for whichever route is about to drive a run. */
export function modelReachLog(reach: ModelReach): string {
  return reach.kind === "model" ? `model ${reach.model}` : `${reach.kind} (${reach.reason})`;
}

export type AgentRunner =
  | { readonly ok: true; readonly deps: RunDeps; readonly degraded: boolean; readonly reason: string | null }
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
    // A vendor this deployment may not call at all — a base URL off the allow-list, a provider
    // mismatch. Nothing to degrade to that would be honest, so the delivery is acked with the
    // reason rather than retried forever against a configuration nobody will fix in 150 seconds.
    return { ok: false, skipped: "no agent provider", reason: (e instanceof Error ? e.message : String(e)).slice(0, 280) };
  }
  const execDeps = {
    db,
    scheduler: new VercelQueueScheduler(db, vercelQueueTransport),
    transport: vercelQueueOutboxTransport,
  };
  return {
    ok: true,
    degraded: choice.degraded,
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
