/**
 * Choosing the provider a run is driven with — and, when this deployment cannot have one, making
 * that refusal something the **run loop** sees rather than something that escapes it.
 *
 * ## The problem this exists to fix
 *
 * `remoteProvider(config, env)` refuses at *wiring* time, on purpose and documented as such: a
 * deployment that has not confirmed demo-data-only operation, or has no key, gets a classed throw
 * "rather than a provider object that looks usable and fails on the first family message". That is
 * the right shape for the adapter, and it has one consequence nobody had followed through: the
 * throw happens **before a gateway exists**, so there is no model turn, so the run loop's
 * `catch` never runs, so the founder's 2026-10-17 rule — *"the owner/staff need to be notified"* —
 * is not applied. The parent's text is sitting in `ops.message` and nothing tells anybody.
 *
 * This is not hypothetical. The deployed project has `OPENROUTER_API_KEY` and `APP_DATA_CLASS`
 * but **no `AGENT_DEMO_DATA_ONLY`** on preview or on production (checked by env var *name* only),
 * so the guard's first condition refuses every live call — the likeliest cause of "the assistant
 * couldn't reach its model" on the preview.
 *
 * ## The fix, in one sentence
 *
 * A refusal becomes a provider that **refuses when asked for a turn**, instead of a provider that
 * could not be built.
 *
 * Nothing about the guard is weakened and no env var is set: `liveCallRefusal` runs exactly as it
 * did, the same classed error is raised, and `fetch` is never reached. What changes is only
 * *where* it surfaces — inside `invoke()`, so the gateway wraps it as `PROVIDER_ERROR` with the
 * cause attached, the run loop classifies it (`staff-alert.modelUnavailable`), and the family's
 * text ends up in front of a director or a coordinator. The run still fails; nothing is proposed,
 * no leg moves and nothing is sent.
 *
 * It is also consistent with how the adapter already behaves: `remote.ts` re-checks
 * `liveCallRefusal` **per call**, not just at wiring, precisely because "config is a value a
 * caller can rebuild". A provider that refuses on `invoke` is the shape that path already has.
 *
 * ## What it is not
 *
 * Not a retry, not a degraded mode and not a stand-in answer. `invoke()` throws, every time, with
 * the original error. There is no second code path in which a run without a usable vendor does
 * anything other than raise one alert and stop.
 */
import type { AgentConfig } from "../config";
import { type LlmProvider, ProviderError } from "../providers/provider";
import { type RemoteProvider, remoteProvider } from "../providers/remote";

/**
 * The live provider, or one that raises this deployment's refusal when asked for a turn.
 *
 * Only `ProviderError` is converted. Anything else — a bug in config parsing, say — propagates,
 * because "this deployment may not call a vendor" and "this code is broken" are different facts
 * and the second one must not be dressed up as a staff alert.
 */
export function liveProviderOrRefusal(
  config: AgentConfig,
  env: Record<string, string | undefined> = process.env,
): LlmProvider {
  try {
    return remoteProvider(config, env);
  } catch (e) {
    if (e instanceof ProviderError) return refusingProvider(config, e);
    throw e;
  }
}

/**
 * A provider that answers every turn with one classed refusal.
 *
 * `kind: "remote"` and `vendor: config.provider` are the honest values, not a disguise: the vendor
 * we failed to reach *is* the configured one, the audit row should say so, and the gateway
 * requires the vendor to match `config.provider` or attestation would be a lie. `attempts` is
 * empty and stays empty — there was no attempt, which is the difference between this and an
 * exhausted model chain.
 */
export function refusingProvider(config: AgentConfig, refusal: ProviderError): RemoteProvider {
  return {
    kind: "remote",
    vendor: config.provider,
    endpoint: config.endpointAllowList[0],
    apiKeyEnvVar: config.apiKeyEnvVar,
    attempts: [],
    async invoke() {
      throw refusal;
    },
  };
}
