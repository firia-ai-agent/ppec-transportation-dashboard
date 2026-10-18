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
 *  2. **The demo-data guard is in this module too** (`demoDataGuardRefusal`), because the thing it
 *     has to be impossible to forget is a *config* property of the deployment, not a provider-level
 *     flag. None of the free endpoints offer ZDR and OpenRouter has no BAA, so this guard is the
 *     only thing keeping real family data away from them: it fails shut, and `remoteProvider`
 *     refuses before it builds a request body. It is three conditions and not one, because any of
 *     the three being wrong means the data is not what the operator confirmed it was:
 *     `AGENT_DEMO_DATA_ONLY=true`, **and** the ADR-015 boot class `APP_DATA_CLASS=SYNTHETIC`,
 *     **and** this module's own `dataMode=SYNTHETIC`. `loadAgentConfig` refuses an *override* of
 *     the flag for the same reason: a fail-shut default that any caller holding the config could
 *     set to `true` is not a guard.
 *  3. **The destination is allow-listed, not merely configured.** `baseUrl` must be `https` and its
 *     host must be on `baseUrlHostAllowList`, checked at config time *and* again on the outbound
 *     path before a `Bearer` header exists — the base URL is the one knob that decides where the
 *     founder's key is sent, so an off-list host or a plain-http origin is a refusal, never a
 *     credential handed to a host nobody vetted.
 *  4. **The base URL is only half of the destination.** An endpoint is joined onto it, so the host
 *     that finally receives the key is a product of both: `"https://openrouter.ai"` plus the
 *     endpoint `"@evil.example/…"` *is* a request to `evil.example` with `openrouter.ai` as a
 *     username, and `"//evil.example/…"` or `"/\evil.example/…"` get there too. Three things
 *     follow, and all three are in this module: an endpoint must be a plain absolute path
 *     (`endpointPathRefusalReason`, enforced on every allow-list entry at parse time), the URL is
 *     built with the URL parser and never by string concatenation (`vendorRequestUrl`), and the
 *     scheme, userinfo and host are re-read off the **finished** URL
 *     (`requestUrlRefusalReason`) — on the outbound path, immediately before the key is attached.
 *
 * The API key is referenced by *variable name* only (`apiKeyEnvVar`). This module never reads
 * its value, never requires it, and nothing here fails when it is absent — so boot, CI and
 * tests work with no key on the box, which is the only way the "founder supplies key" lock can
 * hold without a secret in the repo.
 */
import { z } from "zod";
import { DATA_CLASS_ENV_VAR, SYNTHETIC_DATA_CLASS, isSyntheticDemo } from "@/lib/env";

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
 * One path segment of an endpoint: RFC 3986 unreserved characters (`A-Z a-z 0-9 - . _ ~`), at
 * least one of them. An allow-list, not a deny-list, on purpose — a deny-list of the characters
 * that can carry a host has to be complete to be worth anything, and the list is longer than it
 * looks: `@` (userinfo), `:` (a scheme, or a port), `\` (which the URL parser folds to `/`), `%`
 * (an escape the parser decodes), `?` and `#` (which cut the path short).
 */
const ENDPOINT_SEGMENT = /^[A-Za-z0-9._~-]+$/;

/**
 * Why this endpoint is not a plain path, or null when it is one.
 *
 * The endpoint is the *second* half of the destination: it is joined onto `baseUrl`, so a value
 * that can name a host moves the request off the allow-listed origin even though nothing about
 * `baseUrl` changed. Three shapes do it, and none of them looks like a host at a glance:
 *
 *  - `@evil.example/…` — joined onto `https://openrouter.ai` it reads as userinfo plus a host, so
 *    the allow-listed origin becomes a *username* sent to `evil.example`.
 *  - `//evil.example/…` — scheme-relative: the parser replaces the whole authority.
 *  - `/\evil.example/…` — begins with a slash, and the URL parser folds `\` to `/` for http(s),
 *    which makes it the case above. A "must start with /" check passes it.
 *
 * So the rule is positive and narrow: an absolute path, then non-empty unreserved segments, and
 * nothing else. `.` and `..` are refused with them — they are not a credential leak, but an
 * endpoint that walks the path is not an endpoint this deployment configured either.
 *
 * Messages name the rule and never echo the value: this text ends up in a thrown error, and the
 * caller that has the endpoint is the one that already knows it.
 */
