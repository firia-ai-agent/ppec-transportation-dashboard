/**
 * The live OpenRouter adapter (B-08 slice 5). `fetch` is stubbed in every test here — nothing in
 * this file, or anywhere in the suite, reaches a real vendor.
 *
 * Five things are worth proving, in descending order of how much damage getting them wrong does:
 *
 *  1. **The demo-data guard fails shut, and refuses without calling fetch.** All three conditions:
 *     the confirmation var (missing, wrong value, right value), the ADR-015 boot data class, and
 *     this module's data mode. None of the free endpoints offer zero data retention and OpenRouter
 *     has no BAA, so this guard is the only thing keeping real family data away from them. A
 *     refusal that had already sent the body would be no guard at all.
 *  2. **The destination is refused before a Bearer header exists.** Plain http, or a host off
 *     `baseUrlHostAllowList`: the base URL decides *where the key goes*, so the refusal has to land
 *     before the key is read, not after a request was sent to a host nobody vetted. And the base
 *     URL is only *half* of the destination — the endpoint is joined onto it — so section 10 is
 *     the other half: an allow-listed endpoint cannot name a host, the URL is built with the URL
 *     parser rather than concatenated, and the finished URL is re-read where the key is attached.
 *  3. **The model chain.** 429 on the primary tries the backup; failure on both is
 *     `RemoteProviderUnavailable` and nothing else. Any other provider error behaves the same way,
 *     because a free endpoint has more ways to fail than a rate limit. There is no third attempt in
 *     another form: the founder's 2026-10-17 rule removed the §18.1 keyword parser that used to
 *     answer here, so every one of these cases now ends in a refusal the caller turns into one
 *     staff alert (`agent/staff-alert.ts`) — no reply, no ride change, no send.
 *  4. **The outbound body.** The model id comes from config, is re-checked against the allow-list
 *     on this path, `allow_fallbacks:false` and `require_parameters:true` are on every request, and
 *     the key is in the authorization header and nowhere else.
 *  5. **Nothing leaks.** No key value and no prompt text in an error, an attempt record or a
 *     thrown stack — TEST-SEC-01 on the path that actually leaves the building.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DATA_CLASS_ENV_VAR, SYNTHETIC_DATA_CLASS } from "@/lib/env";
import {
  AgentConfigError,
  DEMO_DATA_ONLY_ENV_VAR,
  DEMO_DATA_ONLY_REQUIRED_VALUE,
  loadAgentConfig,
} from "../config";
import { createGateway } from "../gateway";
import { wrapUntrusted } from "../policy";
import { sha256Hex } from "../redact";
import { TOOL_NAMES, toolDeclarations } from "../tools";
import {
  RATE_LIMITED,
  RemoteBaseUrlRefused,
  RemoteEndpointRefused,
  RemoteModelRefused,
  RemoteProviderNotEnabled,
  RemoteProviderUnavailable,
  RemoteRequestUrlRefused,
  modelChain,
  normalize,
  remoteProvider,
  verifiedRequestUrl,
} from "./remote";

/** A placeholder, low entropy, obviously not a credential. The real one is supplied by the founder. */
const PLACEHOLDER_KEY = "placeholder-not-a-key";

/** What a confirmed demo deployment has in its environment: the agent's var, the boot class, a key. */
const DEMO_ENV = {
  [DEMO_DATA_ONLY_ENV_VAR]: DEMO_DATA_ONLY_REQUIRED_VALUE,
  [DATA_CLASS_ENV_VAR]: SYNTHETIC_DATA_CLASS,
};
const KEY_ENV = { ...DEMO_ENV, OPENROUTER_API_KEY: PLACEHOLDER_KEY };

/** The config a demo deployment has: the guard confirmed, everything else at its default. */
const DEMO = loadAgentConfig(DEMO_ENV);
/** The fail-shut default: no demo confirmation anywhere in the environment. */
const UNCONFIRMED = loadAgentConfig({});

const SMS = "wont need the AM van, dropping off at 9:30";
const PROMPT = [
  "role=transport_coordinator_agent",
  "T1 site=S1 family=F1 child=C1 scopes=CANCEL_LEG",
  "T2 leg=L-C1-AM state=SCHEDULED version=3",
  `T3 ${wrapUntrusted(SMS)}`,
  "task=choose exactly one tool call",
].join("\n");

const call = (overrides: Partial<Parameters<ReturnType<typeof remoteProvider>["invoke"]>[0]> = {}) => ({
  endpoint: DEMO.endpointAllowList[0],
  model: DEMO.model,
  zdr: DEMO.zdr,
  dataMode: DEMO.dataMode,
  prompt: PROMPT,
  tools: toolDeclarations(["get_leg_state", "cancel_attendance_or_leg"]),
  promptHash: sha256Hex(PROMPT),
  ...overrides,
});

/* ───────────────────────────── stubbed vendor responses ───────────────────────────── */

/** A well-formed OpenRouter envelope carrying one tool call. */
const vendorToolCall = (name: string, args: unknown) => ({
  ok: true,
  status: 200,
  json: async () => ({
    choices: [{ message: { content: null, tool_calls: [{ function: { name, arguments: args } }] }, finish_reason: "tool_calls" }],
  }),
});

