/**
 * The agent seam's single config module (PRD §11.2 "LLM gateway contract", l.993).
 *
 * Everything the gateway and the policy engine need to know about the vendor lives here and
 * nowhere else: provider name, model id, endpoint allow-list, data mode, rate limits. Logic
 * modules read this object; they never carry a literal of their own. Follows the
 * src/lib/env.ts pattern — one zod schema, parse-or-throw, secrets by name only.
 *
 * Defaults come from ADR-000 founder locks #4 and #12: "Agent is live (Claude via OpenRouter,
 * founder supplies key); synthetic data only" and "model Claude Sonnet (current) via OpenRouter,
 * zdr:true". The model id is a placeholder slug on purpose — slice 1 ships no remote provider.
 *
 * The API key is referenced by *variable name* only (`apiKeyEnvVar`). This module never reads
 * its value, never requires it, and nothing here fails when it is absent — so boot, CI and
 * tests work with no key on the box, which is the only way the "founder supplies key" lock can
 * hold without a secret in the repo.
 */
import { z } from "zod";

export const DATA_MODES = ["SYNTHETIC", "PHI"] as const;
/**
 * SYNTHETIC is the P1 world (ADR-015, ADR-000 #4). PHI is the mode that turns on the
 * vendorAttestation requirement in the gateway; no P1 deployment may select it, but the contract
 * has to exist now so the AWS/Bedrock swap (ARCHITECTURE §10) is a config change.
 */
export type DataMode = (typeof DATA_MODES)[number];

/**
 * Endpoint families PRD §11.2 excludes from the allow-list: "endpoint allow-list excludes
 * Batch/Files/Code-Exec/Web-Fetch". They are refused at *config* time, so no deployment can be
 * configured into a shape the gateway would then have to defend against at call time.
 */
const FORBIDDEN_ENDPOINT_PATTERNS: readonly RegExp[] = [
  /batch/i,
  /\bfiles?\b|\/files?(?:\/|$)/i,
  /code[-_ ]?(?:exec|execution|interpreter)/i,
  /web[-_ ]?(?:fetch|search|browse)/i,
  /upload/i,
  /fine[-_ ]?tun/i,
];

/** Why this endpoint may not be allow-listed, or null when it is acceptable. */
export function forbiddenEndpointReason(endpoint: string): string | null {
  const hit = FORBIDDEN_ENDPOINT_PATTERNS.find((re) => re.test(endpoint));
  return hit ? `endpoint matches excluded family ${String(hit)}` : null;
}

/**
 * The one endpoint the agent needs: a single synchronous completion with tools. Anything that
 * can hold data at the vendor (batch, files) or reach outward from it (code exec, web fetch) is
 * not on this list and cannot be added (FORBIDDEN_ENDPOINT_PATTERNS).
 */
export const DEFAULT_ENDPOINT_ALLOW_LIST = ["/api/v1/chat/completions"] as const;

const endpointAllowList = z
  .array(z.string().min(1))
  .nonempty()
  .refine((list) => list.every((e) => forbiddenEndpointReason(e) === null), {
    message: "endpoint allow-list may not contain Batch/Files/Code-Exec/Web-Fetch endpoints (PRD §11.2)",
  });

/**
 * Rate-limit defaults.
 *  - `maxCallsPerRun` bounds a loop a prompt injection could try to drive;
 *  - `maxCallsPerMinute` bounds vendor spend (ADR-000 #11: $100/month alert across Vercel, Neon,
 *    OpenRouter);
 *  - `maxPromptChars` refuses an oversized prompt before it reaches a provider.
 */
export const DEFAULT_RATE_LIMITS = {
  maxCallsPerRun: 8,
  maxCallsPerMinute: 30,
  maxPromptChars: 24_000,
} as const;

const rateLimits = z.object({
  maxCallsPerRun: z.number().int().positive().default(DEFAULT_RATE_LIMITS.maxCallsPerRun),
  maxCallsPerMinute: z.number().int().positive().default(DEFAULT_RATE_LIMITS.maxCallsPerMinute),
  maxPromptChars: z.number().int().positive().default(DEFAULT_RATE_LIMITS.maxPromptChars),
});

