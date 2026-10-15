/**
 * The remote-vendor slot — typed placeholder only (B-08 slice 1).
 *
 * ADR-000 #4 and #12 say the agent is live on Claude Sonnet via OpenRouter with the founder's
 * key, and ARCHITECTURE §10 says the AWS move is "adapter swap + vendorAttestation config". Both
 * land in this file. Slice 1 deliberately ships no HTTP: there is no key on the box, no key in
 * CI, and nothing in this slice needs a network call to be proved. Keeping the slot typed means
 * the gateway, the allow-list, the audit record and the attestation check are all already written
 * against it, so the live adapter is a body for `invoke()` and nothing else.
 *
 * When it is filled: read the key by `config.apiKeyEnvVar` *here* and nowhere else, POST only to
 * `call.endpoint` (already checked against the allow-list by the gateway), send
 * `provider: { zdr: call.zdr }`, and map the vendor envelope onto ProviderResponseBody.
 */
import type { AgentConfig } from "../config";
import {
  type LlmProvider,
  type ProviderCall,
  type ProviderResponseBody,
  ProviderError,
} from "./provider";

export class RemoteProviderNotEnabled extends ProviderError {}

export interface RemoteProvider extends LlmProvider {
  readonly kind: "remote";
  /** Name of the env var that would carry the key. The value is never read in this slice. */
  readonly apiKeyEnvVar: string;
}

/**
 * Two gates, both closed in slice 1.
 *
 * The first is here, at wiring time: a deployment that selected the remote provider with no key
 * in the environment gets a clear refusal naming the variable it is missing, rather than a
 * provider object that looks usable and fails on the first family message. The key's *value* is
 * never read beyond "is it there" — the live adapter will read it, once there is one to read.
 *
 * The second is `invoke()`, which refuses whatever the environment holds: slice 1 ships no HTTP.
 */
export function remoteProvider(
  config: AgentConfig,
  env: Record<string, string | undefined> = process.env,
): RemoteProvider {
  const endpoint = config.endpointAllowList[0];
  if ((env[config.apiKeyEnvVar] ?? "").trim() === "") {
    throw new RemoteProviderNotEnabled(
      `remote provider ${config.provider} is not configured: $${config.apiKeyEnvVar} is not set in this environment`,
    );
  }
  return {
    kind: "remote",
    vendor: config.provider,
    endpoint,
    apiKeyEnvVar: config.apiKeyEnvVar,
    async invoke(_call: ProviderCall): Promise<ProviderResponseBody> {
      throw new RemoteProviderNotEnabled(
        `remote provider ${config.provider} is a placeholder in B-08 slice 1; ` +
          `use the fake or recorded provider (key would come from $${config.apiKeyEnvVar})`,
      );
    },
  };
}