export function endpointPathRefusalReason(endpoint: string): string | null {
  if (endpoint.startsWith("//")) {
    return "endpoint begins with //, which a URL parser reads as a host and not as a path";
  }
  if (!endpoint.startsWith("/")) {
    return "endpoint is not a plain absolute path beginning with /";
  }
  for (const segment of endpoint.slice(1).split("/")) {
    if (segment === "") return "endpoint has an empty path segment";
    if (segment === "." || segment === "..") return "endpoint has a relative path segment";
    if (!ENDPOINT_SEGMENT.test(segment)) {
      return "endpoint has a path segment outside A-Z a-z 0-9 - . _ ~, which could carry a host";
    }
  }
  return null;
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

/**
 * The hosts this deployment may open a vendor connection to — and therefore the only hosts the
 * founder's key can reach. `AGENT_BASE_URL` is checked against this list, so repointing at the
 * compliant endpoint moves two env vars together (`AGENT_BASE_URL` and
 * `AGENT_BASE_URL_HOST_ALLOW_LIST`) exactly as switching models moves `AGENT_MODEL` with
 * `AGENT_MODEL_ALLOW_LIST`. A single var would mean any value that parsed as a URL became a place
 * to send a Bearer token.
 *
 * An entry is a *host*, so a port is part of it: `vendor.example:8443` does not match
 * `vendor.example` and has to be allow-listed on its own.
 */
export const DEFAULT_BASE_URL_HOST_ALLOW_LIST = ["openrouter.ai"] as const;

/**
 * The only scheme a vendor call may use, in `URL.protocol` form (trailing colon) so the comparison
 * is against a parsed URL and not a prefix match on a string. Plain http would put the key and the
 * prompt on the wire in clear, and a redirect from it is no mitigation — the first request has
 * already been sent.
 *
 * The colon also keeps this off `no-network.test.ts`'s "a node network module" pattern, which bans
 * a bare `"https"` literal in every file in the module, this one included: the exemption config.ts
 * holds is for an absolute URL and nothing else.
 */
export const REQUIRED_BASE_URL_PROTOCOL = "https:";

/**
 * Why this base URL may not be called, or null when it may. Four refusals, in the order a bad
 * value is most likely to arrive: not a URL at all, not https, carrying credentials in its
 * userinfo (`https://user:pass@host` passes a host check while smuggling a credential through
 * config), or a host no deployment vetted.
 *
 * Messages name the scheme and the host and never the whole string: a URL can carry a secret in
 * its userinfo or its query, and this text ends up in a thrown error.
 */
export function baseUrlRefusalReason(
  baseUrl: string,
  hostAllowList: readonly string[],
): string | null {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return "base URL is not an absolute URL";
  }
  return destinationRefusalReason(parsed, hostAllowList, "base URL");
}

/**
 * The same three refusals, read off the URL a call is *actually about to be sent to*. The base URL
 * passing them is not the same claim: the endpoint is joined onto it, and the only way to know
 * where the key is going is to ask the finished URL. One implementation of the rule, applied to
 * both, so the two can never drift apart.
 */
export function requestUrlRefusalReason(
  url: URL,
  hostAllowList: readonly string[],
): string | null {
  return destinationRefusalReason(url, hostAllowList, "request URL");
}

/** The three facts a destination must have, whichever URL is being asked. `what` names it. */
function destinationRefusalReason(
  parsed: URL,
  hostAllowList: readonly string[],
  what: string,
): string | null {
  if (parsed.protocol !== REQUIRED_BASE_URL_PROTOCOL) {
    const required = REQUIRED_BASE_URL_PROTOCOL.replace(":", "");
    return `${what} scheme ${parsed.protocol.replace(":", "")} is refused: a vendor call must use ${required}`;
  }
  if (parsed.username !== "" || parsed.password !== "") {
    return `${what} carries credentials in its userinfo, which no vendor call may do`;
  }
  if (!hostAllowList.includes(parsed.host)) {
    return `${what} host ${parsed.host} is not on the configured host allow-list`;
  }
  return null;
}

/** A built vendor URL, or the reason there is none. One of the two fields is always null. */
export type VendorRequestUrl =
  | { readonly url: string; readonly refusal: null }
  | { readonly url: null; readonly refusal: string };