export const agentConfigSchema = z.object({
  /** Vendor name, for vendorAttestation and the audit record. ADR-000 #4/#12: OpenRouter. */
  provider: z.string().min(1).default("openrouter"),
  /** ADR-000 #12 "Claude Sonnet (current) via OpenRouter" — placeholder slug until a real call exists. */
  model: z.string().min(1).default("anthropic/claude-sonnet"),
  /** ADR-000 #12 zdr:true. The gateway stamps it on every provider call. */
  zdr: z.boolean().default(true),
  dataMode: z.enum(DATA_MODES).default("SYNTHETIC"),
  endpointAllowList: endpointAllowList.default([...DEFAULT_ENDPOINT_ALLOW_LIST]),
  /**
   * NAME of the env var that would hold the vendor key. Never the key, never read here: the
   * founder supplies it to the deployment and only a remote provider would ever look it up.
   */
  apiKeyEnvVar: z.string().min(1).default("OPENROUTER_API_KEY"),
  rateLimits: rateLimits.default(DEFAULT_RATE_LIMITS),
});

export type AgentConfig = z.infer<typeof agentConfigSchema>;

export class AgentConfigError extends Error {}

/**
 * vendorAttestation (PRD §11.2): "required in PHI mode". Every field is mandatory and
 * non-empty — a BAA with a blank version or an unrecorded retention confirmation is not an
 * attestation, so an empty string must fail exactly like a missing one.
 */
export const vendorAttestationSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  region: z.string().min(1),
  baa_version: z.string().min(1),
  retention_confirmation_id: z.string().min(1),
});

export type VendorAttestation = z.infer<typeof vendorAttestationSchema>;

/** Env var names this module reads. Listed so a deployment review can see the whole surface. */
export const AGENT_ENV_VARS = [
  "AGENT_PROVIDER",
  "AGENT_MODEL",
  "AGENT_MODEL_ZDR",
  "AGENT_DATA_MODE",
  "AGENT_ENDPOINT_ALLOW_LIST",
  "AGENT_API_KEY_ENV_VAR",
  "AGENT_MAX_CALLS_PER_RUN",
  "AGENT_MAX_CALLS_PER_MINUTE",
  "AGENT_MAX_PROMPT_CHARS",
] as const;

const asInt = (v: string | undefined): number | undefined => (v === undefined || v === "" ? undefined : Number(v));
const asList = (v: string | undefined): string[] | undefined =>
  v === undefined || v.trim() === "" ? undefined : v.split(",").map((s) => s.trim()).filter(Boolean);

/**
 * Config for this deployment. Every knob is optional with an ADR-000 default, so an environment
 * with none of these set — CI, a test, a fresh clone — gets the founder-locked shape and boots.
 * `overrides` is for tests and for the AWS adapter, which will pass its own region/endpoint.
 */
export function loadAgentConfig(
  env: Record<string, string | undefined> = process.env,
  overrides: Partial<z.input<typeof agentConfigSchema>> = {},
): AgentConfig {
  const fromEnv: z.input<typeof agentConfigSchema> = {
    provider: env.AGENT_PROVIDER,
    model: env.AGENT_MODEL,
    zdr: env.AGENT_MODEL_ZDR === undefined ? undefined : env.AGENT_MODEL_ZDR !== "0",
    dataMode: env.AGENT_DATA_MODE as DataMode | undefined,
    endpointAllowList: asList(env.AGENT_ENDPOINT_ALLOW_LIST),
    apiKeyEnvVar: env.AGENT_API_KEY_ENV_VAR,
    rateLimits: {
      maxCallsPerRun: asInt(env.AGENT_MAX_CALLS_PER_RUN),
      maxCallsPerMinute: asInt(env.AGENT_MAX_CALLS_PER_MINUTE),
      maxPromptChars: asInt(env.AGENT_MAX_PROMPT_CHARS),
    },
  };
  // undefined keys must not shadow a default, and must not shadow an override either.
  const merged = { ...prune(fromEnv), ...prune(overrides) };
  if (fromEnv.rateLimits || overrides.rateLimits) {
    merged.rateLimits = { ...prune(fromEnv.rateLimits ?? {}), ...prune(overrides.rateLimits ?? {}) };
  }
  const parsed = agentConfigSchema.safeParse(merged);
  if (!parsed.success) {
    // Names and messages only. Values may name an env var but never carry a secret.
    const detail = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    throw new AgentConfigError(`Invalid agent config [${detail}]`);
  }
  return parsed.data;
}

function prune<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}