const vendorStatus = (status: number) => ({ ok: false, status, json: async () => ({ error: { message: "nope" } }) });

const CANCEL_ARGS = {
  child_token: "C1",
  date: "2026-10-16",
  day_part: "AM",
  reason_code: "FAMILY_DROPOFF",
  expected_self_arrival: "09:30",
  expected_version: 3,
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** The JSON body of the nth fetch call. */
const bodyOf = (nth = 0) => JSON.parse(fetchMock.mock.calls[nth][1].body as string);

/* ───────────────── 1. the demo-data-only guard, fail shut (§2.5A) ───────────────── */

describe("demo-data-only guard", () => {
  it("refuses when the setting is missing, and does not call fetch", () => {
    expect(() => remoteProvider(UNCONFIRMED, KEY_ENV)).toThrow(RemoteProviderNotEnabled);
    expect(() => remoteProvider(UNCONFIRMED, KEY_ENV)).toThrow(/AGENT_DEMO_DATA_ONLY/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["empty", ""],
    ["the negative", "false"],
    ["the numeral", "1"],
    ["the wrong case", "TRUE"],
    ["padded", " true "],
    ["the research note's old spelling", "demo"],
  ])("refuses a %s value, and does not call fetch", (_label, value) => {
    const cfg = loadAgentConfig({ [DEMO_DATA_ONLY_ENV_VAR]: value });
    expect(() => remoteProvider(cfg, KEY_ENV)).toThrow(RemoteProviderNotEnabled);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("allows the call when the value is exactly right", async () => {
    fetchMock.mockResolvedValue(vendorToolCall("get_leg_state", { leg_id: "L-C1-AM" }));
    const provider = remoteProvider(DEMO, KEY_ENV);
    const body = await provider.invoke(call());
    expect(body.tool_calls).toEqual([{ name: "get_leg_state", arguments: { leg_id: "L-C1-AM" } }]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refuses before the key check: a key present does not soften the guard", () => {
    // The dangerous deployment is the one with a working key and no demo confirmation.
    try {
      remoteProvider(UNCONFIRMED, KEY_ENV);
      expect.unreachable();
    } catch (e) {
      expect(String(e)).toMatch(/AGENT_DEMO_DATA_ONLY/);
      expect(String(e)).not.toMatch(/OPENROUTER_API_KEY/);
      expect(String(e)).not.toContain(PLACEHOLDER_KEY);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("is re-checked on every call, not only when the provider was built", async () => {
    // A caller holding a provider built under a confirmed config must not be able to flip the
    // config object and keep calling. The guard is read per invoke.
    const mutable = { ...DEMO };
    const provider = remoteProvider(mutable, KEY_ENV);
    fetchMock.mockResolvedValue(vendorToolCall("get_leg_state", { leg_id: "L-C1-AM" }));
    await provider.invoke(call());
    expect(fetchMock).toHaveBeenCalledTimes(1);

    mutable.demoDataOnly = false;
    await expect(provider.invoke(call())).rejects.toThrow(RemoteProviderNotEnabled);
    expect(fetchMock).toHaveBeenCalledTimes(1); // no second call
  });

  it("explains itself: which setting, which value, and why it fails shut", () => {
    try {
      remoteProvider(UNCONFIRMED, {});
      expect.unreachable();
    } catch (e) {
      const message = String(e);
      expect(message).toContain(DEMO_DATA_ONLY_ENV_VAR);
      expect(message).toContain(DEMO_DATA_ONLY_REQUIRED_VALUE);
      expect(message).toMatch(/zero-data-retention/);
      expect(message).toMatch(/no BAA/);
    }
  });
});

/* ───────────────── 2. the model chain: backup model, then a refusal ───────────────── */

describe("model chain", () => {
  it("tries the primary first, with the model id from config", async () => {
    fetchMock.mockResolvedValue(vendorToolCall("cancel_attendance_or_leg", CANCEL_ARGS));
    const provider = remoteProvider(DEMO, KEY_ENV);
    await provider.invoke(call());
    expect(bodyOf(0).model).toBe(DEMO.model);
    expect(provider.attempts).toEqual([{ model: DEMO.model, status: 200, ok: true, failure: null }]);
  });

  it("on 429 tries the backup model, and succeeds there", async () => {
    fetchMock
      .mockResolvedValueOnce(vendorStatus(RATE_LIMITED))
      .mockResolvedValueOnce(vendorToolCall("get_leg_state", { leg_id: "L-C1-AM" }));
    const provider = remoteProvider(DEMO, KEY_ENV);
    const body = await provider.invoke(call());

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect([bodyOf(0).model, bodyOf(1).model]).toEqual([DEMO.model, DEMO.backupModel]);
    expect(body.tool_calls![0].name).toBe("get_leg_state");
    expect(provider.attempts.map((a) => [a.model, a.failure])).toEqual([
      [DEMO.model, "rate_limited"],
      [DEMO.backupModel, null],
    ]);
  });

  it("on 429 from both models refuses, and answers in no other way", async () => {
    fetchMock.mockResolvedValue(vendorStatus(RATE_LIMITED));
    const provider = remoteProvider(DEMO, KEY_ENV);

    await expect(provider.invoke(call())).rejects.toThrow(RemoteProviderUnavailable);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // Both attempts are recorded as rate limits, and *no* body came back: the founder's rule
    // (2026-10-17) means a dead vendor produces a refusal, not a tool call somebody else made up.
    expect(provider.attempts.map((a) => a.failure)).toEqual(["rate_limited", "rate_limited"]);
  });

  it.each([
    ["a 500", () => fetchMock.mockResolvedValue(vendorStatus(500)), "http_error"],
    ["a 401", () => fetchMock.mockResolvedValue(vendorStatus(401)), "http_error"],
    ["a network error", () => fetchMock.mockRejectedValue(new TypeError("fetch failed")), "network_error"],
    [
      "a malformed body",
      () => fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ unexpected: true }) }),
      "malformed_body",
    ],
    [
      "a body that is not JSON at all",
      () =>
        fetchMock.mockResolvedValue({
          ok: true,
          status: 200,
          json: async () => {
            throw new SyntaxError("Unexpected token <");
          },
        }),
      "network_error",
    ],
  ])("treats %s as a provider error: backup, then a refusal", async (_label, arrange, failure) => {
    arrange();
    const provider = remoteProvider(DEMO, KEY_ENV);

    await expect(provider.invoke(call())).rejects.toThrow(RemoteProviderUnavailable);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(provider.attempts.map((a) => a.failure)).toEqual([failure, failure]);
  });

  it("maps its own timeout to a timeout, and refuses after both attempts", async () => {
    const quick = loadAgentConfig(DEMO_ENV, { requestTimeoutMs: 5 });
    // A vendor that never answers: the request settles only when our AbortController fires.
    fetchMock.mockImplementation(
      (_url: string, init: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () => {
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          });
        }),
    );
    const provider = remoteProvider(quick, KEY_ENV);
    await expect(provider.invoke(call())).rejects.toThrow(RemoteProviderUnavailable);
    expect(provider.attempts.map((a) => a.failure)).toEqual(["timeout", "timeout"]);
  });

  it("the exhausted chain's error classifies every attempt and quotes nothing", async () => {
    fetchMock.mockResolvedValue(vendorStatus(RATE_LIMITED));
    const provider = remoteProvider(DEMO, KEY_ENV);
    await expect(provider.invoke(call())).rejects.toThrow(RemoteProviderUnavailable);
    // The message classifies every attempt and quotes neither the prompt nor the vendor's text.
    try {
      await provider.invoke(call());
      expect.unreachable();
    } catch (e) {
      expect(String(e)).toContain("rate_limited");
      expect(String(e)).toContain(String(RATE_LIMITED));
      expect(String(e)).not.toContain(SMS);
      expect(String(e)).not.toContain(PLACEHOLDER_KEY);
    }
  });

  it("tries one model when the primary and the backup are the same id", async () => {
    const same = loadAgentConfig(DEMO_ENV, { backupModel: DEMO.model });
    expect(modelChain(same)).toEqual([DEMO.model]);
    fetchMock.mockResolvedValue(vendorStatus(RATE_LIMITED));
    await expect(remoteProvider(same, KEY_ENV).invoke(call())).rejects.toThrow(RemoteProviderUnavailable);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("the chain is the two configured models, in order", () => {
    expect(modelChain(DEMO)).toEqual([DEMO.model, DEMO.backupModel]);
    // Both are on the allow-list, which config refused to parse otherwise.
    for (const m of modelChain(DEMO)) expect(DEMO.modelAllowList).toContain(m);
  });
});

/* ───────────────── 3. the outbound body and the key ───────────────── */

describe("outbound request", () => {
  beforeEach(() => {
    fetchMock.mockResolvedValue(vendorToolCall("get_leg_state", { leg_id: "L-C1-AM" }));
  });

  it("POSTs to the configured base URL and allow-listed endpoint", async () => {
    await remoteProvider(DEMO, KEY_ENV).invoke(call());
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${DEMO.baseUrl}${DEMO.endpointAllowList[0]}`);
    expect(init.method).toBe("POST");
    expect(DEMO.endpointAllowList).toContain(DEMO.endpointAllowList[0]);
  });

  it("sends allow_fallbacks:false and require_parameters:true on every request (§2.5)", async () => {
    fetchMock.mockReset().mockResolvedValue(vendorStatus(RATE_LIMITED));
    await expect(remoteProvider(DEMO, KEY_ENV).invoke(call())).rejects.toThrow(RemoteProviderUnavailable);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const nth of [0, 1]) {
      // allow_fallbacks:false matters twice over: OpenRouter may not silently route to a model
      // that is not the one named, which would make the audit row and the allow-list a lie.
      expect(bodyOf(nth).provider).toMatchObject({ allow_fallbacks: false, require_parameters: true });
    }
  });

  it("every model it names is one the config allow-list admits", async () => {
    fetchMock.mockReset().mockResolvedValue(vendorStatus(RATE_LIMITED));
    await expect(remoteProvider(DEMO, KEY_ENV).invoke(call())).rejects.toThrow(RemoteProviderUnavailable);
    const models = fetchMock.mock.calls.map((_c, i) => bodyOf(i).model);
    expect(models).toEqual([DEMO.model, DEMO.backupModel]);
    for (const m of models) expect(DEMO.modelAllowList).toContain(m);
  });

  it("asks for the ZDR block only when the call carries zdr, and never invents one", async () => {
    await remoteProvider(DEMO, KEY_ENV).invoke(call({ zdr: true }));
    expect(bodyOf(0).provider).toMatchObject({ zdr: true, data_collection: "deny" });

    // The free demo endpoints have no ZDR to ask for, and OpenRouter's Google toggle blocks Gemma
    // free outright (research §2A.4), so the demo deployment sets AGENT_MODEL_ZDR=0 and the
    // demo-data guard is what protects the data instead.
    fetchMock.mockClear();
    await remoteProvider(DEMO, KEY_ENV).invoke(call({ zdr: false }));
    expect(bodyOf(0).provider.zdr).toBeUndefined();
    expect(bodyOf(0).provider.data_collection).toBeUndefined();
    expect(bodyOf(0).provider).toMatchObject({ allow_fallbacks: false, require_parameters: true });
  });

  it("declares the offered tools as JSON-schema functions and requires one (§11.2)", async () => {
    await remoteProvider(DEMO, KEY_ENV).invoke(call());
    const body = bodyOf(0);
    expect(body.tool_choice).toBe("required");
    expect(body.tools.map((t: { function: { name: string } }) => t.function.name)).toEqual([
      "get_leg_state",
      "cancel_attendance_or_leg",
    ]);
    expect(body.tools[0]).toMatchObject({ type: "function" });
    expect(body.tools[0].function.parameters).toBeTypeOf("object");
  });

  it("puts the key in the authorization header and nowhere else", async () => {
    await remoteProvider(DEMO, KEY_ENV).invoke(call());
    const [url, init] = fetchMock.mock.calls[0];
    expect(init.headers.authorization).toBe(`Bearer ${PLACEHOLDER_KEY}`);
    // Not in the URL — a query param would land in the vendor's access logs and in ours.
    expect(url).not.toContain(PLACEHOLDER_KEY);
    expect(init.body).not.toContain(PLACEHOLDER_KEY);
  });

  it("exposes the key by env var name only, never as a property", async () => {
    const provider = remoteProvider(DEMO, KEY_ENV);
    expect(provider.apiKeyEnvVar).toBe("OPENROUTER_API_KEY");
    await provider.invoke(call());
    expect(JSON.stringify({ provider, attempts: provider.attempts })).not.toContain(PLACEHOLDER_KEY);
  });

  it("records attempts as codes and model ids only — no prompt, no vendor text", async () => {
    fetchMock.mockReset().mockResolvedValue(vendorStatus(RATE_LIMITED));
    const provider = remoteProvider(DEMO, KEY_ENV);
    await expect(provider.invoke(call())).rejects.toThrow(RemoteProviderUnavailable);
    const serialized = JSON.stringify(provider.attempts);
    expect(serialized).not.toContain(SMS);
    expect(serialized).not.toContain("site=S1");
    expect(serialized).not.toContain("nope"); // the vendor's own error message
    expect(serialized).not.toContain(PLACEHOLDER_KEY);
  });
});

/* ───────────────── 4. normalize(): the vendor envelope, mapped ───────────────── */

describe("normalize", () => {
  it("maps a tool call, keeping arguments untouched for the gateway to coerce", () => {
    const asString = normalize({
      choices: [{ message: { tool_calls: [{ function: { name: "get_leg_state", arguments: '{"leg_id":"L-C1-AM"}' } }] }, finish_reason: "tool_calls" }],
    });
    // A vendor may send arguments as an object or a JSON string; gateway.coerceArgs handles both,
    // so parsing here would be a second, divergent implementation of the same rule.
    expect(asString!.tool_calls![0].arguments).toBe('{"leg_id":"L-C1-AM"}');
    expect(asString!.finish_reason).toBe("tool_calls");
  });

  it("returns a prose-only response as-is, for the gateway to refuse", () => {
    // Free text is a model contract violation and belongs in the audit log as REJECTED_FREE_TEXT —
    // not something an adapter should paper over.
    const body = normalize({ choices: [{ message: { content: "I think the van is late" }, finish_reason: "stop" }] });
    expect(body).toEqual({ content: "I think the van is late", finish_reason: "stop" });
    expect(body!.tool_calls).toBeUndefined();
  });

  it("drops a tool call with no usable name rather than inventing one", () => {
    const body = normalize({ choices: [{ message: { tool_calls: [{ function: { arguments: {} } }, { nonsense: 1 }] } }] });
    expect(body!.tool_calls).toBeUndefined();
  });

  it.each([
    ["null", null],
    ["a string", "not an envelope"],
    ["no choices", { id: "x" }],
    ["empty choices", { choices: [] }],
    ["choices of the wrong type", { choices: "nope" }],
  ])("refuses %s as unparseable, so the chain moves on", (_label, raw) => {
    expect(normalize(raw)).toBeNull();
  });

  it("tolerates a choice with no message at all", () => {
    expect(normalize({ choices: [{ finish_reason: "stop" }] })).toEqual({ content: null, finish_reason: "stop" });
  });
});

/* ───────────────── 5. through the real gateway ───────────────── */

describe("the live provider behind the real gateway", () => {
  it("an accepted vendor tool call becomes an accepted gateway result, audited by hash", async () => {
    fetchMock.mockResolvedValue(vendorToolCall("cancel_attendance_or_leg", CANCEL_ARGS));
    const gateway = createGateway(remoteProvider(DEMO, KEY_ENV), DEMO);
    const result = await gateway.complete({ runId: "RUN-LIVE", prompt: PROMPT });

    expect(result.call).toMatchObject({ tool: "cancel_attendance_or_leg", tier: "auto" });
    expect(gateway.auditLog.at(-1)).toMatchObject({
      outcome: "ACCEPTED",
      providerKind: "remote",
      model: DEMO.model,
      provider: "openrouter",
    });
    const log = JSON.stringify(gateway.auditLog);
    expect(log).not.toContain(SMS);
    expect(log).not.toContain(PLACEHOLDER_KEY);
  });

  it("a rate-limited run ends in an audited PROVIDER_ERROR, and no tool call at all", async () => {
    // What used to happen here was a keyword-parser escalation. The founder's 2026-10-17 rule
    // forbids that: the vendor is down, so the turn is refused and the run loop raises one staff
    // alert instead (`agent/staff-alert.ts`). The audit row still exists and still names no prose.
    fetchMock.mockResolvedValue(vendorStatus(RATE_LIMITED));
    const gateway = createGateway(remoteProvider(DEMO, KEY_ENV), DEMO);
    await expect(gateway.complete({ runId: "RUN-429", prompt: PROMPT })).rejects.toMatchObject({
      outcome: "PROVIDER_ERROR",
    });
    expect(gateway.auditLog.at(-1)).toMatchObject({ outcome: "PROVIDER_ERROR", tool: null, tier: null });
    expect(JSON.stringify(gateway.auditLog)).not.toContain(SMS);
  });

  it("vendor prose is refused by the gateway, not smoothed over by the adapter", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: "sure, I texted them" }, finish_reason: "stop" }] }),
    });
    const gateway = createGateway(remoteProvider(DEMO, KEY_ENV), DEMO);
    await expect(gateway.complete({ runId: "RUN-PROSE", prompt: PROMPT })).rejects.toMatchObject({
      outcome: "REJECTED_FREE_TEXT",
    });
    expect(JSON.stringify(gateway.auditLog)).not.toContain("I texted them");
  });

  it("offers the whole §11.2 catalog when the gateway does, and no tool outside it", async () => {
    fetchMock.mockResolvedValue(vendorToolCall("get_leg_state", { leg_id: "L-C1-AM" }));
    const gateway = createGateway(remoteProvider(DEMO, KEY_ENV), DEMO);
    await gateway.complete({ runId: "RUN-TOOLS", prompt: PROMPT });
    const names = bodyOf(0).tools.map((t: { function: { name: string } }) => t.function.name);
    expect(names).toEqual([...TOOL_NAMES]);
  });
});

/* ───────────────── 6. the endpoint allow-list, re-checked where it is used ───────────────── */

describe("endpoint allow-list on the outbound path", () => {
  it("refuses an endpoint off the allow-list, without calling fetch", async () => {
    // The gateway checks this too. It is checked again here because this adapter is the only
    // thing in the module that leaves the building, and a caller can hold it directly.
    const provider = remoteProvider(DEMO, KEY_ENV);
    await expect(provider.invoke(call({ endpoint: "/api/v1/responses" }))).rejects.toThrow(RemoteEndpointRefused);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["/api/v1/files", "/v1/batches", "/api/v1/code-exec", "/v1/web_search", "/v1/fine-tuning/jobs"])(
    "refuses the excluded family %s even if it were somehow allow-listed",
    async (endpoint) => {
      // `loadAgentConfig` refuses to parse such an allow-list at all — asserted here, because it
      // is the stronger guarantee — so the object is built past the schema to reach the second
      // check: the one that re-tests the excluded families rather than the configured list.
      expect(() => loadAgentConfig(DEMO_ENV, { endpointAllowList: [endpoint] })).toThrow(AgentConfigError);

      const cfg = { ...DEMO, endpointAllowList: [endpoint] as [string, ...string[]] };
      const provider = remoteProvider(cfg, KEY_ENV);
      await expect(provider.invoke(call({ endpoint }))).rejects.toThrow(RemoteEndpointRefused);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("allows the one completion endpoint the agent needs", async () => {
    fetchMock.mockResolvedValue(vendorToolCall("get_leg_state", { leg_id: "L-C1-AM" }));
    await remoteProvider(DEMO, KEY_ENV).invoke(call({ endpoint: DEMO.endpointAllowList[0] }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

/* ───────────────── 7. the guard's other two conditions, on the adapter ───────────────── */

describe("the demo-data guard's other two conditions", () => {
  it("refuses a PHI boot data class, with the confirmation set and a key present", () => {
    // `AGENT_DEMO_DATA_ONLY=true` is an assertion about the data; `APP_DATA_CLASS` is what the
    // deployment says it holds. When they disagree, the assertion is the one that is wrong.
    const env = { ...KEY_ENV, [DATA_CLASS_ENV_VAR]: "PHI" };
    expect(loadAgentConfig(env).demoDataOnly).toBe(true);
    expect(() => remoteProvider(loadAgentConfig(env), env)).toThrow(RemoteProviderNotEnabled);
    expect(() => remoteProvider(loadAgentConfig(env), env)).toThrow(new RegExp(DATA_CLASS_ENV_VAR));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a non-synthetic dataMode, with the confirmation set and a key present", () => {
    const env = { ...KEY_ENV, AGENT_DATA_MODE: "PHI" };
    const cfg = loadAgentConfig(env);
    expect([cfg.demoDataOnly, cfg.dataMode]).toEqual([true, "PHI"]);
    expect(() => remoteProvider(cfg, env)).toThrow(RemoteProviderNotEnabled);
    expect(() => remoteProvider(cfg, env)).toThrow(/not\s+SYNTHETIC/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("cannot be opened by a config override, so no provider is built that way either", () => {
    // The route a test helper would take to "just enable it" is a config error, not a provider.
    expect(() => loadAgentConfig({}, { demoDataOnly: true })).toThrow(AgentConfigError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("re-checks both on every call, not only at wiring time", async () => {
    fetchMock.mockResolvedValue(vendorToolCall("get_leg_state", { leg_id: "L-C1-AM" }));
    // A mutable env object, which is what `process.env` is: the data class can change under a
    // provider that was built when it was still SYNTHETIC.
    const env: Record<string, string | undefined> = { ...KEY_ENV };
    const provider = remoteProvider(loadAgentConfig(env), env);
    await provider.invoke(call());
    expect(fetchMock).toHaveBeenCalledTimes(1);

    env[DATA_CLASS_ENV_VAR] = "PHI";
    await expect(provider.invoke(call())).rejects.toThrow(RemoteProviderNotEnabled);
    expect(fetchMock).toHaveBeenCalledTimes(1); // no second call
  });
});

/* ───────────────── 8. the destination, checked before any Bearer key is sent (S3) ───────────────── */

describe("base URL: https, and a host this deployment allow-listed", () => {
  /** Past the schema, which refuses such a value outright, to reach the adapter's own check. */
  const withBaseUrl = (baseUrl: string) => ({ ...DEMO, baseUrl });

  it.each([
    ["plain http on the right host", "http://openrouter.ai"],
    ["plain http on another host", "http://vendor-b.example"],
    ["a non-HTTP scheme", "ftp://openrouter.ai"],
  ])("refuses %s before a key is read or a request sent", (_label, baseUrl) => {
    // `loadAgentConfig` will not parse it at all — the stronger guarantee, asserted first.
    expect(() => loadAgentConfig({ ...DEMO_ENV, AGENT_BASE_URL: baseUrl })).toThrow(AgentConfigError);

    expect(() => remoteProvider(withBaseUrl(baseUrl), KEY_ENV)).toThrow(RemoteBaseUrlRefused);
    expect(() => remoteProvider(withBaseUrl(baseUrl), KEY_ENV)).toThrow(/scheme/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["another vendor", "https://vendor-b.example"],
    ["a lookalike subdomain", "https://openrouter.ai.evil.example"],
    ["the right host on another port", "https://openrouter.ai:8443"],
  ])("refuses %s, which is off the host allow-list", (_label, baseUrl) => {
    expect(() => loadAgentConfig({ ...DEMO_ENV, AGENT_BASE_URL: baseUrl })).toThrow(AgentConfigError);

    expect(() => remoteProvider(withBaseUrl(baseUrl), KEY_ENV)).toThrow(RemoteBaseUrlRefused);
    expect(() => remoteProvider(withBaseUrl(baseUrl), KEY_ENV)).toThrow(/host allow-list/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends no Bearer header anywhere when the destination is refused", () => {
    // The claim that matters: the key is not read, not put in a header, and not sent to the
    // unvetted host — the refusal lands before any of that exists.
    for (const baseUrl of ["http://openrouter.ai", "https://vendor-b.example"]) {
      try {
        remoteProvider(withBaseUrl(baseUrl), KEY_ENV);
        expect.unreachable();
      } catch (e) {
        expect(String(e)).not.toContain(PLACEHOLDER_KEY);
        expect(String(e)).not.toMatch(/Bearer/);
      }
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a destination that changed under a wired provider, per call", async () => {
    fetchMock.mockResolvedValue(vendorToolCall("get_leg_state", { leg_id: "L-C1-AM" }));
    const mutable = { ...DEMO };
    const provider = remoteProvider(mutable, KEY_ENV);
    await provider.invoke(call());
    expect(fetchMock).toHaveBeenCalledTimes(1);

    mutable.baseUrl = "http://openrouter.ai";
    await expect(provider.invoke(call())).rejects.toThrow(RemoteBaseUrlRefused);
    expect(fetchMock).toHaveBeenCalledTimes(1); // the key went nowhere new
  });

  it("the guard still comes first: an unconfirmed deployment is refused for that, not for its URL", () => {
    // Order matters for the operator reading the log: the missing confirmation is the thing to
    // fix, and it must not be masked by a complaint about the destination.
    expect(() => remoteProvider({ ...UNCONFIRMED, baseUrl: "http://openrouter.ai" }, KEY_ENV)).toThrow(
      RemoteProviderNotEnabled,
    );
  });

  it("POSTs to the allow-listed origin when it is one", async () => {
    fetchMock.mockResolvedValue(vendorToolCall("get_leg_state", { leg_id: "L-C1-AM" }));
    await remoteProvider(DEMO, KEY_ENV).invoke(call());
    expect(fetchMock.mock.calls[0][0]).toBe(`${DEMO.baseUrl}${DEMO.endpointAllowList[0]}`);
    expect(new URL(DEMO.baseUrl).protocol).toBe("https:");
    expect(DEMO.baseUrlHostAllowList).toContain(new URL(DEMO.baseUrl).host);
  });
});

/* ───────────────── 9. the model allow-list, re-checked on the outbound path ───────────────── */

describe("model allow-list on the outbound path", () => {
  it("refuses a primary that is off the allow-list, without calling fetch", async () => {
    // Config refuses this at parse time — asserted first, because it is the stronger guarantee —
    // so the object is built past the schema to reach the adapter's own check: the one on the
    // file that actually puts a model id in a body and posts it.
    expect(() => loadAgentConfig({ ...DEMO_ENV, AGENT_MODEL: "vendor-b/some-model" })).toThrow(AgentConfigError);

    const cfg = { ...DEMO, model: "vendor-b/some-model" };
    const provider = remoteProvider(cfg, KEY_ENV);
    await expect(provider.invoke(call())).rejects.toThrow(RemoteModelRefused);
    await expect(provider.invoke(call())).rejects.toThrow(/model allow-list/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses an off-list backup before spending the primary's call", async () => {
    // The whole chain is checked before the first request: a tampered config sends nothing at
    // all rather than one call on the model that happened to still be allowed.
    fetchMock.mockResolvedValue(vendorToolCall("get_leg_state", { leg_id: "L-C1-AM" }));
    const cfg = { ...DEMO, backupModel: "vendor-b/some-model" };
    await expect(remoteProvider(cfg, KEY_ENV).invoke(call())).rejects.toThrow(RemoteModelRefused);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a shrunken allow-list that no longer admits the configured models", async () => {
    const cfg = { ...DEMO, modelAllowList: ["vendor-c/compliant"] as [string, ...string[]] };
    const provider = remoteProvider(cfg, KEY_ENV);
    await expect(provider.invoke(call())).rejects.toThrow(RemoteModelRefused);
    // Both models are named, so the log says what to fix rather than only the first thing wrong.
    await expect(provider.invoke(call())).rejects.toThrow(new RegExp(DEMO.backupModel));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("names the model and no key, prompt or vendor text in the refusal", async () => {
    const cfg = { ...DEMO, model: "vendor-b/some-model" };
    try {
      await remoteProvider(cfg, KEY_ENV).invoke(call());
      expect.unreachable();
    } catch (e) {
      expect(String(e)).toContain("vendor-b/some-model");
      expect(String(e)).not.toContain(PLACEHOLDER_KEY);
      expect(String(e)).not.toContain(SMS);
    }
  });

  it("lets the configured chain through, and every id it posts is on the list", async () => {
    fetchMock.mockResolvedValue(vendorStatus(RATE_LIMITED));
    await expect(remoteProvider(DEMO, KEY_ENV).invoke(call())).rejects.toThrow(RemoteProviderUnavailable);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const nth of [0, 1]) expect(DEMO.modelAllowList).toContain(bodyOf(nth).model);
  });
});

/* ───────── 10. the endpoint is the other half of the destination (S2) ───────── */

/**
 * Endpoints that name a destination of their own, each one a string a deployment could have put in
 * `AGENT_ENDPOINT_ALLOW_LIST`. Pasted onto an allow-listed origin — which is how this adapter used
 * to build its URL — every one of them is a request to somewhere nobody vetted, with the founder's
 * key in an `authorization` header and nothing about the configured base URL having changed to say
 * so. These are the ones that still move the destination once the URL *parser* has resolved them,
 * so the check on the finished URL has to catch them on its own.
 */
const DESTINATION_MOVING_ENDPOINTS: [label: string, endpoint: string][] = [
  ["a scheme-relative authority", "//evil.example/api/v1/chat/completions"],
  ["userinfo behind a scheme-relative authority", "//user:pass@evil.example/api/v1/chat/completions"],
  ["a backslash the URL parser folds to a slash", "/\\evil.example/api/v1/chat/completions"],
  ["a leading pair of backslashes", "\\\\evil.example/api/v1/chat/completions"],
  ["an absolute URL of its own", "https://evil.example/api/v1/chat/completions"],
  ["plain http on the allow-listed host", "http://openrouter.ai/api/v1/chat/completions"],
  ["credentials behind the allow-listed host", "https://user:pass@openrouter.ai/api/v1/chat/completions"],
];

/**
 * The two the URL parser resolves *into* the allow-listed host — harmless once the URL is built,
 * and still refused, because an endpoint nobody configured as a path is not an endpoint.
 */
const PATH_RESOLVED_ENDPOINTS: [label: string, endpoint: string][] = [
  ["userinfo, which turns the allow-listed origin into a username", "@evil.example/api/v1/chat/completions"],
  ["a bare host", "evil.example/api/v1/chat/completions"],
];

const HOST_SMUGGLING_ENDPOINTS = [...DESTINATION_MOVING_ENDPOINTS, ...PATH_RESOLVED_ENDPOINTS];

describe("the endpoint cannot move the destination", () => {
  it.each(HOST_SMUGGLING_ENDPOINTS)("refuses %s, with no request made at all", async (_label, endpoint) => {
    // `loadAgentConfig` will not parse such an allow-list — the stronger guarantee, asserted
    // first — so the object is built past the schema to reach the adapter's own check, the one on
    // the file that actually joins the two halves together and posts the result.
    expect(() => loadAgentConfig(DEMO_ENV, { endpointAllowList: [endpoint] })).toThrow(AgentConfigError);

    const cfg = { ...DEMO, endpointAllowList: [endpoint] as [string, ...string[]] };
    const provider = remoteProvider(cfg, KEY_ENV);
    // On the allow-list, and refused anyway: membership is not the question, shape is.
    expect(cfg.endpointAllowList).toContain(endpoint);
    await expect(provider.invoke(call({ endpoint }))).rejects.toThrow(RemoteEndpointRefused);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(HOST_SMUGGLING_ENDPOINTS)("sends no Bearer header anywhere for %s", async (_label, endpoint) => {
    // The claim that matters, stated separately from the class: nothing left the building, and
    // the refusal itself carries neither the key nor the prompt.
    const cfg = { ...DEMO, endpointAllowList: [endpoint] as [string, ...string[]] };
    try {
      await remoteProvider(cfg, KEY_ENV).invoke(call({ endpoint }));
      expect.unreachable();
    } catch (e) {
      expect(String(e)).not.toContain(PLACEHOLDER_KEY);
      expect(String(e)).not.toMatch(/Bearer/);
      expect(String(e)).not.toContain(SMS);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(DESTINATION_MOVING_ENDPOINTS)(
    "the built-URL check refuses %s on its own, with the path gate out of the way",
    (_label, endpoint) => {
      // The backstop, exercised directly. It is the thing standing there if the path gate above
      // is ever loosened, and it refuses before `fetch` is reached, keeping its own class all the
      // way out: a key that nearly went to the wrong host is a different accident from a dead
      // vendor, and it must not be recorded as one more failed attempt in the chain.
      expect(() => verifiedRequestUrl(DEMO, endpoint)).toThrow(RemoteRequestUrlRefused);
      try {
        verifiedRequestUrl(DEMO, endpoint);
        expect.unreachable();
      } catch (e) {
        expect(String(e)).toContain("request URL");
        expect(String(e)).not.toContain(PLACEHOLDER_KEY);
      }
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("the @-endpoint is neutralised by the build itself: the parser keeps the host", () => {
    // Belt: the path gate refuses it. Braces: resolved by the URL parser instead of concatenated,
    // the same string is a path segment on the host the deployment allow-listed — which is why
    // this adapter builds its URL and no longer pastes two strings together.
    const smuggled = "@evil.example/api/v1/chat/completions";
    expect(new URL(`${DEMO.baseUrl}${smuggled}`).host).toBe("evil.example");
    expect(new URL(verifiedRequestUrl(DEMO, smuggled)).host).toBe(new URL(DEMO.baseUrl).host);
  });

  it("the URL it hands to fetch is https, has no userinfo, and is on the host allow-list", async () => {
    fetchMock.mockResolvedValue(vendorStatus(RATE_LIMITED));
    await expect(remoteProvider(DEMO, KEY_ENV).invoke(call())).rejects.toThrow(RemoteProviderUnavailable);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [url] of fetchMock.mock.calls) {
      const parsed = new URL(url as string);
      expect(parsed.protocol).toBe("https:");
      expect(parsed.username).toBe("");
      expect(parsed.password).toBe("");
      expect(DEMO.baseUrlHostAllowList).toContain(parsed.host);
    }
  });

  it("a trailing slash on the base URL does not become a // path: the URL is built, not pasted", async () => {
    // This is also the test that holds the *build* down. For a bare origin and a plain path,
    // concatenation and resolution agree, so nothing would notice a quiet return to
    // `${baseUrl}${endpoint}`; a trailing slash is where the two differ, and the parser is the one
    // that gets it right. `AGENT_BASE_URL` with a trailing slash is a config this module accepts.
    const slashed = loadAgentConfig({ ...DEMO_ENV, AGENT_BASE_URL: `${DEMO.baseUrl}/` });
    expect(slashed.baseUrl).toBe(`${DEMO.baseUrl}/`);
    fetchMock.mockResolvedValue(vendorToolCall("get_leg_state", { leg_id: "L-C1-AM" }));
    await remoteProvider(slashed, KEY_ENV).invoke(call());
    expect(fetchMock.mock.calls[0][0]).toBe(`${DEMO.baseUrl}${DEMO.endpointAllowList[0]}`);
  });

  it("the allow-listed path still goes where it always did", async () => {
    // The fix is not allowed to move the real request: the built URL is byte-for-byte the one the
    // concatenation produced for a plain path on an origin.
    fetchMock.mockResolvedValue(vendorToolCall("get_leg_state", { leg_id: "L-C1-AM" }));
    await remoteProvider(DEMO, KEY_ENV).invoke(call());
    expect(fetchMock.mock.calls[0][0]).toBe(`${DEMO.baseUrl}${DEMO.endpointAllowList[0]}`);
    expect(verifiedRequestUrl(DEMO, DEMO.endpointAllowList[0])).toBe(
      `${DEMO.baseUrl}${DEMO.endpointAllowList[0]}`,
    );
  });
});
