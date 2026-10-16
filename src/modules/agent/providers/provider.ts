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

/** What the gateway hands a provider. The prompt has already passed validatePromptTokensOnly(). */
export type ProviderCall = {
  readonly endpoint: string;
  readonly model: string;
  /** ADR-000 #12 zdr:true. Stamped by the gateway on every call, never decided by the adapter. */
  readonly zdr: boolean;
  readonly dataMode: DataMode;
  readonly prompt: string;
  /** JSON-Schema tool declarations (PRD §11.2 "JSON-schema tool calls only"). */
  readonly tools: readonly { name: string; tier: string; parameters: Record<string, unknown> }[];
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
};

/** `keyword` is the PRD §18.1 degraded mode (providers/keyword.ts), not a vendor. */
export type ProviderKind = "fake" | "recorded" | "remote" | "keyword";

export interface LlmProvider {
  readonly kind: ProviderKind;
  /** Vendor name; the gateway requires it to match `config.provider` so attestation cannot lie. */
  readonly vendor: string;
  /** Path this adapter would call. Must be on `config.endpointAllowList`. */
  readonly endpoint: string;
  invoke(call: ProviderCall): Promise<ProviderResponseBody>;
}

export class ProviderError extends Error {}
