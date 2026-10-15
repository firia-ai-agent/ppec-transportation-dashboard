/**
 * VERI-5: neither provider slice 1 ships can fall through to a real network call.
 *
 * "No network" is claimed twice in this module — FakeProvider is scripted, RecordedProvider
 * replays a cassette and throws on a miss — and both claims are only worth what they are tested
 * against. So this file proves it two ways:
 *
 *  1. Statically. Every non-test file under src/modules/agent is read and scanned, with comments
 *     stripped, for the ways code reaches the network: a `fetch(` call, an import of node:http /
 *     node:https / node:net / node:tls, a URL literal, an HTTP client package. There are none,
 *     which is also why `node:http` and `node:https` need no runtime stub: nothing imports them,
 *     and this scan fails the day something does.
 *  2. Dynamically. `fetch` is replaced with a spy that throws, and the whole seam is then driven
 *     over both providers — scripted calls, cassette hits, a cassette miss, every attack fixture.
 *     The spy must never be called. A throwing stub rather than a silent one, so a call that did
 *     happen fails the test it happened in instead of vanishing into a resolved promise.
 *
 * And the third clause of the bar: the remote-vendor placeholder, with no key in the environment,
 * fails closed with an error that names the variable it wants and nothing else.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import cassetteJson from "./fixtures/recorded-standard.json";
import { RECORDED_PROMPTS } from "./fixtures/prompts";
import { ATTACK_FIXTURES } from "./fixtures/attacks";
import { loadAgentConfig } from "./config";
import { GatewayError, createGateway } from "./gateway";
import { sha256Hex } from "./redact";
import { TOOL_NAMES } from "./tools";
import { fakeProvider, toolCall } from "./providers/fake";
import { CassetteMissError, cassetteFrom, loadCassette, recordedProvider } from "./providers/recorded";
import { RemoteProviderNotEnabled, remoteProvider } from "./providers/remote";

const CONFIG = loadAgentConfig({});
const PROMPT = "T1 site=S1 family=F1 child=C1\nT2 leg=L-C1-AM state=SCHEDULED version=3";

/* ─────────────────────────────── 1. the static scan ─────────────────────────────── */

const AGENT_DIR = path.resolve(__dirname);

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

const sourceFiles = walk(AGENT_DIR)
  .filter((f) => f.endsWith(".ts"))
  .filter((f) => !f.endsWith(".test.ts"))
  .map((f) => path.relative(AGENT_DIR, f).split(path.sep).join("/"));

/** Comments removed, so a sentence about the network is not mistaken for one. */
function code(file: string): string {
  return readFileSync(path.join(AGENT_DIR, file), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/(^|\s)\/\/.*$/, "$1"))
    .join("\n");
}

