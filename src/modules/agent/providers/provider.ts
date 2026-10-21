/**
 * The vendor seam (ARCHITECTURE §2 "LLMGateway", §10 "OpenRouter (ZDR) → Bedrock Claude").
 *
 * A provider does one thing: take an already-validated prompt plus tool declarations to a model
 * and hand back a normalized body. It does not redact, validate, rate-limit, audit or interpret —
 * all of that is the gateway's, so a new vendor adapter cannot forget any of it.
 *
 * Every provider is also checked against the config endpoint allow-list by the gateway, which is
 * why `endpoint` is part of the interface rather than private to the adapter.
 */
import type { DataMode } from "../config";

/** What the gateway hands a provider, after its endpoint, attestation and rate-limit checks. */
export type ProviderCall = {
  readonly endpoint: string;
  readonly model: string;
  /** ADR-000 #12 zdr:true. Stamped by the gateway on every call, never decided by the adapter. */
  readonly zdr: boolean;
  readonly dataMode: DataMode;
  readonly prompt: string;
  /**
   * `prompt` as cacheable blocks, when the caller built it that way (ledger #87); joined with "\n"
   * they are exactly `prompt`. An adapter that cannot cache sends `prompt` and ignores these.
   */
  readonly promptBlocks?: readonly string[];
  /** JSON-Schema tool declarations (PRD §11.2 "JSON-schema tool calls only"). */
  readonly tools: readonly { name: string; tier: string; parameters: Record<string, unknown>; description?: string }[];
  /** sha256 of the prompt, the only form of it a provider may log or key on. */
  readonly promptHash: string;
};

/**
 * The normalized response body. A real adapter maps its vendor's envelope onto this shape; the
 * gateway reads nothing else. `content` exists only so the gateway can *reject* free text with a
 * clear reason — a response with prose and no tool call is a contract violation, not an answer.
 */
export type ProviderResponseBody = {
  readonly tool_calls?: readonly { readonly name: string; readonly arguments: unknown }[];
  readonly content?: string | null;
  readonly finish_reason?: string;
  /** What the turn cost, when the vendor says (ledger #85): counts only, recorded on `agent_run`. */
  readonly usage?: TokenUsage;
};

export type TokenUsage = {
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Of `inputTokens`, how many the provider read from its prompt cache (ledger #87). */
  readonly cachedInputTokens?: number;
};

/**
 * Every kind of provider there is. All three are vendors or stand-ins for one.
 *
 * There is deliberately no degraded, non-model kind. PRD §18.1 l.1200 had one — a keyword reader
 * that answered a family when the vendor could not — and the founder's 2026-10-17 rule removed it:
 * "never compensate with a deterministic text parser if the model isn't available; the
 * owner/staff need to be notified". So a provider is a way of reaching a model, and when no model
 * can be reached the answer is a staff alert (`agent/staff-alert.ts`), not another kind here.
 * `agent/no-keyword-fallback.test.ts` holds that down.
 */
export type ProviderKind = "fake" | "recorded" | "remote";

export interface LlmProvider {
  readonly kind: ProviderKind;
  /** Vendor name; the gateway requires it to match `config.provider` so attestation cannot lie. */
  readonly vendor: string;
  /** Path this adapter would call. Must be on `config.endpointAllowList`. */
  readonly endpoint: string;
  invoke(call: ProviderCall): Promise<ProviderResponseBody>;
}

export class ProviderError extends Error {}
