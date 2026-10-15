import { describe, expect, it } from "vitest";
import {
  AGENT_ENV_VARS,
  AgentConfigError,
  DEFAULT_ENDPOINT_ALLOW_LIST,
  DEFAULT_RATE_LIMITS,
  agentConfigSchema,
  forbiddenEndpointReason,
  loadAgentConfig,
  vendorAttestationSchema,
} from "./config";

describe("loadAgentConfig defaults (ADR-000 #4, #12)", () => {
  it("needs no environment at all and lands on the founder-locked shape", () => {
    const c = loadAgentConfig({});
    expect(c.provider).toBe("openrouter");
    expect(c.model).toBe("anthropic/claude-sonnet");
    expect(c.zdr).toBe(true);
    expect(c.dataMode).toBe("SYNTHETIC");
    expect(c.endpointAllowList).toEqual([...DEFAULT_ENDPOINT_ALLOW_LIST]);
    expect(c.rateLimits).toEqual(DEFAULT_RATE_LIMITS);
  });

  it("references the key by env var NAME and never reads its value", () => {
    const c = loadAgentConfig({ OPENROUTER_API_KEY: "sk-must-not-be-read" });
    expect(c.apiKeyEnvVar).toBe("OPENROUTER_API_KEY");
    expect(JSON.stringify(c)).not.toContain("sk-must-not-be-read");
  });

  it("does not require the key to be set, in any environment", () => {
    expect(() => loadAgentConfig({})).not.toThrow();
    expect(loadAgentConfig({}).apiKeyEnvVar).toBe("OPENROUTER_API_KEY");
    // The var name itself is configurable, for the Bedrock swap (ARCHITECTURE §10).
    expect(loadAgentConfig({ AGENT_API_KEY_ENV_VAR: "BEDROCK_ROLE_ARN" }).apiKeyEnvVar).toBe("BEDROCK_ROLE_ARN");
  });

  it("reads each knob from its env var", () => {
    const c = loadAgentConfig({
      AGENT_PROVIDER: "bedrock",
      AGENT_MODEL: "anthropic.claude-sonnet",
      AGENT_MODEL_ZDR: "0",
      AGENT_DATA_MODE: "PHI",
      AGENT_ENDPOINT_ALLOW_LIST: "/model/invoke, /model/invoke-stream",
      AGENT_MAX_CALLS_PER_RUN: "3",
      AGENT_MAX_CALLS_PER_MINUTE: "5",
      AGENT_MAX_PROMPT_CHARS: "900",
    });
    expect(c).toMatchObject({
      provider: "bedrock",
      model: "anthropic.claude-sonnet",
      zdr: false,
      dataMode: "PHI",
      endpointAllowList: ["/model/invoke", "/model/invoke-stream"],
      rateLimits: { maxCallsPerRun: 3, maxCallsPerMinute: 5, maxPromptChars: 900 },
    });
  });

  it("lets an override win over the environment, and keeps the other defaults", () => {
    const c = loadAgentConfig({ AGENT_MODEL: "from-env" }, { model: "from-override", rateLimits: { maxCallsPerRun: 2 } });
    expect(c.model).toBe("from-override");
    expect(c.rateLimits.maxCallsPerRun).toBe(2);
    expect(c.rateLimits.maxCallsPerMinute).toBe(DEFAULT_RATE_LIMITS.maxCallsPerMinute);
  });

  it("lists every env var it reads", () => {
    expect(AGENT_ENV_VARS).toContain("AGENT_PROVIDER");
    expect(AGENT_ENV_VARS).toContain("AGENT_DATA_MODE");
    // No row on that list is a secret: a key would be read by name, not configured here.
    expect(AGENT_ENV_VARS.some((v) => /KEY$/.test(v))).toBe(false);
  });

  it("refuses a malformed value by name, without echoing it", () => {
    expect(() => loadAgentConfig({ AGENT_DATA_MODE: "REAL" })).toThrow(AgentConfigError);
    try {
      loadAgentConfig({ AGENT_MAX_CALLS_PER_RUN: "not-a-number" });
      expect.unreachable();
    } catch (e) {
      expect(String(e)).toContain("rateLimits.maxCallsPerRun");
      expect(String(e)).not.toContain("not-a-number");
    }
  });
});

describe("endpoint allow-list excludes Batch/Files/Code-Exec/Web-Fetch (PRD §11.2)", () => {
  it.each([
    "/api/v1/batch",
    "/v1/batches",
    "/api/v1/files",
    "/v1/files/upload",
    "/api/v1/code-exec",
    "/v1/code_execution",
    "/api/v1/web-fetch",
    "/v1/web_search",
    "/v1/fine-tuning/jobs",
  ])("refuses %s at config time", (endpoint) => {
    expect(forbiddenEndpointReason(endpoint)).not.toBeNull();
    expect(() => loadAgentConfig({ AGENT_ENDPOINT_ALLOW_LIST: endpoint })).toThrow(AgentConfigError);
  });

  it("allows the one completion endpoint the agent needs", () => {
    expect(forbiddenEndpointReason("/api/v1/chat/completions")).toBeNull();
    expect(loadAgentConfig({ AGENT_ENDPOINT_ALLOW_LIST: "/api/v1/chat/completions" }).endpointAllowList).toEqual([
      "/api/v1/chat/completions",
    ]);
  });

  it("refuses an empty allow-list (there is no implicit default at call time)", () => {
    expect(agentConfigSchema.safeParse({ endpointAllowList: [] }).success).toBe(false);
  });
});

describe("vendorAttestation shape (PRD §11.2)", () => {
  const good = {
    provider: "openrouter",
    model: "anthropic/claude-sonnet",
    region: "us-east-1",
    baa_version: "2026-02",
    retention_confirmation_id: "zdr-7781",
  };

  it("accepts all five fields", () => {
    expect(vendorAttestationSchema.parse(good)).toEqual(good);
  });

  it.each(Object.keys(good))("refuses a missing or blank %s", (field) => {
    const { [field]: _dropped, ...without } = good as Record<string, string>;
    expect(vendorAttestationSchema.safeParse(without).success).toBe(false);
    expect(vendorAttestationSchema.safeParse({ ...good, [field]: "" }).success).toBe(false);
  });
});