/**
 * The absolute URL for one vendor call: built with the URL parser from `baseUrl` and an endpoint,
 * then re-checked with `requestUrlRefusalReason`.
 *
 * Built and not concatenated. `` `${baseUrl}${endpoint}` `` produces a *string* that nobody has
 * looked at, and the shapes in `endpointPathRefusalReason` are exactly the ones that make such a
 * string point somewhere else — so this takes the two pieces, resolves them the way the request
 * will be resolved, and then asks the result where it is going. The deliberate order is: parse,
 * **then** check, because a check on either half proves nothing about the join.
 *
 * It does *not* re-run `endpointPathRefusalReason`: that gate is the caller's, and keeping the two
 * separate is what makes this one a real backstop rather than a second opinion from the same
 * check. Either one alone refuses every host-moving endpoint; both are in the path.
 */
export function vendorRequestUrl(
  config: Pick<AgentConfig, "baseUrl" | "baseUrlHostAllowList">,
  endpoint: string,
): VendorRequestUrl {
  let built: URL;
  try {
    const base = new URL(config.baseUrl);
    // The base URL's own path stays a prefix: resolving the endpoint against the origin alone
    // would discard it, which would silently repoint a deployment whose vendor lives under a path.
    built = new URL(`${base.pathname.replace(/\/$/, "")}${endpoint}`, base);
  } catch {
    return { url: null, refusal: "base URL is not an absolute URL" };
  }
  const refusal = requestUrlRefusalReason(built, config.baseUrlHostAllowList);
  return refusal === null ? { url: built.href, refusal: null } : { url: null, refusal };
}

/** Hard ceiling on one vendor call. A hung request must become a staff alert, not a hung run. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;

/**
 * Hard ceiling on a whole staff ask, driven inside the ask's own request (`ask/staff-ask.ts`). Two
 * or three model turns on a free endpoint, and well under the route's 60 s `maxDuration`: an ask
 * that runs out is a staff alert with reason TIMEOUT, never a 504.
 */
