/**
 * FakeProvider: a scripted, deterministic model. No network, no clock, no randomness — the same
 * script in the same order, every run, under any TZ.
 *
 * This is what the policy and attack suites drive: AT-09 and TEST-SEC-01 have to assert "zero
 * sends" for a *specific* malicious model output, which means the test has to choose that output.
 * The live Claude-via-OpenRouter path (ADR-000 #4) is non-determinism the acceptance tests cannot
 * depend on (BUILD-PLAN-M2 risk 3), so it never appears in a test.
 */
import {
  type LlmProvider,
  type ProviderCall,
  type ProviderResponseBody,
  ProviderError,
} from "./provider";

export type FakeScript = readonly ProviderResponseBody[];

export type FakeProviderOptions = {
  /** Vendor name to report. Defaults to the configured provider so the gateway's check passes. */
  vendor?: string;
  endpoint?: string;
  /** Replay the last scripted response forever instead of throwing when the script runs out. */
  repeatLast?: boolean;
};

export interface FakeProvider extends LlmProvider {
  readonly kind: "fake";
  /** Calls made, for assertions. Hashes and tool names only — never the prompt text. */
  readonly calls: readonly { promptHash: string; endpoint: string; model: string; zdr: boolean; tools: number }[];
  reset(): void;
}

/**
 * One tool call, as a provider would return it. Sugar for the many fixtures that script exactly
 * one output: `fakeProvider([toolCall("send_followup", {...})])`.
 */
export function toolCall(name: string, args: unknown): ProviderResponseBody {
  return { tool_calls: [{ name, arguments: args }], finish_reason: "tool_calls" };
}

/** A model that answered in prose instead of calling a tool — the §11.2 free-text violation. */
export function freeText(content: string): ProviderResponseBody {
  return { content, finish_reason: "stop" };
}

export function fakeProvider(script: FakeScript, options: FakeProviderOptions = {}): FakeProvider {
  const calls: { promptHash: string; endpoint: string; model: string; zdr: boolean; tools: number }[] = [];
  let next = 0;
  const endpoint = options.endpoint ?? "/api/v1/chat/completions";
  return {
    kind: "fake",
    vendor: options.vendor ?? "openrouter",
    endpoint,
    calls,
    reset() {
      next = 0;
      calls.length = 0;
    },
    async invoke(call: ProviderCall): Promise<ProviderResponseBody> {
      calls.push({
        promptHash: call.promptHash,
        endpoint: call.endpoint,
        model: call.model,
        zdr: call.zdr,
        tools: call.tools.length,
      });
      const i = options.repeatLast ? Math.min(next, script.length - 1) : next;
      next += 1;
      const body = script[i];
      if (!body) throw new ProviderError(`fake provider script exhausted after ${script.length} response(s)`);
      return body;
    },
  };
}
