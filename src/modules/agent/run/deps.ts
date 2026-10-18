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
import type { RunDeps } from "./loop";

/**
 * The vendor this deployment can actually reach, and why.
 *
 * `reason` is null on the live path and is the refusal's own words otherwise — a missing
 * `$OPENROUTER_API_KEY`, an unconfirmed demo-data deployment, a base URL this build may not send
 * a key to. It names the *variable*, never a value: the key is read inside the adapter and
 * appears in no log line, no error and no property (providers/remote.ts).
 *
 * `refused` is where the PRD §18.1 keyword parser used to be. The founder's rule of 2026-10-17
 * ("never compensate with a deterministic text parser if the model isn't available; the
 * owner/staff need to be notified") deleted that reader, so a deployment that may not call a
 * vendor does not get a lesser one — it gets a provider that **refuses when asked for a turn**
 * (`run/provider-choice.ts`), which the loop classifies into the one staff alert. The run fails:
 * nothing is proposed, no leg moves and nothing is sent.
 *
 * The refusal is built here rather than thrown here for the reason `provider-choice.ts` exists:
 * a throw at wiring time escapes before a gateway exists, so the loop's `catch` never runs and
 * the parent's text is left with nobody told.
 */
export type ProviderChoice = {
  readonly provider: LlmProvider;
  /** True when the provider in hand will refuse every turn: no vendor this deployment may call. */
  readonly refused: boolean;
  readonly reason: string | null;
};

export function chooseProvider(
  config: AgentConfig = loadAgentConfig(),
  env: Record<string, string | undefined> = process.env,
): ProviderChoice {
  const reason = liveCallRefusalReason(config, env);
  return { provider: liveProviderOrRefusal(config, env), refused: reason !== null, reason };
}

/**
 * WHETHER A MODEL WILL ANSWER AT ALL, SAID ONCE, FOR THE LOG AND FOR THE SCREEN.
 *
 * The queue route used to be the only thing that knew: it logged a line per delivery and the
 * screens said nothing, so a deployment whose model was unreachable looked perfectly healthy to
 * the coordinator reading a family's thread. Vera's review (2026-10-17): say it plainly on the
 * screen, not only in a server log.
 *
 * So the route and the panel read the same function, which is the point of it being here rather
 * than in the panel: a log line and a sentence on screen that could disagree would be worse than
 * either alone. **Two** answers, because after the founder's rule of 2026-10-17 there are only
 * two things that can be true:
 *
 *  - `model` — a vendor this deployment may call, named by its model id, which is what a reviewer
 *    checks. (A model that is reachable but *fails* is not this: the adapter's chain ends in a
 *    refusal, the run raises the staff alert, and nothing answers the family.)
 *  - `unavailable` — no model will answer: no key, an unconfirmed demo-data deployment, a base URL
 *    off the host allow-list, or a config this build cannot parse. There is no third, degraded
 *    answer any more — the §18.1 keyword reader was deleted, so this is the case in which the
 *    assistant proposes nothing and the family's text goes in front of a person instead
 *    (`agent/staff-alert.ts`).
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
  | { readonly kind: "unavailable"; readonly reason: string };

export function modelReach(env: Record<string, string | undefined> = process.env): ModelReach {
  try {
    const config = loadAgentConfig(env);
    const choice = chooseProvider(config, env);
    if (choice.refused) return { kind: "unavailable", reason: choice.reason ?? "no live call allowed" };
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
