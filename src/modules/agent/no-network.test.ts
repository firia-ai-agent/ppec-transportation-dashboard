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
 * B-08 slice 5 added a live adapter, so the bar it still clears is the narrowed one described at
 * EXEMPT below: `providers/remote.ts` may call `fetch` and `config.ts` may hold a URL, and nothing
 * else may do either. The dynamic half is unchanged for every other provider, and for the live one
 * it proves the thing that matters most — the demo-data guard refuses **without touching fetch**.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import cassetteJson from "./fixtures/recorded-standard.json";
import { RECORDED_PROMPTS } from "./fixtures/prompts";
import { ATTACK_FIXTURES } from "./fixtures/attacks";
import { DATA_CLASS_ENV_VAR, SYNTHETIC_DATA_CLASS } from "@/lib/env";
import { DEMO_DATA_ONLY_ENV_VAR, DEMO_DATA_ONLY_REQUIRED_VALUE, loadAgentConfig } from "./config";
import { GatewayError, createGateway } from "./gateway";
import { sha256Hex } from "./redact";
import { TOOL_NAMES } from "./tools";
import { fakeProvider, toolCall } from "./providers/fake";
import { CassetteMissError, cassetteFrom, loadCassette, recordedProvider } from "./providers/recorded";
import { RemoteProviderNotEnabled, remoteProvider } from "./providers/remote";

const CONFIG = loadAgentConfig({});
const PROMPT = "T1 site=S1 family=F1 child=C1\nT2 leg=L-C1-AM state=SCHEDULED version=3";

/**
 * What a confirmed demo deployment has in its environment. Both vars, because the guard is both:
 * the operator's `AGENT_DEMO_DATA_ONLY` confirmation and the ADR-015 boot data class it has to
 * agree with (`config.demoDataGuardRefusal`).
 */
const DEMO_ENV = {
  [DEMO_DATA_ONLY_ENV_VAR]: DEMO_DATA_ONLY_REQUIRED_VALUE,
  [DATA_CLASS_ENV_VAR]: SYNTHETIC_DATA_CLASS,
};

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

/**
 * B-08 slice 5 narrowed this bar rather than dropped it. The live provider exists now, so "no
 * file reaches the network" is no longer true — but "only these two files can, and only this way"
 * is, and it is the claim worth testing:
 *
 *  - `providers/remote.ts` is the **only** file that may call `fetch`. It is the vendor adapter;
 *    that is its whole job, and the demo-data guard plus the gateway sit in front of it.
 *  - `config.ts` is the **only** file that may carry a URL, for the same reason it is the only
 *    file that may carry a model id: one place to repoint at the compliant endpoint.
 *
 * Every other pattern still applies to every file, including those two: no node network module,
 * no HTTP client package, no browser transport. A `fetch` in a third file, or a URL literal in
 * the adapter, fails this suite — which is the point. The exemptions are per *pattern*, not a
 * blanket pass for either file.
 */