const NETWORK_PATTERNS: readonly { readonly what: string; readonly pattern: RegExp }[] = [
  { what: "a fetch() call", pattern: /\bfetch\s*\(/ },
  { what: "a node network module", pattern: /["'](?:node:)?(?:http|https|net|tls|dgram|dns|http2)["']/ },
  { what: "an absolute URL", pattern: /\bhttps?:\/\// },
  { what: "an HTTP client package", pattern: /\b(?:axios|undici|got|node-fetch|superagent|request)\b\s*(?:from|\()/ },
  { what: "a browser transport", pattern: /\b(?:XMLHttpRequest|WebSocket|EventSource|navigator\.sendBeacon)\b/ },
];

describe("VERI-5: the agent module contains no way to reach the network", () => {
  it("VERI-5 the scan finds the files it claims to scan", () => {
    expect(sourceFiles).toEqual(
      expect.arrayContaining([
        "config.ts",
        "gateway.ts",
        "policy.ts",
        "redact.ts",
        "tools.ts",
        "providers/fake.ts",
        "providers/recorded.ts",
        "providers/remote.ts",
        "providers/provider.ts",
      ]),
    );
    expect(code("config.ts")).toContain("endpointAllowList");
    // The scan reads code, not prose: remote.ts talks about HTTP at length and must still pass.
    expect(readFileSync(path.join(AGENT_DIR, "providers/remote.ts"), "utf8")).toContain("no HTTP");
  });

  it.each(NETWORK_PATTERNS.map((p) => [p.what, p.pattern] as const))("VERI-5 no file contains %s", (_what, pattern) => {
    const offenders = sourceFiles.filter((f) => pattern.test(code(f)));
    expect(offenders).toEqual([]);
  });

  it("VERI-5 the scan would notice if one arrived", () => {
    // Guards the guard: these are the shapes the patterns above exist to catch.
    const samples = [
      'await fetch("https://openrouter.ai/api/v1/chat/completions")',
      'import https from "node:https"',
      'const { request } = require("http")',
      "const xhr = new XMLHttpRequest()",
    ];
    for (const sample of samples) {
      expect(NETWORK_PATTERNS.some((p) => p.pattern.test(sample)), sample).toBe(true);
    }
  });
});

/* ─────────────────────────────── 2. the runtime stub ─────────────────────────────── */

describe("VERI-5: driving both providers with fetch stubbed to throw", () => {
  let attempted: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    attempted = vi.fn(() => {
      throw new Error("VERI-5: a provider attempted a network call");
    });
    vi.stubGlobal("fetch", attempted);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("VERI-5 FakeProvider: every catalog tool, scripted and accepted, with no call out", async () => {
    for (const tool of TOOL_NAMES) {
      const provider = fakeProvider([toolCall(tool, {})], { vendor: CONFIG.provider });
      const gateway = createGateway(provider, CONFIG);
      // Empty arguments fail most schemas; accepted or refused, neither path may reach the network.
      await gateway.complete({ runId: `RUN-${tool}`, prompt: PROMPT }).catch((e) => {
        if (!(e instanceof GatewayError)) throw e;
      });
      expect(provider.calls.length, tool).toBeLessThanOrEqual(1);
    }
    expect(attempted).not.toHaveBeenCalled();
  });

  it("VERI-5 FakeProvider: an exhausted script throws rather than calling out", async () => {
    const provider = fakeProvider([], { vendor: CONFIG.provider });
    const gateway = createGateway(provider, CONFIG);
    await expect(gateway.complete({ runId: "RUN-EMPTY", prompt: PROMPT })).rejects.toMatchObject({
      outcome: "PROVIDER_ERROR",
    });
    expect(attempted).not.toHaveBeenCalled();
  });

  it("VERI-5 RecordedProvider: every cassette entry replays with no call out", async () => {
    const provider = recordedProvider(loadCassette(cassetteJson), { vendor: CONFIG.provider });
    const gateway = createGateway(provider, CONFIG);
    for (const p of RECORDED_PROMPTS) {
      await expect(gateway.complete({ runId: p.note, prompt: p.prompt })).resolves.toBeTruthy();
    }
    expect(provider.hits).toHaveLength(RECORDED_PROMPTS.length);
    expect(attempted).not.toHaveBeenCalled();
  });

  it("VERI-5 RecordedProvider: a cassette miss throws instead of falling back to a live call", async () => {
    const provider = recordedProvider(
      cassetteFrom([{ prompt: PROMPT, response: toolCall("get_leg_state", { leg_id: "L-C1-AM" }) }]),
      { vendor: CONFIG.provider },
    );
    const gateway = createGateway(provider, CONFIG);
    const drifted = "T1 site=S1 family=F1 child=C1\nT2 leg=L-C1-PM version=4";
    await expect(gateway.complete({ runId: "RUN-MISS", prompt: drifted })).rejects.toMatchObject({
      outcome: "PROVIDER_ERROR",
    });
    await expect(
      provider.invoke({
        endpoint: provider.endpoint,
        model: CONFIG.model,
        zdr: CONFIG.zdr,
        dataMode: CONFIG.dataMode,
        prompt: drifted,
        tools: [],
        promptHash: sha256Hex(drifted),
      }),
    ).rejects.toThrow(CassetteMissError);
    expect(attempted).not.toHaveBeenCalled();
  });

  it("VERI-5 the whole red-team fixture set runs with no call out", async () => {
    for (const fixture of ATTACK_FIXTURES) {
      const provider = fakeProvider([fixture.response ?? { content: null }], { vendor: CONFIG.provider });
      const gateway = createGateway(provider, CONFIG);
      await gateway
        .complete({ runId: fixture.id, prompt: fixture.prompt ?? PROMPT, endpoint: fixture.endpoint })
        .catch((e) => {
          if (!(e instanceof GatewayError)) throw e;
        });
    }
    expect(attempted).not.toHaveBeenCalled();
  });

  /* ─────────────────── 3. the remote placeholder with no key ─────────────────── */

  it("VERI-5 the remote provider with no key env var set fails closed with a clear error", () => {
    expect(() => remoteProvider(CONFIG, {})).toThrow(RemoteProviderNotEnabled);
    // Clear means: it names the variable the deployment is missing, and says what it is refusing.
    expect(() => remoteProvider(CONFIG, {})).toThrow(/\$OPENROUTER_API_KEY/);
    expect(() => remoteProvider(CONFIG, {})).toThrow(/not configured/);
    // An empty or blank value is a missing key, not a key.
    expect(() => remoteProvider(CONFIG, { OPENROUTER_API_KEY: "" })).toThrow(RemoteProviderNotEnabled);
    expect(() => remoteProvider(CONFIG, { OPENROUTER_API_KEY: "   " })).toThrow(RemoteProviderNotEnabled);
    expect(attempted).not.toHaveBeenCalled();
  });

  it("VERI-5 a gateway over the remote placeholder refuses the call even with a key present", async () => {
    const provider = remoteProvider(CONFIG, { OPENROUTER_API_KEY: "test-key" });
    const gateway = createGateway(provider, CONFIG);
    await expect(gateway.complete({ runId: "RUN-REMOTE", prompt: PROMPT })).rejects.toMatchObject({
      outcome: "PROVIDER_ERROR",
    });
    expect(gateway.auditLog.at(-1)).toMatchObject({ outcome: "PROVIDER_ERROR", providerKind: "remote" });
    // The refusal and its audit row name the env var, never its value.
    expect(JSON.stringify(gateway.auditLog)).not.toContain("test-key");
    expect(attempted).not.toHaveBeenCalled();
  });

  it("VERI-5 the stub is real: a deliberate call fails this way, so 'never called' means something", () => {
    expect(() => (globalThis.fetch as unknown as () => void)()).toThrow(/attempted a network call/);
    expect(attempted).toHaveBeenCalledTimes(1);
  });
});
