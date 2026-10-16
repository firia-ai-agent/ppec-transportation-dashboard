import { describe, expect, it } from "vitest";
import { DATA_CLASS_ENV_VAR, SYNTHETIC_DATA_CLASS } from "@/lib/env";
import {
  AGENT_ENV_VARS,
  AgentConfigError,
  DEFAULT_BASE_URL,
  DEFAULT_BASE_URL_HOST_ALLOW_LIST,
  DEFAULT_ENDPOINT_ALLOW_LIST,
  DEFAULT_MODEL_ALLOW_LIST,
  DEFAULT_RATE_LIMITS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEMO_DATA_ONLY_ENV_VAR,
  DEMO_DATA_ONLY_REQUIRED_VALUE,
  MODEL_BACKUP,
  MODEL_PRIMARY,
  REQUIRED_BASE_URL_PROTOCOL,
  agentConfigSchema,
  baseUrlRefusalReason,
  demoDataGuardRefusal,
  demoDataOnlyFromEnv,
  forbiddenEndpointReason,
  loadAgentConfig,
  vendorAttestationSchema,
} from "./config";

/** The environment a confirmed demo deployment has: the agent's own var *and* the boot data class. */
const DEMO_ENV = {
  [DEMO_DATA_ONLY_ENV_VAR]: DEMO_DATA_ONLY_REQUIRED_VALUE,
  [DATA_CLASS_ENV_VAR]: SYNTHETIC_DATA_CLASS,
};

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
    expect(c.baseUrlHostAllowList).toEqual([...DEFAULT_BASE_URL_HOST_ALLOW_LIST]);
    expect(c.requestTimeoutMs).toBe(DEFAULT_REQUEST_TIMEOUT_MS);
    // The guard is the one default that is *closed*: an environment with nothing set cannot call out.
    expect(c.demoDataOnly).toBe(false);
  });

  it("the SCHEMA's own default for demoDataOnly is false, with no env read in front of it", () => {
    // `loadAgentConfig` always supplies this field (demoDataOnlyFromEnv returns a boolean either
    // way), so its default is never the thing being exercised there — and the schema is what a
    // caller parsing a config object of its own hits. Asserted directly: a config that does not
    // mention the guard at all must come out closed, not merely a config built from an empty env.
    expect(agentConfigSchema.parse({}).demoDataOnly).toBe(false);
    expect(agentConfigSchema.parse({ provider: "openrouter" }).demoDataOnly).toBe(false);
    // And the field is genuinely optional — a parse that needed it would hide the default.
    expect(agentConfigSchema.safeParse({}).success).toBe(true);
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
      // The two destination vars move together, exactly as the two model vars do.
      AGENT_BASE_URL: "https://vendor-a.example",
      AGENT_BASE_URL_HOST_ALLOW_LIST: "vendor-a.example",
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
      baseUrlHostAllowList: ["vendor-a.example"],
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
    expect(AGENT_ENV_VARS).toContain("AGENT_BASE_URL_HOST_ALLOW_LIST");
    // The boot data class is on the list because the demo-data guard reads it too.
    expect(AGENT_ENV_VARS).toContain(DATA_CLASS_ENV_VAR);
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
    // and selecting PHI mode does not open the demo gate. (The *guard* refuses that pair anyway —
    // demoDataGuardRefusal below — but the two fields keep their own meanings on the config.)
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

/* ────────── the guard is three conditions: the confirmation, the boot class, the data mode ────────── */

describe("demoDataGuardRefusal", () => {
  it("permits a live call only when all three agree", () => {
    expect(demoDataGuardRefusal(loadAgentConfig(DEMO_ENV), DEMO_ENV)).toBeNull();
  });

  it("refuses when the confirmation var is missing, naming it and why it fails shut", () => {
    const env = { [DATA_CLASS_ENV_VAR]: SYNTHETIC_DATA_CLASS };
    const reason = demoDataGuardRefusal(loadAgentConfig(env), env);
    expect(reason).toContain(DEMO_DATA_ONLY_ENV_VAR);
    expect(reason).toMatch(/fails shut/);
  });

  it.each([
    ["the PHI data class", "PHI"],
    ["a real data class", "REAL"],
    ["an unset data class", undefined],
  ])("refuses %s even with the confirmation set", (_label, dataClass) => {
    // The operator's assertion about the data is checked against what the deployment says it is.
    // A var set once on a demo project and inherited by a clone that now holds real rows is
    // exactly how that assertion goes stale, and ADR-015's boot class is the fact to check it on.
    const env = {
      [DEMO_DATA_ONLY_ENV_VAR]: DEMO_DATA_ONLY_REQUIRED_VALUE,
      ...(dataClass === undefined ? {} : { [DATA_CLASS_ENV_VAR]: dataClass }),
    };
    const config = loadAgentConfig(env);
    expect(config.demoDataOnly).toBe(true); // the var itself is set; it is not enough
    const reason = demoDataGuardRefusal(config, env);
    expect(reason).toContain(DATA_CLASS_ENV_VAR);
    expect(reason).toMatch(/fails shut/);
  });

  it("refuses a non-synthetic dataMode even with the confirmation and the boot class set", () => {
    // PHI mode is the one that demands a vendorAttestation (gateway.ts), and a vendor with no BAA
    // cannot produce one: a PHI-mode deployment calling a free endpoint is a contradiction.
    const env = { ...DEMO_ENV, AGENT_DATA_MODE: "PHI" };
    const config = loadAgentConfig(env);
    expect([config.demoDataOnly, config.dataMode]).toEqual([true, "PHI"]);
    const reason = demoDataGuardRefusal(config, env);
    expect(reason).toContain("PHI");
    expect(reason).toMatch(/not\s+SYNTHETIC/);
    expect(reason).toMatch(/fails shut/);
  });

  it("refuses to let an override set the confirmation at all", () => {
    // The fail-shut default is worth nothing if any caller holding a config can flip it, and
    // "just pass demoDataOnly" is the shortest route from a test helper to a production bypass.
    expect(() => loadAgentConfig({}, { demoDataOnly: true })).toThrow(AgentConfigError);
    expect(() => loadAgentConfig({}, { demoDataOnly: true })).toThrow(/demoDataOnly/);
    expect(() => loadAgentConfig({}, { demoDataOnly: true })).toThrow(DEMO_DATA_ONLY_ENV_VAR);
    // Including the one that would merely restate the environment: there is one source, not two.
    expect(() => loadAgentConfig(DEMO_ENV, { demoDataOnly: true })).toThrow(AgentConfigError);
    // Every other knob still overrides, which is what the Bedrock swap and the suites need.
    expect(loadAgentConfig({}, { requestTimeoutMs: 5 }).requestTimeoutMs).toBe(5);
  });

  it("a config object that sets the flag by hand still has to pass the other two", () => {
    // `loadAgentConfig` is not the only way to get an AgentConfig — a caller can build one. The
    // guard reads the environment itself, so a hand-set flag buys nothing on a non-synthetic box.
    const forged = { ...loadAgentConfig(DEMO_ENV), demoDataOnly: true };
    expect(demoDataGuardRefusal(forged, {})).toContain(DATA_CLASS_ENV_VAR);
    expect(demoDataGuardRefusal({ ...forged, dataMode: "PHI" }, DEMO_ENV)).toMatch(/not\s+SYNTHETIC/);
  });

  it("is not user-facing copy: lowercase clauses, no sentence punctuation", () => {
    // src/ui/copy.test.ts scans every non-test file for sentence-shaped literals. These refusals
    // are notes to an operator reading a log, and a staff-readable one belongs in ui/copy.ts.
    for (const env of [{}, { [DEMO_DATA_ONLY_ENV_VAR]: DEMO_DATA_ONLY_REQUIRED_VALUE }]) {
      const reason = demoDataGuardRefusal(loadAgentConfig(env), env)!;
      expect(reason).not.toMatch(/^[A-Z]/);
      expect(reason).not.toMatch(/[.!?]$/);
    }
  });
});

/* ───────── the destination: https, and a host this deployment allow-listed (S3) ───────── */

describe("base URL must be https and on the host allow-list", () => {
  it("accepts the default origin, which is on the default host allow-list", () => {
    expect(baseUrlRefusalReason(DEFAULT_BASE_URL, [...DEFAULT_BASE_URL_HOST_ALLOW_LIST])).toBeNull();
    expect(loadAgentConfig({}).baseUrl).toBe(DEFAULT_BASE_URL);
    expect(REQUIRED_BASE_URL_PROTOCOL).toBe("https:");
  });

  it.each([
    ["plain http", "http://openrouter.ai"],
    ["an uppercase scheme that is still http", "HTTP://openrouter.ai"],
    ["a non-HTTP scheme", "ftp://openrouter.ai"],
    ["a file URL", "file:///etc/hosts"],
  ])("refuses %s, naming the scheme", (_label, baseUrl) => {
    // Plain http would put the key and the prompt on the wire in clear, and a redirect to https
    // is not a mitigation: the first request has already left.
    const reason = baseUrlRefusalReason(baseUrl, [...DEFAULT_BASE_URL_HOST_ALLOW_LIST]);
    expect(reason).toMatch(/scheme/);
    expect(() => loadAgentConfig({ AGENT_BASE_URL: baseUrl })).toThrow(AgentConfigError);
    expect(() => loadAgentConfig({ AGENT_BASE_URL: baseUrl })).toThrow(/baseUrl/);
  });

  it.each([
    ["another vendor", "https://vendor-b.example"],
    ["a lookalike subdomain", "https://openrouter.ai.evil.example"],
    ["a host that merely contains the allowed one", "https://notopenrouter.ai"],
    ["the allowed host on another port", "https://openrouter.ai:8443"],
    ["an IP address", "https://10.0.0.1"],
  ])("refuses %s, which is not on the host allow-list", (_label, baseUrl) => {
    const reason = baseUrlRefusalReason(baseUrl, [...DEFAULT_BASE_URL_HOST_ALLOW_LIST]);
    expect(reason).toMatch(/host allow-list/);
    expect(() => loadAgentConfig({ AGENT_BASE_URL: baseUrl })).toThrow(AgentConfigError);
  });

  it.each([
    ["not a URL at all", "openrouter.ai"],
    ["an empty-ish value", "   "],
    ["a path on its own", "/api/v1/chat/completions"],
  ])("refuses %s as not an absolute URL", (_label, baseUrl) => {
    expect(baseUrlRefusalReason(baseUrl, [...DEFAULT_BASE_URL_HOST_ALLOW_LIST])).toMatch(/absolute URL/);
    expect(() => loadAgentConfig({ AGENT_BASE_URL: baseUrl })).toThrow(AgentConfigError);
  });

  it("refuses credentials smuggled through the URL's userinfo", () => {
    // `https://user:pass@openrouter.ai` passes a naive host check while carrying a credential
    // through config, which is the one thing this module never holds.
    const reason = baseUrlRefusalReason("https://user:pass@openrouter.ai", ["openrouter.ai"]);
    expect(reason).toMatch(/userinfo/);
    expect(() => loadAgentConfig({ AGENT_BASE_URL: "https://user:pass@openrouter.ai" })).toThrow(
      AgentConfigError,
    );
  });

  it("the refusal names the scheme and the host, never the whole URL", () => {
    // The string lands in a thrown error, and a URL can carry a secret in its userinfo or query.
    const withSecret = "https://openrouter.ai.evil.example/?token=placeholder-not-a-key";
    const reason = baseUrlRefusalReason(withSecret, ["openrouter.ai"])!;
    expect(reason).toContain("openrouter.ai.evil.example");
    expect(reason).not.toContain("placeholder-not-a-key");
    try {
      loadAgentConfig({ AGENT_BASE_URL: withSecret });
      expect.unreachable();
    } catch (e) {
      expect(String(e)).not.toContain("placeholder-not-a-key");
    }
  });

  it("a new host joins by env, together with the base URL that uses it", () => {
    // The shape of the later switch to the compliant endpoint: both vars move at once, exactly
    // like AGENT_MODEL and AGENT_MODEL_ALLOW_LIST.
    const c = loadAgentConfig({
      AGENT_BASE_URL: "https://vendor-c.example",
      AGENT_BASE_URL_HOST_ALLOW_LIST: "vendor-c.example, openrouter.ai",
    });
    expect(c.baseUrl).toBe("https://vendor-c.example");
    expect(c.baseUrlHostAllowList).toEqual(["vendor-c.example", "openrouter.ai"]);
    // Moving only the allow-list, or only the URL, is a config error either way.
    expect(() => loadAgentConfig({ AGENT_BASE_URL: "https://vendor-c.example" })).toThrow(AgentConfigError);
    expect(() => loadAgentConfig({ AGENT_BASE_URL_HOST_ALLOW_LIST: "vendor-c.example" })).toThrow(
      AgentConfigError,
    );
  });

  it("refuses an empty host allow-list (there is no implicit default at call time)", () => {
    expect(agentConfigSchema.safeParse({ baseUrlHostAllowList: [] }).success).toBe(false);
  });

  it("an override cannot point the vendor somewhere unvetted either", () => {
    // Overrides exist for the Bedrock swap, and they go through the same refinement.
    expect(() => loadAgentConfig({}, { baseUrl: "http://openrouter.ai" })).toThrow(AgentConfigError);
    expect(() => loadAgentConfig({}, { baseUrl: "https://vendor-b.example" })).toThrow(AgentConfigError);
    expect(
      loadAgentConfig({}, { baseUrl: "https://vendor-b.example", baseUrlHostAllowList: ["vendor-b.example"] })
        .baseUrl,
    ).toBe("https://vendor-b.example");
  });
});
