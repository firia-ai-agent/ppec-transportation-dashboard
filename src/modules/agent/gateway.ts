/**
 * The LLM gateway (PRD §11.2 "LLM gateway contract", l.993) — the only way agent code reaches a
 * model, and the place every rule in that sentence is enforced:
 *
 *   redact(); validatePromptTokensOnly() (fails closed on E.164, address patterns, untokenized
 *   names; logs hash only); JSON-schema tool calls only; vendorAttestation{provider, model,
 *   region, baa_version, retention_confirmation_id} required in PHI mode; endpoint allow-list
 *   excludes Batch/Files/Code-Exec/Web-Fetch; per-call audit of hashes only.
 *
 * Nothing above is optional or configurable away. The provider is a transport (providers/*), the
 * policy engine is what happens to an accepted tool call afterwards (policy.ts), and this module
 * is the choke point in between: a prompt that leaks never goes out, and a response that is not
 * exactly one schema-valid call to a catalog tool never comes back.
 *
 * It holds no prompt and no response text anywhere — not in the audit log, not in an error
 * message, not in a thrown stack. That is TEST-SEC-01 (PRD §18.3 l.1334).
 */
import {
  type AgentConfig,
  type DataMode,
  type VendorAttestation,
  forbiddenEndpointReason,
  loadAgentConfig,
  vendorAttestationSchema,
} from "./config";
import type { LlmProvider, ProviderResponseBody } from "./providers/provider";
import { PromptLeakError, redact, sha256Hex, validatePromptTokensOnly } from "./redact";
import { type ToolTier, TOOL_NAMES, toolDeclarations, toolDef } from "./tools";

/* ────────────────────────────────── audit (hashes only) ────────────────────────────────── */

export type GatewayOutcome =
  | "ACCEPTED"
  | "REJECTED_PROMPT_LEAK"
  | "REJECTED_PROMPT_TOO_LARGE"
  | "REJECTED_ENDPOINT"
  | "REJECTED_ATTESTATION"
  | "REJECTED_RATE_LIMIT"
  | "REJECTED_UNKNOWN_TOOL"
  | "REJECTED_FREE_TEXT"
  | "REJECTED_MULTIPLE_CALLS"
  | "REJECTED_INVALID_ARGS"
  | "PROVIDER_ERROR";

/**
 * One row per attempted call. Hashes, identifiers, codes and counts — by construction there is
 * no field here that could carry prompt or response text, which is why `gateway.test.ts` can
 * assert the whole serialized log contains no fixture name.
 */
export type AgentAuditRecord = {
  readonly at: string;
  readonly runId: string;
  readonly provider: string;
  readonly providerKind: string;
  readonly model: string;
  readonly endpoint: string;
  readonly zdr: boolean;
  readonly dataMode: DataMode;
  readonly promptHash: string;
  readonly promptChars: number;
  readonly responseHash: string | null;
  readonly tool: string | null;
  readonly tier: ToolTier | null;
  readonly outcome: GatewayOutcome;
  /** retention_confirmation_id from the attestation (an audit identifier, not a secret). */
  readonly retentionConfirmationId: string | null;
};

export type AuditSink = (record: AgentAuditRecord) => void;

/* ────────────────────────────────── requests and results ────────────────────────────────── */

export type GatewayRequest = {
  /** Agent run id (§11.1 idempotency). Also the rate-limit bucket for maxCallsPerRun. */
  readonly runId: string;
  /** Fully assembled, already-tokenized prompt. Validated here before it goes anywhere. */
  readonly prompt: string;
  /** Tools offered for this turn. Defaults to the whole catalog; every name must be in it. */
  readonly tools?: readonly string[];
  /** Required when `dataMode` is PHI (§11.2). Ignored — but still validated — otherwise. */
  readonly vendorAttestation?: unknown;
  /** Overrides the provider's default endpoint; must be on the allow-list either way. */
  readonly endpoint?: string;
};

