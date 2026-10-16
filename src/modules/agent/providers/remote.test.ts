/**
 * The live OpenRouter adapter (B-08 slice 5). `fetch` is stubbed in every test here — nothing in
 * this file, or anywhere in the suite, reaches a real vendor.
 *
 * Four things are worth proving, in descending order of how much damage getting them wrong does:
 *
 *  1. **The demo-data-only guard fails shut, and refuses without calling fetch.** Missing setting,
 *     wrong value, right value. None of the free endpoints offer zero data retention and
 *     OpenRouter has no BAA, so this guard is the only thing keeping real family data away from
 *     them. A refusal that had already sent the body would be no guard at all.
 *  2. **The fallback chain.** 429 on the primary tries the backup; failure on both degrades to the
 *     §18.1 keyword parser. Any other provider error behaves the same way, because a free endpoint
 *     has more ways to fail than a rate limit.
 *  3. **The outbound body.** The model id comes from config and is on the allow-list,
 *     `allow_fallbacks:false` and `require_parameters:true` are on every request, and the key is
 *     in the authorization header and nowhere else.
 *  4. **Nothing leaks.** No key value and no prompt text in an error, an attempt record or a
 *     thrown stack — TEST-SEC-01 on the path that actually leaves the building.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEMO_DATA_ONLY_ENV_VAR, DEMO_DATA_ONLY_REQUIRED_VALUE, loadAgentConfig } from "../config";
import { createGateway } from "../gateway";
import { wrapUntrusted } from "../policy";
import { sha256Hex } from "../redact";
import { TOOL_NAMES, toolDeclarations } from "../tools";
import {
  RATE_LIMITED,
  RemoteProviderNotEnabled,
  RemoteProviderUnavailable,
  modelChain,
  normalize,
  remoteProvider,
} from "./remote";

/** A placeholder, low entropy, obviously not a credential. The real one is supplied by the founder. */
const PLACEHOLDER_KEY = "placeholder-not-a-key";
const KEY_ENV = { OPENROUTER_API_KEY: PLACEHOLDER_KEY };

/** The config a demo deployment has: the guard confirmed, everything else at its default. */
const DEMO = loadAgentConfig({ [DEMO_DATA_ONLY_ENV_VAR]: DEMO_DATA_ONLY_REQUIRED_VALUE });
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

/* ───────────────── 2. the fallback chain: backup model, then keyword ───────────────── */

describe("fallback chain", () => {
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
    expect(body.fellBackToKeyword).toBeUndefined();
    expect(provider.attempts.map((a) => [a.model, a.failure])).toEqual([
      [DEMO.model, "rate_limited"],
      [DEMO.backupModel, null],
    ]);
  });

  it("on 429 from both models falls back to the keyword parser", async () => {
    fetchMock.mockResolvedValue(vendorStatus(RATE_LIMITED));
    const provider = remoteProvider(DEMO, KEY_ENV);
    const body = await provider.invoke(call());

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(body.fellBackToKeyword).toBe(true);
    expect(body.finish_reason).toBe("keyword_fallback");
    // "wont need the AM van" is an ABSENT, and the fallback escalates rather than cancelling.
    expect(body.tool_calls![0].name).toBe("escalate_exception");
    expect(body.attempts!.map((a) => a.failure)).toEqual(["rate_limited", "rate_limited"]);
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
  ])("treats %s as a provider error: backup, then keyword", async (_label, arrange, failure) => {
    arrange();
    const provider = remoteProvider(DEMO, KEY_ENV);
    const body = await provider.invoke(call());

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(body.fellBackToKeyword).toBe(true);
    expect(body.attempts!.map((a) => a.failure)).toEqual([failure, failure]);
  });

  it("maps its own timeout to a timeout, and still degrades", async () => {
    const quick = loadAgentConfig(
      { [DEMO_DATA_ONLY_ENV_VAR]: DEMO_DATA_ONLY_REQUIRED_VALUE },
      { requestTimeoutMs: 5 },
    );
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
    const body = await provider.invoke(call());
    expect(body.attempts!.map((a) => a.failure)).toEqual(["timeout", "timeout"]);
    expect(body.fellBackToKeyword).toBe(true);
  });

  it("without the keyword fallback, exhausting the chain throws a classed error", async () => {
    fetchMock.mockResolvedValue(vendorStatus(RATE_LIMITED));
    const provider = remoteProvider(DEMO, KEY_ENV, { keywordFallback: false });
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
    const same = loadAgentConfig(
      { [DEMO_DATA_ONLY_ENV_VAR]: DEMO_DATA_ONLY_REQUIRED_VALUE },
      { backupModel: DEMO.model },
    );
    expect(modelChain(same)).toEqual([DEMO.model]);
    fetchMock.mockResolvedValue(vendorStatus(RATE_LIMITED));
    const body = await remoteProvider(same, KEY_ENV).invoke(call());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(body.fellBackToKeyword).toBe(true);
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
    await remoteProvider(DEMO, KEY_ENV).invoke(call());
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const nth of [0, 1]) {
      // allow_fallbacks:false matters twice over: OpenRouter may not silently route to a model
      // that is not the one named, which would make the audit row and the allow-list a lie.
      expect(bodyOf(nth).provider).toMatchObject({ allow_fallbacks: false, require_parameters: true });
    }
  });

  it("every model it names is one the config allow-list admits", async () => {
    fetchMock.mockReset().mockResolvedValue(vendorStatus(RATE_LIMITED));
    await remoteProvider(DEMO, KEY_ENV).invoke(call());
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
    await provider.invoke(call());
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

  it("a rate-limited run still ends in an audited staff escalation", async () => {
    fetchMock.mockResolvedValue(vendorStatus(RATE_LIMITED));
    const gateway = createGateway(remoteProvider(DEMO, KEY_ENV), DEMO);
    const result = await gateway.complete({ runId: "RUN-429", prompt: PROMPT });
    expect(result.call.tool).toBe("escalate_exception");
    expect(gateway.auditLog.at(-1)).toMatchObject({ outcome: "ACCEPTED", tool: "escalate_exception" });
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