export const DEFAULT_ASK_TIMEOUT_MS = 45_000;

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
  })
  // Refused here as well as on the outbound path, for the reason every other destination rule is:
  // no deployment may boot into a shape where an allow-list entry is the thing that chooses the
  // host. An entry is a path on the configured origin, and never a way to name another one.
  .refine((list) => list.every((e) => endpointPathRefusalReason(e) === null), {
    message:
      "endpoint allow-list entries must be plain absolute paths: anything that can carry a host " +
      "(@, a scheme, //, a backslash) would move the destination at call time",
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
  /** Tried when the primary 429s or errors. The last attempt there is (MODEL_BACKUP). */
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
   * The operator's demo-data confirmation, fail shut (§2.5A). `false` unless the deployment sets
   * `AGENT_DEMO_DATA_ONLY` to exactly `DEMO_DATA_ONLY_REQUIRED_VALUE`; a missing, empty, mistyped
   * or merely truthy-looking value ("1", "TRUE", "yes") leaves it `false` and no live model call
   * is possible. The schema default is `false` and that is the whole point: forgetting the var —
   * or parsing a config object that never mentions it — cannot open the gate.
   *
   * It is **necessary and not sufficient**. The guard that gates a live call is
   * `demoDataGuardRefusal`, which also requires `APP_DATA_CLASS=SYNTHETIC` and
   * `dataMode=SYNTHETIC`; and `loadAgentConfig` refuses an *override* of this field, so the only
   * way it becomes `true` is the environment saying so.
   */
  demoDataOnly: z.boolean().default(false),
  /** Vendor origin for the live adapter (DEFAULT_BASE_URL). https, and on the host allow-list. */
  baseUrl: z.string().min(1).default(DEFAULT_BASE_URL),
  /** Hosts `baseUrl` may name (DEFAULT_BASE_URL_HOST_ALLOW_LIST). A port is part of the host. */
  baseUrlHostAllowList: z
    .array(z.string().min(1))
    .nonempty()
    .default([...DEFAULT_BASE_URL_HOST_ALLOW_LIST]),
  /** Per-call timeout in ms. Exceeding it is a provider error, which the fallback chain handles. */
  requestTimeoutMs: z.number().int().positive().default(DEFAULT_REQUEST_TIMEOUT_MS),
  /** Whole-ask deadline in ms (DEFAULT_ASK_TIMEOUT_MS). */
  askTimeoutMs: z.number().int().positive().default(DEFAULT_ASK_TIMEOUT_MS),
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
  // And neither is a destination the deployment may not reach. Refused here rather than at call
  // time so no deployment can boot into a shape where the key has somewhere unvetted to go.
  const badBaseUrl = baseUrlRefusalReason(c.baseUrl, c.baseUrlHostAllowList);
  if (badBaseUrl) ctx.addIssue({ code: "custom", path: ["baseUrl"], message: badBaseUrl });
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

/** The env var holding this module's data mode. Named so a refusal can cite it without a literal. */
export const DATA_MODE_ENV_VAR = "AGENT_DATA_MODE";

/**
 * Which of the guard's three conditions failed, as a **stable code**.
 *
 * The codes exist because a caller has to be able to say *which* condition refused without
 * reading the prose message below — a log line, a reason string on a failed run, and the staff
 * alert the founder's 2026-10-17 rule requires all need that fact, and string-matching a sentence
 * is how that goes wrong on the first rewording. One code per condition, in the order they are
 * checked.
 */
export type DemoDataGuardCode =
  | "DEMO_DATA_ONLY_UNCONFIRMED"
  | "DATA_CLASS_NOT_SYNTHETIC"
  | "DATA_MODE_NOT_SYNTHETIC";

/**
 * One guard refusal: the code, the env var **name** behind it, and the prose.
 *
 * `envVar` is a name and never a value — it is what a deployment review reads, and it is the only
 * part of this that is safe in a log line. The value of any of these three vars is a deployment
 * setting; two of the three are not secret, but the rule is simpler and safer as "names only",
 * because `apiKeyEnvVar` sits on the same refusal path and its value never may be logged.
 */
export type DemoDataGuardFailure = {
  readonly code: DemoDataGuardCode;
  readonly envVar: string;
  readonly message: string;
};

/** Why the guard fails shut, appended to every refusal below so no message states only half of it. */
const WHY_IT_FAILS_SHUT =
  "the configured endpoint offers no zero-data-retention guarantee and the vendor has no BAA, " +
  "so this guard fails shut";

/**
 * The demo-data guard: why a live model call is refused in this deployment, or null when all
 * **three** conditions hold. One lowercase clause per fact, the house style for every other
 * refusal in this module — and the reason `src/ui/copy.test.ts` does not read it as user-facing
 * copy. A staff-readable sentence, if this ever needs one, belongs in `ui/copy.ts`.
 *
 * Why three and not one. `AGENT_DEMO_DATA_ONLY` is an operator's *assertion* about the data, and
 * an assertion can be stale or simply wrong — a var set once on a demo project and inherited by a
 * clone that later holds real rows is exactly how one goes bad quietly. So the two facts the
 * deployment can state about itself have to agree with it:
 *
 *  - `APP_DATA_CLASS=SYNTHETIC` — the ADR-015 boot class, the same one `assertBootEnv` refuses to
 *    start without. If this deployment is not the synthetic one, nothing it holds is demo data,
 *    whatever `AGENT_DEMO_DATA_ONLY` says.
 *  - `dataMode=SYNTHETIC` — this module's own mode. PHI mode is the one that demands a
 *    `vendorAttestation` of the vendor (gateway.ts), and a vendor with no BAA cannot produce one;
 *    a deployment in PHI mode calling a free endpoint is the contradiction this refuses.
 *
 * The order is the design: the operator's missing confirmation is named first, because it is the
 * one a deployment is most likely to have simply forgotten.
 */
export function demoDataGuardFailure(
  config: Pick<AgentConfig, "demoDataOnly" | "dataMode">,
  env: Record<string, string | undefined>,
): DemoDataGuardFailure | null {
  if (!config.demoDataOnly) {
    return {
      code: "DEMO_DATA_ONLY_UNCONFIRMED",
      envVar: DEMO_DATA_ONLY_ENV_VAR,
      message:
        `live model calls are refused: this deployment has not confirmed demo-data-only operation; ` +
        `set $${DEMO_DATA_ONLY_ENV_VAR} to exactly "${DEMO_DATA_ONLY_REQUIRED_VALUE}"; ${WHY_IT_FAILS_SHUT}`,
    };
  }
  if (!isSyntheticDemo(env)) {
    return {
      code: "DATA_CLASS_NOT_SYNTHETIC",
      envVar: DATA_CLASS_ENV_VAR,
      message:
        `live model calls are refused: $${DATA_CLASS_ENV_VAR} is not ${SYNTHETIC_DATA_CLASS}, so this ` +
        `deployment may hold real family data whatever $${DEMO_DATA_ONLY_ENV_VAR} asserts; ${WHY_IT_FAILS_SHUT}`,
    };
  }
  if (config.dataMode !== "SYNTHETIC") {
    return {
      code: "DATA_MODE_NOT_SYNTHETIC",
      envVar: DATA_MODE_ENV_VAR,
      message:
        `live model calls are refused: the configured agent data mode is ${config.dataMode}, not ` +
        `SYNTHETIC, and a vendor with no BAA cannot produce the attestation that mode requires; ` +
        `${WHY_IT_FAILS_SHUT}`,
    };
  }
  return null;
}

/**
 * The guard's refusal as prose, or null. Thin over {@link demoDataGuardFailure} so the message and
 * the code cannot describe different conditions — every existing caller keeps this signature.
 */
export function demoDataGuardRefusal(
  config: Pick<AgentConfig, "demoDataOnly" | "dataMode">,
  env: Record<string, string | undefined>,
): string | null {
  return demoDataGuardFailure(config, env)?.message ?? null;
}

/**
 * Env var names this module reads. Listed so a deployment review can see the whole surface.
 * `APP_DATA_CLASS` is on it because the demo-data guard reads it (demoDataGuardRefusal) even though
 * it is the boot guard's var and src/lib/env.ts owns its name.
 */
export const AGENT_ENV_VARS = [
  "AGENT_PROVIDER",
  "AGENT_MODEL",
  "AGENT_BACKUP_MODEL",
  "AGENT_MODEL_ALLOW_LIST",
  "AGENT_MODEL_ZDR",
  "AGENT_DATA_MODE",
  DEMO_DATA_ONLY_ENV_VAR,
  DATA_CLASS_ENV_VAR,
  "AGENT_ENDPOINT_ALLOW_LIST",
  "AGENT_BASE_URL",
  "AGENT_BASE_URL_HOST_ALLOW_LIST",
  "AGENT_REQUEST_TIMEOUT_MS",
  "AGENT_ASK_TIMEOUT_MS",
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
 *
 * `demoDataOnly` is the **one** knob an override may not set, and it throws rather than being
 * quietly ignored (see below): a deployment confirms demo data in its environment or not at all.
 */
export function loadAgentConfig(
  env: Record<string, string | undefined> = process.env,
  overrides: Partial<z.input<typeof agentConfigSchema>> = {},
): AgentConfig {
  // The guard comes from the environment and from nowhere else. An override may set every other
  // knob — that is what the Bedrock swap and the suites use it for — but a fail-shut default that
  // any caller holding a config could flip to `true` would not be a guard at all, and "pass
  // demoDataOnly" is the shortest way for a test helper to become a production bypass. Loud, not
  // silent, so a caller that believed the override worked finds out here.
  if (overrides.demoDataOnly !== undefined) {
    throw new AgentConfigError(
      `Invalid agent config [demoDataOnly: may not be set by an override; it is read only from ` +
        `$${DEMO_DATA_ONLY_ENV_VAR}]`,
    );
  }
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
    baseUrlHostAllowList: asList(env.AGENT_BASE_URL_HOST_ALLOW_LIST),
    requestTimeoutMs: asInt(env.AGENT_REQUEST_TIMEOUT_MS),
    askTimeoutMs: asInt(env.AGENT_ASK_TIMEOUT_MS),
    apiKeyEnvVar: env.AGENT_API_KEY_ENV_VAR,
    rateLimits: {
      maxCallsPerRun: asInt(env.AGENT_MAX_CALLS_PER_RUN),
      maxCallsPerMinute: asInt(env.AGENT_MAX_CALLS_PER_MINUTE),
      maxPromptChars: asInt(env.AGENT_MAX_PROMPT_CHARS),
    },
  };
  // undefined keys must not shadow a default, and must not shadow an override either.
  const merged = { ...prune(fromEnv), ...prune(overrides) };
  // Re-asserted after the merge, not merely checked before it: the env read is the only source
  // this value may ever have, whatever shape a caller passed.
  merged.demoDataOnly = demoDataOnlyFromEnv(env);
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
