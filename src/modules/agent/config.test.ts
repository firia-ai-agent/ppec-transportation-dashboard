import { describe, expect, it } from "vitest";
import {
  AGENT_ENV_VARS,
  AgentConfigError,
  DEFAULT_BASE_URL,
  DEFAULT_ENDPOINT_ALLOW_LIST,
  DEFAULT_MODEL_ALLOW_LIST,
  DEFAULT_RATE_LIMITS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEMO_DATA_ONLY_ENV_VAR,
  DEMO_DATA_ONLY_REQUIRED_VALUE,
  MODEL_BACKUP,
  MODEL_PRIMARY,
  agentConfigSchema,
  demoDataOnlyFromEnv,
  forbiddenEndpointReason,
  loadAgentConfig,
  vendorAttestationSchema,
} from "./config";

describe("loadAgentConfig defaults (ADR-000 #4, #12)", () => {
  it("needs no environment at all and lands on the founder-locked shape", () => {
    const c = loadAgentConfig({});
    expect(c.provider).toBe("openrouter");
    expect(c.model).toBe(MODEL_PRIMARY);
    expect(c.backupModel).toBe(MODEL_BACKUP);
    expect(c.modelAllowList).toEqual([...DEFAULT_MODEL_ALLOW_LIST]);
    expect(c.zdr).toBe(true);
    expect(c.dataMode).toBe("SYNTHETIC");
    expect(c.endpointAllowList).toEqual([...DEFAULT_ENDPOINT_ALLOW_LIST]);
    expect(c.rateLimits).toEqual(DEFAULT_RATE_LIMITS);
    expect(c.baseUrl).toBe(DEFAULT_BASE_URL);
    expect(c.requestTimeoutMs).toBe(DEFAULT_REQUEST_TIMEOUT_MS);
    // The guard is the one default that is *closed*: an environment with nothing set cannot call out.
    expect(c.demoDataOnly).toBe(false);
  });

  it("the primary and the backup are two different models, both on the allow-list", () => {
    // The backup exists to survive the primary's 429; the same slug twice would not.
    expect(MODEL_BACKUP).not.toBe(MODEL_PRIMARY);
    expect([...DEFAULT_MODEL_ALLOW_LIST]).toEqual([MODEL_PRIMARY, MODEL_BACKUP]);
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
      // The Bedrock swap (ARCHITECTURE §10) is exactly this: new ids, new allow-list, no code change.
      AGENT_MODEL: "vendor-a.model-one",
      AGENT_BACKUP_MODEL: "vendor-a.model-two",
      AGENT_MODEL_ALLOW_LIST: "vendor-a.model-one, vendor-a.model-two",
      AGENT_MODEL_ZDR: "0",
      AGENT_DATA_MODE: "PHI",
      AGENT_ENDPOINT_ALLOW_LIST: "/model/invoke, /model/invoke-stream",
      AGENT_BASE_URL: "https://vendor-a.example",
      AGENT_REQUEST_TIMEOUT_MS: "7000",
      AGENT_MAX_CALLS_PER_RUN: "3",
      AGENT_MAX_CALLS_PER_MINUTE: "5",
      AGENT_MAX_PROMPT_CHARS: "900",
    });
    expect(c).toMatchObject({
      provider: "bedrock",
      model: "vendor-a.model-one",
      backupModel: "vendor-a.model-two",
      modelAllowList: ["vendor-a.model-one", "vendor-a.model-two"],
      zdr: false,
      dataMode: "PHI",
      endpointAllowList: ["/model/invoke", "/model/invoke-stream"],
      baseUrl: "https://vendor-a.example",
      requestTimeoutMs: 7000,
      rateLimits: { maxCallsPerRun: 3, maxCallsPerMinute: 5, maxPromptChars: 900 },
    });
  });

  it("lets an override win over the environment, and keeps the other defaults", () => {
    const c = loadAgentConfig(
      { AGENT_MODEL: "from-env" },
      { model: "from-override", modelAllowList: ["from-override", MODEL_BACKUP], rateLimits: { maxCallsPerRun: 2 } },
    );
    expect(c.model).toBe("from-override");
    expect(c.rateLimits.maxCallsPerRun).toBe(2);
    expect(c.rateLimits.maxCallsPerMinute).toBe(DEFAULT_RATE_LIMITS.maxCallsPerMinute);
  });

  it("lists every env var it reads", () => {
    expect(AGENT_ENV_VARS).toContain("AGENT_PROVIDER");
    expect(AGENT_ENV_VARS).toContain("AGENT_DATA_MODE");
    expect(AGENT_ENV_VARS).toContain(DEMO_DATA_ONLY_ENV_VAR);
    expect(AGENT_ENV_VARS).toContain("AGENT_MODEL_ALLOW_LIST");
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
    model: MODEL_PRIMARY,
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

/* ───────────────────────────── B-08 slice 5: model ids live here ───────────────────────────── */

describe("model allow-list (founder 2026-10-15: the free demo models, and nothing else)", () => {
  it("refuses a model that is not on the allow-list, naming the field and not inventing a default", () => {
    expect(() => loadAgentConfig({ AGENT_MODEL: "vendor-b/some-model" })).toThrow(AgentConfigError);
    try {
      loadAgentConfig({ AGENT_MODEL: "vendor-b/some-model" });
      expect.unreachable();
    } catch (e) {
      expect(String(e)).toContain("model");
      expect(String(e)).toContain("allow-list");
    }
  });

  it("refuses a backup that is not on the allow-list either", () => {
    expect(() => loadAgentConfig({ AGENT_BACKUP_MODEL: "vendor-b/some-model" })).toThrow(AgentConfigError);
  });

  it("accepts a new model only together with the allow-list that admits it", () => {
    // This is the shape of the later switch to the compliant endpoint: both vars move at once.
    const c = loadAgentConfig({
      AGENT_MODEL: "vendor-c/compliant",
      AGENT_BACKUP_MODEL: "vendor-c/compliant",
      AGENT_MODEL_ALLOW_LIST: "vendor-c/compliant",
    });
    expect([c.model, c.backupModel]).toEqual(["vendor-c/compliant", "vendor-c/compliant"]);
  });

  it("refuses an empty model allow-list", () => {
    expect(agentConfigSchema.safeParse({ modelAllowList: [] }).success).toBe(false);
  });
});

/* ─────────────────── B-08 slice 5: the demo-data-only guard, fail shut (§2.5A) ─────────────────── */

describe(`${DEMO_DATA_ONLY_ENV_VAR} guard`, () => {
  it("is open only for the exact required value", () => {
    expect(loadAgentConfig({ [DEMO_DATA_ONLY_ENV_VAR]: DEMO_DATA_ONLY_REQUIRED_VALUE }).demoDataOnly).toBe(true);
    expect(DEMO_DATA_ONLY_REQUIRED_VALUE).toBe("true");
  });

  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["whitespace", " "],
    ["padded", " true "],
    ["upper case", "TRUE"],
    ["title case", "True"],
    ["the numeral", "1"],
    ["a synonym", "yes"],
    ["the negative", "false"],
    ["the other numeral", "0"],
    ["the old spelling from the research note", "demo"],
  ])("stays shut for a %s value", (_label, value) => {
    const env = value === undefined ? {} : { [DEMO_DATA_ONLY_ENV_VAR]: value };
    expect(demoDataOnlyFromEnv(env)).toBe(false);
    expect(loadAgentConfig(env).demoDataOnly).toBe(false);
  });

  it("is a separate switch from AGENT_DATA_MODE, which keeps its own meaning", () => {
    // Two vars, two jobs. Confirming demo data does not silently also claim SYNTHETIC mode,
    // and selecting PHI mode does not open the demo gate.
    const demo = loadAgentConfig({ [DEMO_DATA_ONLY_ENV_VAR]: DEMO_DATA_ONLY_REQUIRED_VALUE, AGENT_DATA_MODE: "PHI" });
    expect([demo.demoDataOnly, demo.dataMode]).toEqual([true, "PHI"]);
    expect(loadAgentConfig({ AGENT_DATA_MODE: "SYNTHETIC" }).demoDataOnly).toBe(false);
  });

  it("carries no key value, whatever else is in the environment", () => {
    const c = loadAgentConfig({
      [DEMO_DATA_ONLY_ENV_VAR]: DEMO_DATA_ONLY_REQUIRED_VALUE,
      OPENROUTER_API_KEY: "placeholder-not-a-key",
    });
    expect(JSON.stringify(c)).not.toContain("placeholder-not-a-key");
  });
});
