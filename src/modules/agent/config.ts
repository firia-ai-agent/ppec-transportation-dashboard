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
 * zdr:true".
 *
 * **B-08 slice 5 (founder, 2026-10-15).** The live agent runs on a *free* OpenRouter model on demo
 * data only, and moves to a HIPAA-compliant endpoint later (docs/research/QUEUES-AND-OPENROUTER-ZDR.md
 * §2.5A). Two things follow, and both are load-bearing:
 *
 *  1. **Model ids live here and nowhere else.** `MODEL_PRIMARY`/`MODEL_BACKUP` are the only model
 *     slugs in `src/`, and `no-hardcoded-models.test.ts` fails the build if a second one appears
 *     anywhere outside this module and its test. Every other module reads `config.model` /
 *     `config.backupModel`, so switching vendors is an env change and never a code change.
 *  2. **The demo-data guard is in this module too** (`demoDataOnly`), because the thing it has to
 *     be impossible to forget is a *config* property of the deployment, not a provider-level flag.
 *     None of the free endpoints offer ZDR and OpenRouter has no BAA, so this guard is the only
 *     thing keeping real family data away from them: it fails shut, and `remoteProvider` refuses
 *     before it builds a request body.
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

/* ───────────────────────────────── models (the only slugs in src/) ───────────────────────────────── */

/**
 * The live model, OK'd by the founder 2026-10-15: a free OpenRouter endpoint, for demo data only.
 * It is a *constant in this module* rather than a literal at a call site so that
 * `no-hardcoded-models.test.ts` can prove there is exactly one place to change it.
 */
export const MODEL_PRIMARY = "google/gemma-4-31b-it:free";

/** The backup, same decision. Tried when the primary rate-limits (429) or errors (providers/remote.ts). */
export const MODEL_BACKUP = "nvidia/nemotron-3-super-120b-a12b:free";

/**
 * Models this deployment may call. A model id that is not on this list is refused at config time,
 * so a typo or a paste from a changelog cannot become a vendor call. The later compliant endpoint
 * joins the list by env (`AGENT_MODEL_ALLOW_LIST`) when the BAA is signed, not by editing code.
 */
export const DEFAULT_MODEL_ALLOW_LIST = [MODEL_PRIMARY, MODEL_BACKUP] as const;

/**
 * Vendor origin. Here rather than in the adapter for the same reason as the model ids: one place
 * to repoint at the compliant endpoint, and `no-network.test.ts` can keep asserting that no other
 * file in the agent module carries a URL.
 */
export const DEFAULT_BASE_URL = "https://openrouter.ai";

/** Hard ceiling on one vendor call. A hung request must become a keyword fallback, not a hung run. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;

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
  /** Primary model id. Founder 2026-10-15: the free Gemma endpoint, demo data only (MODEL_PRIMARY). */
  model: z.string().min(1).default(MODEL_PRIMARY),
  /** Tried when the primary 429s or errors, before the keyword fallback (MODEL_BACKUP). */
  backupModel: z.string().min(1).default(MODEL_BACKUP),
  /** Model ids this deployment may call. `model` and `backupModel` must both be on it. */
  modelAllowList: z.array(z.string().min(1)).nonempty().default([...DEFAULT_MODEL_ALLOW_LIST]),
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
  /**
   * Demo-data-only guard, fail shut (§2.5A). `false` unless the deployment sets
   * `AGENT_DEMO_DATA_ONLY` to exactly `DEMO_DATA_ONLY_REQUIRED_VALUE`; a missing, empty, mistyped
   * or merely truthy-looking value ("1", "TRUE", "yes") leaves it `false` and no live model call
   * is possible. Default `false` is the whole point: forgetting the var cannot open the gate.
   */
  demoDataOnly: z.boolean().default(false),
  /** Vendor origin for the live adapter (DEFAULT_BASE_URL). */
  baseUrl: z.string().min(1).default(DEFAULT_BASE_URL),
  /** Per-call timeout in ms. Exceeding it is a provider error, which the fallback chain handles. */
  requestTimeoutMs: z.number().int().positive().default(DEFAULT_REQUEST_TIMEOUT_MS),
}).superRefine((c, ctx) => {
  // A model the deployment may not call is a config error, not a runtime surprise.
  for (const [field, value] of [["model", c.model], ["backupModel", c.backupModel]] as const) {
    if (!c.modelAllowList.includes(value)) {
      ctx.addIssue({
        code: "custom",
        path: [field],
        message: `model ${JSON.stringify(value)} is not on the configured model allow-list`,
      });
    }
  }
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

/* ──────────────────────────────── the demo-data-only guard ──────────────────────────────── */

/**
 * The guard's env var. Named for what it asserts about the *data*, not about the model — and
 * deliberately not `AGENT_DATA_MODE`, which already exists on this module with different
 * semantics (SYNTHETIC|PHI, the attestation switch). Two vars, two jobs: `AGENT_DATA_MODE` says
 * what the gateway must demand of the vendor, `AGENT_DEMO_DATA_ONLY` says the operator has
 * confirmed this deployment holds nothing but demo data and accepts a non-ZDR endpoint.
 */
export const DEMO_DATA_ONLY_ENV_VAR = "AGENT_DEMO_DATA_ONLY";

/**
 * The only accepted value. An exact match on a spelled-out word, because every looser rule —
 * truthiness, a case-insensitive compare, "any non-empty value" — turns a stray character or a
 * leftover `AGENT_DEMO_DATA_ONLY=0` into permission to call a vendor that logs prompts.
 */
export const DEMO_DATA_ONLY_REQUIRED_VALUE = "true";

/**
 * Fail-shut read of the guard: `true` only for an exact match, `false` for missing, empty,
 * differently-cased, padded or any other value. The one place the comparison is made.
 */
export function demoDataOnlyFromEnv(env: Record<string, string | undefined>): boolean {
  return env[DEMO_DATA_ONLY_ENV_VAR] === DEMO_DATA_ONLY_REQUIRED_VALUE;
}

/** Env var names this module reads. Listed so a deployment review can see the whole surface. */
export const AGENT_ENV_VARS = [
  "AGENT_PROVIDER",
  "AGENT_MODEL",
  "AGENT_BACKUP_MODEL",
  "AGENT_MODEL_ALLOW_LIST",
  "AGENT_MODEL_ZDR",
  "AGENT_DATA_MODE",
  DEMO_DATA_ONLY_ENV_VAR,
  "AGENT_ENDPOINT_ALLOW_LIST",
  "AGENT_BASE_URL",
  "AGENT_REQUEST_TIMEOUT_MS",
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
    backupModel: env.AGENT_BACKUP_MODEL,
    modelAllowList: asList(env.AGENT_MODEL_ALLOW_LIST),
    zdr: env.AGENT_MODEL_ZDR === undefined ? undefined : env.AGENT_MODEL_ZDR !== "0",
    dataMode: env.AGENT_DATA_MODE as DataMode | undefined,
    // Always read, never defaulted from anything but a missing var: see demoDataOnlyFromEnv.
    demoDataOnly: demoDataOnlyFromEnv(env),
    endpointAllowList: asList(env.AGENT_ENDPOINT_ALLOW_LIST),
    baseUrl: env.AGENT_BASE_URL,
    requestTimeoutMs: asInt(env.AGENT_REQUEST_TIMEOUT_MS),
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