/** An accepted model turn: exactly one catalog tool call whose args passed its zod schema. */
export type AcceptedToolCall = {
  readonly tool: string;
  readonly tier: ToolTier;
  /** Parsed args — the zod output, not the raw JSON. */
  readonly args: Record<string, unknown>;
};

export type GatewayResult = {
  readonly call: AcceptedToolCall;
  readonly promptHash: string;
  readonly responseHash: string;
  readonly audit: AgentAuditRecord;
};

export class GatewayError extends Error {
  constructor(
    readonly outcome: GatewayOutcome,
    message: string,
    /**
     * The error underneath, on the one outcome that has one: `PROVIDER_ERROR` wraps whatever the
     * adapter threw. Carried because the *class* of a vendor failure is what the caller acts on —
     * a missing key, a 429 on every model, a timeout — and re-deriving it by reading this
     * message would be string-matching on a sentence (`agent/staff-alert.ts`). The message itself
     * stays what it was: reason classes and status codes, never the vendor's own text.
     */
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "GatewayError";
  }
}

/* ────────────────────────────────────── the interface ────────────────────────────────────── */

export interface LlmGateway {
  readonly config: AgentConfig;
  /** PRD §11.2 `redact()` — for text that is kept (staff notes, summaries), never to fix a prompt. */
  redact(text: string): string;
  /** PRD §11.2 `validatePromptTokensOnly()`. Returns the prompt hash; throws PromptLeakError. */
  validatePromptTokensOnly(prompt: string): string;
  /** One model turn. Resolves only with a schema-valid catalog tool call. */
  complete(request: GatewayRequest): Promise<GatewayResult>;
  /** Per-call audit records, newest last. Hashes only. */
  readonly auditLog: readonly AgentAuditRecord[];
}

export type GatewayOptions = {
  /** Injected clock, so the per-minute window and the audit timestamps are testable. */
  now?: () => number;
  /** Where audit rows go in a deployment (platform.audit_event). Defaults to memory only. */
  auditSink?: AuditSink;
};

/**
 * Build a gateway over a provider. `config` defaults to `loadAgentConfig()` so callers get the
 * ADR-000 shape without repeating it.
 */
