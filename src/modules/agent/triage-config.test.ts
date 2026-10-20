import { describe, expect, it } from "vitest";
import { DEFAULT_MODEL_ALLOW_LIST, loadAgentConfig } from "./config";
import { normalize } from "./providers/remote";

describe("triage's configuration and cost (ledger #85)", () => {
  it("is off unless a model is named, and that model must be one the deployment may call", () => {
    expect(loadAgentConfig({}).triageModel).toBeUndefined();
    expect(loadAgentConfig({ AGENT_TRIAGE_MODEL: "" }).triageModel).toBeUndefined();
    const allowed = DEFAULT_MODEL_ALLOW_LIST[0];
    expect(loadAgentConfig({ AGENT_TRIAGE_MODEL: allowed }).triageModel).toBe(allowed);
    expect(() => loadAgentConfig({ AGENT_TRIAGE_MODEL: "vendor/not-on-the-list" })).toThrow(/triageModel/);
  });

  it("keeps the vendor's token counts instead of throwing them away", () => {
    const body = normalize({
      choices: [{ message: { tool_calls: [{ function: { name: "classify_message", arguments: "{}" } }] }, finish_reason: "tool_calls" }],
      usage: { prompt_tokens: 812, completion_tokens: 14 },
    });
    expect(body?.usage).toEqual({ inputTokens: 812, outputTokens: 14 });
    expect(normalize({ choices: [{ message: { content: "hi" } }] })?.usage).toBeUndefined();
  });
});
