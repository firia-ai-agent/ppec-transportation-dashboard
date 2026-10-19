/**
 * WHETHER A MODEL WILL ANSWER, AND WHICH PROVIDER A RUN GETS — with nothing else attached.
 *
 * Split out of `run/deps.ts` (ledger #74) because screens ask `modelReach()` on render — Family
 * texts, the shell, the queue — and `deps.ts` also builds the executors, which now reach the action
 * layer (the plan writers, the demo seed). A page that only needs to know whether a model is there
 * must not carry those in its graph (identity-off-the-app-connection.test.ts, key-never-leaves.test.ts).
 */
import { loadAgentConfig, type AgentConfig } from "../config";
import type { LlmProvider } from "../providers/provider";
import { liveCallRefusalReason } from "../providers/remote";
import { liveProviderOrRefusal } from "./provider-choice";

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