export function createGateway(
  provider: LlmProvider,
  config: AgentConfig = loadAgentConfig(),
  options: GatewayOptions = {},
): LlmGateway {
  const now = options.now ?? Date.now;
  const auditLog: AgentAuditRecord[] = [];
  const callsPerRun = new Map<string, number>();
  /** Timestamps of accepted provider calls, for the rolling maxCallsPerMinute window. */
  const recentCalls: number[] = [];

  // A provider whose vendor is not the configured one would make vendorAttestation a lie.
  if (provider.vendor !== config.provider) {
    throw new GatewayError(
      "REJECTED_ENDPOINT",
      `provider vendor "${provider.vendor}" does not match configured provider "${config.provider}"`,
    );
  }

  function record(r: AgentAuditRecord): AgentAuditRecord {
    auditLog.push(r);
    options.auditSink?.(r);
    return r;
  }

  /** Audit a refusal and throw it. Every early return in complete() goes through here. */
  function reject(
    base: Omit<AgentAuditRecord, "outcome" | "responseHash" | "tool" | "tier">,
    outcome: GatewayOutcome,
    message: string,
    extra: Partial<Pick<AgentAuditRecord, "responseHash" | "tool">> & { cause?: unknown } = {},
  ): never {
    record({ ...base, outcome, responseHash: extra.responseHash ?? null, tool: extra.tool ?? null, tier: null });
    throw new GatewayError(outcome, message, { cause: extra.cause });
  }

  return {
    config,
    redact,
    validatePromptTokensOnly,
    auditLog,

    async complete(request: GatewayRequest): Promise<GatewayResult> {
      const endpoint = request.endpoint ?? provider.endpoint;
      const dataMode = config.dataMode;
      // The prompt hash is needed for the audit row even on the paths that refuse the prompt,
      // and it is the only representation of it that may be computed outside the guard.
      const promptHash = sha256Hex(request.prompt);
      const base = {
        at: new Date(now()).toISOString(),
        runId: request.runId,
        provider: config.provider,
        providerKind: provider.kind,
        model: config.model,
        endpoint,
        zdr: config.zdr,
        dataMode,
        promptHash,
        promptChars: request.prompt.length,
        retentionConfirmationId: null as string | null,
      };

      // 1. Endpoint allow-list (§11.2: excludes Batch/Files/Code-Exec/Web-Fetch). Checked against
      //    the configured list *and* re-checked against the excluded families, so an allow-list
      //    that somehow carried one could still not be called.
      if (!config.endpointAllowList.includes(endpoint)) {
        reject(base, "REJECTED_ENDPOINT", `endpoint ${endpoint} is not on the allow-list`);
      }
      const forbidden = forbiddenEndpointReason(endpoint);
      if (forbidden) reject(base, "REJECTED_ENDPOINT", `endpoint ${endpoint} refused: ${forbidden}`);

      // 2. vendorAttestation, required in PHI mode (§11.2). It must also *be about this call*:
      //    an attestation naming another provider or model attests nothing.
      let attestation: VendorAttestation | null = null;
      if (request.vendorAttestation !== undefined) {
        const parsed = vendorAttestationSchema.safeParse(request.vendorAttestation);
        if (!parsed.success) {
          reject(base, "REJECTED_ATTESTATION", `vendorAttestation invalid: ${parsed.error.issues.map((i) => i.path.join(".")).join(", ")}`);
        }
        attestation = parsed.data;
        if (attestation.provider !== config.provider || attestation.model !== config.model) {
          reject(base, "REJECTED_ATTESTATION", "vendorAttestation does not match the configured provider/model");
        }
      }
      if (dataMode === "PHI" && !attestation) {
        reject(base, "REJECTED_ATTESTATION", "data mode PHI requires vendorAttestation (PRD §11.2)");
      }
      const audited = { ...base, retentionConfirmationId: attestation?.retention_confirmation_id ?? null };

      // 3. Rate limits, from config (ADR-000 #11 spend alert; and a bound on an injected loop).
      if (request.prompt.length > config.rateLimits.maxPromptChars) {
        reject(audited, "REJECTED_PROMPT_TOO_LARGE", `prompt is ${request.prompt.length} chars, limit ${config.rateLimits.maxPromptChars}`);
      }
      const runCalls = callsPerRun.get(request.runId) ?? 0;
      if (runCalls >= config.rateLimits.maxCallsPerRun) {
        reject(audited, "REJECTED_RATE_LIMIT", `run ${request.runId} reached maxCallsPerRun=${config.rateLimits.maxCallsPerRun}`);
      }
      const t = now();
      while (recentCalls.length > 0 && t - recentCalls[0] >= 60_000) recentCalls.shift();
      if (recentCalls.length >= config.rateLimits.maxCallsPerMinute) {
        reject(audited, "REJECTED_RATE_LIMIT", `maxCallsPerMinute=${config.rateLimits.maxCallsPerMinute} exceeded`);
      }

      // 4. Tools offered must all be in the §11.2 catalog.
      const names = request.tools ?? TOOL_NAMES;
      const unknownOffer = names.find((n) => !toolDef(n));
      if (unknownOffer) {
        reject(audited, "REJECTED_UNKNOWN_TOOL", `tool ${unknownOffer} is not in the §11.2 catalog`, { tool: unknownOffer });
      }

      // 5. validatePromptTokensOnly — fails closed, logs the hash only.
      try {
        validatePromptTokensOnly(request.prompt);
      } catch (e) {
        if (e instanceof PromptLeakError) {
          reject(audited, "REJECTED_PROMPT_LEAK", e.message);
        }
        throw e;
      }

      // 6. The call itself. Counted before it is made: a provider error still cost money.
      callsPerRun.set(request.runId, runCalls + 1);
      recentCalls.push(t);
      let body: ProviderResponseBody;
      try {
        body = await provider.invoke({
          endpoint,
          model: config.model,
          zdr: config.zdr,
          dataMode,
          prompt: request.prompt,
          tools: toolDeclarations(names),
          promptHash,
        });
      } catch (e) {
        // `cause` carries the adapter's own classed error out to the run loop, which is what
        // decides between "the model is down, tell a person" and any other refusal. Nothing of
        // the vendor's text goes in the audit row — that is still the message alone.
        reject(audited, "PROVIDER_ERROR", e instanceof Error ? e.message : String(e), { cause: e });
      }

      // 7. JSON-schema tool calls only. The response is hashed before it is inspected, so even a
      //    refused response is auditable without storing a word of it.
      const responseHash = sha256Hex(JSON.stringify(body));
      const calls = body.tool_calls ?? [];
      if (calls.length === 0) {
        reject(audited, "REJECTED_FREE_TEXT", "response carried no tool call (free text is not an answer)", { responseHash });
      }
      if (calls.length > 1) {
        // §11.1 persists tool calls before execution, one at a time; a batch has no idempotency key.
        reject(audited, "REJECTED_MULTIPLE_CALLS", `response carried ${calls.length} tool calls, expected 1`, { responseHash });
      }
      const raw = calls[0];
      const def = toolDef(raw.name);
      if (!def) {
        reject(audited, "REJECTED_UNKNOWN_TOOL", `model called unknown tool ${JSON.stringify(raw.name)}`, { responseHash });
      }
      if (!names.includes(def.name)) {
        reject(audited, "REJECTED_UNKNOWN_TOOL", `tool ${def.name} was not offered this turn`, { responseHash, tool: def.name });
      }
      const parsedArgs = def.schema.safeParse(coerceArgs(raw.arguments));
      if (!parsedArgs.success) {
        // Argument *names* and messages only: a rejected value may be the thing we refuse to log.
        const detail = parsedArgs.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.code}`).join("; ");
        reject(audited, "REJECTED_INVALID_ARGS", `tool ${def.name} args rejected [${detail}]`, { responseHash, tool: def.name });
      }

      const audit = record({
        ...audited,
        outcome: "ACCEPTED",
        responseHash,
        tool: def.name,
        tier: def.tier,
      });
      return {
        call: { tool: def.name, tier: def.tier, args: parsedArgs.data as Record<string, unknown> },
        promptHash,
        responseHash,
        audit,
      };
    },
  };
}

/**
 * Vendors send tool arguments either as an object or as a JSON string. A string that does not
 * parse stays a string, which then fails the schema — exactly the right outcome, with no special
 * case for "the model emitted prose where arguments belong".
 */
function coerceArgs(args: unknown): unknown {
  let parsed: unknown = args;
  if (typeof args === "string") {
    try {
      parsed = JSON.parse(args);
    } catch {
      return args;
    }
  }
  return nullSpellings(parsed);
}

/**
 * A model's way of writing "nothing", read as nothing. Some vendors' models answer a nullable
 * argument with the *string* "None" or "null" — Python's and JSON's spelling of null, quoted — and
 * a strict schema then refuses the whole call over a value that means exactly what null means
 * (seen live: `requested_stop_token: "None"` on a drop-off that kept its stop). Top-level string
 * values that are exactly one of those two words become `null`; the schema still decides whether
 * null is allowed there, so this widens nothing a schema forbids.
 */
// Case-sensitive on purpose: `"NONE"` is a real enum value in this catalog (`next_step_code`).
const NULL_SPELLINGS = /^(?:None|null)$/;
function nullSpellings(args: unknown): unknown {
  if (args === null || typeof args !== "object" || Array.isArray(args)) return args;
  return Object.fromEntries(
    Object.entries(args as Record<string, unknown>).map(([k, v]) => [
      k,
      typeof v === "string" && NULL_SPELLINGS.test(v.trim()) ? null : v,
    ]),
  );
}