const EXEMPT: Readonly<Record<string, readonly string[]>> = {
  "a fetch() call": ["providers/remote.ts"],
  "an absolute URL": ["config.ts"],
};

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
    // The scan reads code, not prose: every file here discusses HTTP at length and must still pass.
    expect(code("providers/remote.ts")).toContain("fetch(url");
    // And providers/keyword.ts is not on the list because it is gone — the founder's 2026-10-17
    // rule deleted it, and `no-keyword-fallback.test.ts` is what keeps it gone.
    expect(existsSync(path.join(AGENT_DIR, "providers/keyword.ts"))).toBe(false);
  });

  it.each(NETWORK_PATTERNS.map((p) => [p.what, p.pattern] as const))(
    "VERI-5 no file outside the named exemption contains %s",
    (what, pattern) => {
      const exempt = EXEMPT[what] ?? [];
      const offenders = sourceFiles.filter((f) => !exempt.includes(f)).filter((f) => pattern.test(code(f)));
      expect(offenders).toEqual([]);
    },
  );

  it("VERI-5 every exemption is still used, and is still only the ones named here", () => {
    // An exemption nobody needs is an open door left open. If the live adapter is ever deleted or
    // the URL moves, this fails and the exemption has to go with it.
    expect(Object.keys(EXEMPT).sort()).toEqual(["a fetch() call", "an absolute URL"]);
    for (const [what, files] of Object.entries(EXEMPT)) {
      const pattern = NETWORK_PATTERNS.find((p) => p.what === what)!.pattern;
      for (const f of files) {
        expect(sourceFiles, `${f} is exempted but not scanned`).toContain(f);
        expect(pattern.test(code(f)), `${f} no longer needs the "${what}" exemption`).toBe(true);
      }
    }
  });

  it("VERI-5 the exemptions are per pattern: neither file gets the other's", () => {
    // remote.ts builds its URL from config.baseUrl. A literal there would be a second place to
    // change on the switch to the compliant endpoint, which is exactly what slice 5 removed.
    expect(/\bhttps?:\/\//.test(code("providers/remote.ts"))).toBe(false);
    expect(/\bfetch\s*\(/.test(code("config.ts"))).toBe(false);
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

  /* ─────────────────── 3. the live adapter: the guard refuses without calling out ─────────────────── */

  it("VERI-5 the demo-data guard refuses before fetch is touched, key or no key", () => {
    // This is the clause that matters now that an adapter with a body exists. CONFIG is
    // loadAgentConfig({}), so demoDataOnly is false — the fail-shut default — and a deployment
    // that has a key but has not confirmed demo data is precisely the dangerous one.
    expect(() => remoteProvider(CONFIG, {})).toThrow(RemoteProviderNotEnabled);
    expect(() => remoteProvider(CONFIG, { OPENROUTER_API_KEY: "placeholder-not-a-key" })).toThrow(
      RemoteProviderNotEnabled,
    );
    // It says which setting is missing and what exact value it wants, and nothing about a key.
    expect(() => remoteProvider(CONFIG, {})).toThrow(/AGENT_DEMO_DATA_ONLY/);
    expect(() => remoteProvider(CONFIG, {})).toThrow(/fails shut/);
    expect(attempted).not.toHaveBeenCalled();
  });

  it("VERI-5 with the guard confirmed, a missing key still fails closed naming the variable", () => {
    const demo = loadAgentConfig(DEMO_ENV);
    expect(() => remoteProvider(demo, DEMO_ENV)).toThrow(RemoteProviderNotEnabled);
    expect(() => remoteProvider(demo, DEMO_ENV)).toThrow(/\$OPENROUTER_API_KEY/);
    expect(() => remoteProvider(demo, DEMO_ENV)).toThrow(/not configured/);
    // An empty or blank value is a missing key, not a key.
    expect(() => remoteProvider(demo, { ...DEMO_ENV, OPENROUTER_API_KEY: "" })).toThrow(RemoteProviderNotEnabled);
    expect(() => remoteProvider(demo, { ...DEMO_ENV, OPENROUTER_API_KEY: "   " })).toThrow(
      RemoteProviderNotEnabled,
    );
    expect(attempted).not.toHaveBeenCalled();
  });

  it("VERI-5 the guard's other two conditions refuse without touching fetch either", () => {
    // Same claim as above for the two facts the confirmation has to agree with: a deployment whose
    // boot data class is not SYNTHETIC, and one whose agent data mode is not, reach no network.
    const phiClass = { ...DEMO_ENV, [DATA_CLASS_ENV_VAR]: "PHI", OPENROUTER_API_KEY: "placeholder-not-a-key" };
    expect(() => remoteProvider(loadAgentConfig(phiClass), phiClass)).toThrow(RemoteProviderNotEnabled);

    const phiMode = { ...DEMO_ENV, AGENT_DATA_MODE: "PHI", OPENROUTER_API_KEY: "placeholder-not-a-key" };
    expect(() => remoteProvider(loadAgentConfig(phiMode), phiMode)).toThrow(RemoteProviderNotEnabled);
    expect(attempted).not.toHaveBeenCalled();
  });

  it("VERI-5 a fully wired live provider does attempt the call, and refuses when it cannot", async () => {
    // The honest other half: once both gates are open the adapter is *supposed* to reach the
    // network. With the stub throwing — which is what an unreachable vendor looks like — there is
    // nothing to degrade to any more (founder, 2026-10-17): the gateway refuses the turn with
    // PROVIDER_ERROR and the caller raises one staff alert (`agent/staff-alert.ts`).
    const demo = loadAgentConfig(DEMO_ENV);
    const provider = remoteProvider(demo, { ...DEMO_ENV, OPENROUTER_API_KEY: "placeholder-not-a-key" });
    const gateway = createGateway(provider, demo);
    await expect(gateway.complete({ runId: "RUN-REMOTE", prompt: PROMPT })).rejects.toMatchObject({
      outcome: "PROVIDER_ERROR",
    });
    expect(attempted).toHaveBeenCalledTimes(2); // primary, then backup
    expect(provider.attempts.map((a) => a.failure)).toEqual(["network_error", "network_error"]);
    // And the refusal path still logs no prompt and no key.
    const log = JSON.stringify(gateway.auditLog);
    expect(log).not.toContain("placeholder-not-a-key");
    expect(log).not.toContain("site=S1");
  });

  it("VERI-5 the stub is real: a deliberate call fails this way, so 'never called' means something", () => {
    expect(() => (globalThis.fetch as unknown as () => void)()).toThrow(/attempted a network call/);
    expect(attempted).toHaveBeenCalledTimes(1);
  });
});
