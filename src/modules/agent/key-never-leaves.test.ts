/**
 * **Veri's agent gate, check 3: the model id comes from config, and the key never leaves the box.**
 *
 * Two halves, and the second is the one with teeth.
 *
 * The **model id**: `no-hardcoded-models.test.ts` proves no second copy of a slug exists anywhere
 * in `src/`. That is the negative. This file is the positive — every surface that names a model
 * names *this deployment's configured* one, and moving `AGENT_MODEL` moves all of them at once:
 * the audit row, the outbound request body, and the sentence the phone panel prints.
 *
 * The **key**: `providers/remote.test.ts` §5 already holds the adapter's own surfaces down. What it
 * cannot speak for is everything *downstream* of the adapter — the refusal strings the queue route
 * logs, the result a server action serializes to a browser, and the client bundle. So this file
 * puts a sentinel value in the environment and then looks everywhere a value can get out:
 *
 *  - every refusal and every failure path, as a thrown error and as a recorded attempt;
 *  - the provider object itself, `JSON.stringify`d, which is what a careless log line would print;
 *  - the gateway's audit log, which is a row in a database;
 *  - `chooseProvider().reason` and `agentRunner().reason`, which the agent queue route logs;
 *  - the `DemoAgentTurn` the phone panel's server action returns, which crosses to the browser;
 *  - everything the process wrote to `console.*` while all of that happened.
 *
 * And the bundle: the key is read in `providers/remote.ts`, which no `"use client"` module can
 * reach. That is asserted as a reachability walk over the import graph rather than by grepping a
 * build, because the walk fails on the commit that adds the import rather than on the next deploy.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DATA_CLASS_ENV_VAR, SYNTHETIC_DATA_CLASS } from "@/lib/env";
import { demoDay } from "@/domain/board/day";
import { demoAgentTurn } from "@/modules/demo/agent-turn";
import {
  DEMO_DATA_ONLY_ENV_VAR,
  DEMO_DATA_ONLY_REQUIRED_VALUE,
  loadAgentConfig,
} from "./config";
import { createGateway } from "./gateway";
import { ProviderError } from "./providers/provider";
import { chooseProvider, agentRunner } from "./run/deps";
import { liveCallRefusalReason, modelChain, remoteProvider } from "./providers/remote";
import { sha256Hex } from "./redact";
import { toolDeclarations } from "./tools";

/**
 * The sentinel. Shaped like an OpenRouter key so a substring search for it is a search for the
 * real thing's shape too, and distinctive enough that finding it in any string is unambiguous.
 */
const SENTINEL = "sk-or-v1-SENTINELKEYMUSTNEVERAPPEAR0123456789abcdef";

/** A deployment that may make a live call: the confirmation var, the boot class, and the key. */
const LIVE_ENV: Record<string, string | undefined> = {
  [DEMO_DATA_ONLY_ENV_VAR]: DEMO_DATA_ONLY_REQUIRED_VALUE,
  [DATA_CLASS_ENV_VAR]: SYNTHETIC_DATA_CLASS,
  OPENROUTER_API_KEY: SENTINEL,
};

const CONFIG = loadAgentConfig(LIVE_ENV);

const PROMPT = [
  "role=transport_coordinator_agent",
  "T1 site=S1 family=F1 child=C1 scopes=CANCEL_LEG",
  "T2 leg=L-C1-AM state=SCHEDULED version=3",
  "task=choose exactly one tool call",
].join("\n");

const call = (over: Record<string, unknown> = {}) => ({
  endpoint: CONFIG.endpointAllowList[0],
  model: CONFIG.model,
  zdr: CONFIG.zdr,
  dataMode: CONFIG.dataMode,
  prompt: PROMPT,
  tools: toolDeclarations(["get_leg_state"]),
  promptHash: sha256Hex(PROMPT),
  ...over,
});

/** One well-formed vendor envelope, carrying a tool call the catalog has. */
const ONE_TOOL_CALL = {
  choices: [
    {
      finish_reason: "tool_calls",
      message: { content: null, tool_calls: [{ function: { name: "get_leg_state", arguments: { leg_id: "L-C1-AM" } } }] },
    },
  ],
};

const jsonResponse = (status: number, body: unknown) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;

/* ───────── everything the process said, collected ───────── */

let logged: string[];
let restoreConsole: (() => void)[];

beforeEach(() => {
  logged = [];
  restoreConsole = (["log", "warn", "error", "info", "debug"] as const).map((level) => {
    const spy = vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logged.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
    });
    return () => spy.mockRestore();
  });
});

afterEach(() => {
  for (const restore of restoreConsole) restore();
  vi.unstubAllGlobals();
});

/** Nothing this process produced — strings, objects, errors, logs — carries the sentinel. */
function expectNoSentinel(what: string, ...values: unknown[]) {
  for (const [i, v] of values.entries()) {
    const text =
      v instanceof Error ? `${v.name} ${v.message} ${v.stack ?? ""}` : typeof v === "string" ? v : safeStringify(v);
    expect({ what, i, leaks: text.includes(SENTINEL) }).toEqual({ what, i, leaks: false });
  }
  expect({ what, logs: logged.filter((l) => l.includes(SENTINEL)) }).toEqual({ what, logs: [] });
}

function safeStringify(v: unknown): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(v, (_k, value) => {
    if (typeof value === "object" && value !== null) {
      if (seen.has(value)) return "[circular]";
      seen.add(value);
    }
    if (typeof value === "function") return String(value);
    return value;
  }) ?? String(v);
}

/* ───────── part 1: every surface names the configured model ───────── */

describe("check 3, part 1: the model id comes from config and from nowhere else", () => {
  it("the request body, the audit row and the chain all carry config.model", async () => {
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: { body: string }) => {
      bodies.push(JSON.parse(init.body) as Record<string, unknown>);
      return jsonResponse(200, ONE_TOOL_CALL);
    });

    const provider = remoteProvider(CONFIG, LIVE_ENV);
    const gateway = createGateway(provider, CONFIG);
    const result = await gateway.complete({ runId: "01900000-0000-7000-8000-00000000000a", prompt: PROMPT });

    expect(result.call.tool).toBe("get_leg_state");
    expect(bodies.map((b) => b.model)).toEqual([CONFIG.model]);
    expect(gateway.auditLog.at(-1)!.model).toBe(CONFIG.model);
    expect(modelChain(CONFIG)).toEqual([CONFIG.model, CONFIG.backupModel]);
  });

  it("an env change moves the model everywhere at once, with no code change", async () => {
    const SWAPPED = "vendor-x/some-other-model";
    const env = { ...LIVE_ENV, AGENT_MODEL: SWAPPED, AGENT_BACKUP_MODEL: SWAPPED, AGENT_MODEL_ALLOW_LIST: SWAPPED };
    const config = loadAgentConfig(env);
    expect([config.model, config.backupModel]).toEqual([SWAPPED, SWAPPED]);
    // One model in the chain, because primary and backup are now the same id.
    expect(modelChain(config)).toEqual([SWAPPED]);

    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: { body: string }) => {
      bodies.push(JSON.parse(init.body) as Record<string, unknown>);
      return jsonResponse(200, ONE_TOOL_CALL);
    });
    const gateway = createGateway(remoteProvider(config, env), config);
    await gateway.complete({ runId: "01900000-0000-7000-8000-00000000000b", prompt: PROMPT });

    expect(bodies.map((b) => b.model)).toEqual([SWAPPED]);
    expect(gateway.auditLog.at(-1)!.model).toBe(SWAPPED);
  });

  it("the sentence the phone panel prints names the configured model, not a literal", async () => {
    vi.stubGlobal("fetch", async () => jsonResponse(200, ONE_TOOL_CALL));
    const turn = await demoAgentTurn({ childKey: "C1", text: "is the van coming", day: demoDay(), env: LIVE_ENV });
    expect(turn.modelUnavailable).toBe(false);
    expect(turn.model).toBe(CONFIG.model);
  });
});

/* ───────── part 2: the key is in one header and in nothing else ───────── */

describe("check 3, part 2: the key reaches the authorization header and no other surface", () => {
  it("is not in the url, not in the body, and is the whole of the one header that has it", async () => {
    const seen: { url: string; init: { headers: Record<string, string>; body: string } }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: { headers: Record<string, string>; body: string }) => {
      seen.push({ url, init });
      return jsonResponse(200, ONE_TOOL_CALL);
    });

    const provider = remoteProvider(CONFIG, LIVE_ENV);
    await provider.invoke(call());

    expect(seen).toHaveLength(1);
    const { url, init } = seen[0];
    expect(url).not.toContain(SENTINEL);
    expect(init.body).not.toContain(SENTINEL);
    expect(init.headers.authorization).toBe(`Bearer ${SENTINEL}`);
    // Every header except that one, and the url, and the body.
    const { authorization: _authorization, ...rest } = init.headers;
    expectNoSentinel("the outbound request", url, init.body, rest);
  });

  it("a successful call leaves nothing on the provider, the attempts or the audit row", async () => {
    vi.stubGlobal("fetch", async () => jsonResponse(200, ONE_TOOL_CALL));
    const provider = remoteProvider(CONFIG, LIVE_ENV);
    const gateway = createGateway(provider, CONFIG);
    const body = await provider.invoke(call());
    await gateway.complete({ runId: "01900000-0000-7000-8000-00000000000c", prompt: PROMPT });

    expect(provider.apiKeyEnvVar).toBe("OPENROUTER_API_KEY");
    expectNoSentinel("a successful call", provider, provider.attempts, body, gateway.auditLog);
  });

  it.each([
    ["a rate limit, then a failing backup", () => jsonResponse(429, { error: { message: "rate limited" } })],
    ["a 500 that quotes the request back", () => jsonResponse(500, { error: { message: `upstream rejected ${SENTINEL}` } })],
    ["a 200 carrying something that is not an envelope", () => jsonResponse(200, "<html>proxy error</html>")],
  ])("%s exhausts the chain and leaks nothing", async (what, respond) => {
    vi.stubGlobal("fetch", async () => respond());
    const provider = remoteProvider(CONFIG, LIVE_ENV);

    /*
     * Exhausting the chain is a **refusal** now, not a degraded answer: the founder's rule of
     * 2026-10-17 removed the keyword parser that used to answer here, so the caller raises one
     * staff alert and the family's text waits for a person. What this file checks is unchanged —
     * whatever the chain produces on its way to that refusal must carry no key and no prompt —
     * so the refusal, its attempt records and the provider itself all go through the sentinel
     * scan, including the error's own message and stack (case two is a vendor quoting us back).
     */
    const refusal = await provider.invoke(call()).then(
      (body) => { throw new Error(`expected a refusal, got ${JSON.stringify(body)}`); },
      (e: unknown) => e as Error & { attempts?: unknown },
    );
    expect(refusal).toBeInstanceOf(ProviderError);
    expect(provider.attempts.every((a) => !a.ok)).toBe(true);
    // The vendor's own message is never recorded, which is why case two cannot leak through it.
    expect(provider.attempts.map((a) => a.failure)).not.toContain(null);
    expectNoSentinel(what, provider, provider.attempts, refusal.message, refusal.stack ?? "");
  });

  it("a network error and a timeout leak nothing either", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error(`connect ECONNREFUSED while sending Bearer ${SENTINEL}`);
    });
    const provider = remoteProvider(CONFIG, LIVE_ENV);
    /*
     * A chain where every model failed **throws** now: the founder's rule of 2026-10-17 deleted
     * the degraded reader that used to catch it, so the adapter raises and a person is told
     * (`agent/staff-alert.ts`). The assertion is unchanged in substance — nothing carries the
     * key — and is made from the other side: the refusal's message, its stack, and the attempts
     * the provider recorded.
     */
    const refused = await provider.invoke(call()).then(
      (body) => { throw new Error(`expected a refusal, got ${JSON.stringify(body)}`); },
      (e: unknown) => e as Error,
    );
    expect(provider.attempts.map((a) => a.failure)).toEqual(["network_error", "network_error"]);
    expectNoSentinel("a network error", provider, provider.attempts, refused.message, refused.stack ?? "");

    vi.stubGlobal("fetch", async (_url: string, init: { signal: AbortSignal }) => {
      await new Promise((_resolve, reject) => {
        const err = new Error("aborted");
        err.name = "AbortError";
        init.signal.addEventListener("abort", () => reject(err), { once: true });
      });
      throw new Error("unreachable");
    });
    const quick = loadAgentConfig({ ...LIVE_ENV, AGENT_REQUEST_TIMEOUT_MS: "20" });
    const timing = remoteProvider(quick, LIVE_ENV);
    // Same shape as the network case above, and for the same reason: every model timing out is a
    // chain that failed, so it raises rather than answering.
    const timedOut = await timing.invoke(call()).then(
      (body) => { throw new Error(`expected a refusal, got ${JSON.stringify(body)}`); },
      (e: unknown) => e as Error,
    );
    expect(timing.attempts.map((a) => a.failure)).toEqual(["timeout", "timeout"]);
    expectNoSentinel("a timeout", timing, timing.attempts, timedOut.message, timedOut.stack ?? "");
  });

  /**
   * The four refusals on the outbound path, each driven through a config object a *caller*
   * rebuilt — which is the case `remote.ts` re-checks for, and the only way to reach three of
   * them, since `loadAgentConfig` refuses each at parse time.
   */
  it.each([
    [
      "no demo-data confirmation",
      () => remoteProvider(loadAgentConfig({ OPENROUTER_API_KEY: SENTINEL }), { OPENROUTER_API_KEY: SENTINEL }),
    ],
    [
      "a base url this build may not send a key to",
      () => remoteProvider({ ...CONFIG, baseUrl: "http://evil.example" }, LIVE_ENV),
    ],
    [
      "a model off the allow-list, re-checked on the outbound path",
      () => remoteProvider({ ...CONFIG, model: "vendor-x/not-allowed" }, LIVE_ENV).invoke(call()),
    ],
    [
      "an endpoint off the allow-list",
      () => remoteProvider(CONFIG, LIVE_ENV).invoke(call({ endpoint: "/api/v1/batches" })),
    ],
  ])("the refusal for %s names the variable, never the value", async (what, build) => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("a refusal must land before fetch");
    });
    let thrown: unknown;
    try {
      await build();
    } catch (e) {
      thrown = e;
    }
    // Two of these refuse at wiring time and two on invoke. Either way something was refused —
    // nothing was sent — and whatever was said about it carries no key.
    expect(thrown === undefined ? "nothing was refused" : "refused").toBe("refused");
    expectNoSentinel(what, thrown);
  });

  it("the reason the queue route logs names the variable and not the value", () => {
    const withoutKey = { [DEMO_DATA_ONLY_ENV_VAR]: DEMO_DATA_ONLY_REQUIRED_VALUE, [DATA_CLASS_ENV_VAR]: SYNTHETIC_DATA_CLASS };
    const missing = liveCallRefusalReason(loadAgentConfig(withoutKey), withoutKey);
    expect(missing).toContain("$OPENROUTER_API_KEY");
    expect(missing).not.toContain(SENTINEL);

    // And on a deployment that *does* have the key, there is no reason at all to log.
    const live = chooseProvider(CONFIG, LIVE_ENV);
    expect([live.refused, live.reason]).toEqual([false, null]);
    const runner = agentRunner({ query: async () => ({ rows: [] }), tx: async () => undefined } as never, LIVE_ENV);
    expectNoSentinel("the runner the route logs", live, runner);
  });

  it("the turn the phone panel serializes to a browser carries the model id and nothing secret", async () => {
    vi.stubGlobal("fetch", async () => jsonResponse(429, { error: { message: `quota for ${SENTINEL}` } }));
    const turn = await demoAgentTurn({ childKey: "C1", text: "is the van coming", day: demoDay(), env: LIVE_ENV });
    // Every model failed, so no model answered — and the turn says so rather than degrading.
    expect(turn.modelUnavailable).toBe(true);
    expect(turn.unavailableReason).toBeTruthy();
    // This object is the server action's return value: it is serialized into the HTML.
    expectNoSentinel("the server action's result", turn, safeStringify(turn));
  });
});

/* ───────── part 3: no client module can reach the file that reads the key ───────── */

const SRC_DIR = path.resolve(__dirname, "../..");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

const allFiles = walk(SRC_DIR)
  .filter((f) => f.endsWith(".ts") || f.endsWith(".tsx"))
  .map((f) => path.relative(SRC_DIR, f).split(path.sep).join("/"));

const read = (file: string) => readFileSync(path.join(SRC_DIR, file), "utf8");

/** `"use client"` at the top of a module: the root of a bundle Next ships to a browser. */
const clientEntries = allFiles
  .filter((f) => !f.endsWith(".test.ts") && !f.endsWith(".test.tsx"))
  .filter((f) => /^\s*["']use client["']/m.test(read(f)));

/** Every import specifier in a module, type-only imports included — a bundler follows the value ones. */
function importsOf(file: string): string[] {
  const src = read(file);
  return [...src.matchAll(/\bfrom\s+["']([^"']+)["']|\bimport\s+["']([^"']+)["']/g)].map((m) => m[1] ?? m[2]);
}

/** Resolve a specifier to a file under `src/`, or null for a package or an asset. */
function resolve(from: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = spec.slice(2);
  else if (spec.startsWith(".")) base = path.posix.normalize(path.posix.join(path.posix.dirname(from), spec));
  else return null;
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]) {
    if (allFiles.includes(candidate)) return candidate;
  }
  return null;
}

/** `"use server"` at the top of a module: a server-action file. */
const isServerAction = (file: string) => /^\s*["']use server["']/m.test(read(file));

/**
 * Every module reachable from these entries by following imports.
 *
 * `stopAt` is the bundler boundary, and the reason this walk is about the *client bundle* rather
 * than about the module graph in the abstract: when a `"use client"` module imports a
 * `"use server"` one, Next replaces it with a server *reference* — an id and a fetch — and keeps
 * the module and everything it imports on the server. So a server-action file is reachable and its
 * imports are not, which is exactly what `assertNotInClientBundle` has to model. A file in
 * `stopAt` is recorded and not expanded.
 */
function reachableFrom(entries: readonly string[], stopAt: (file: string) => boolean = () => false): Set<string> {
  const seen = new Set<string>();
  const queue = [...entries];
  while (queue.length > 0) {
    const file = queue.shift()!;
    if (seen.has(file)) continue;
    seen.add(file);
    if (stopAt(file)) continue;
    for (const spec of importsOf(file)) {
      const target = resolve(file, spec);
      if (target && !seen.has(target)) queue.push(target);
    }
  }
  return seen;
}

/** What Next actually ships to a browser: the client entries, stopping at every server action. */
const clientBundle = () => {
  const reached = reachableFrom(clientEntries, isServerAction);
  // The boundary modules themselves are references, not code: drop them from the bundle set.
  for (const file of [...reached]) if (isServerAction(file)) reached.delete(file);
  return reached;
};

/** The two modules that must stay on the server: the one that holds the key's name, and the one
 * that reads its value. */
const SERVER_ONLY = ["modules/agent/config.ts", "modules/agent/providers/remote.ts"] as const;

describe("check 3, part 3: the key cannot be in a client bundle, because the module is unreachable", () => {
  it("finds the client entry points it claims to walk", () => {
    expect(clientEntries).toEqual(
      expect.arrayContaining(["ui/AgentPanel.tsx", "ui/NavRail.tsx"]),
    );
    // The import walk is real: the panel reaches the copy deck and the actions it is handed.
    const fromCard = reachableFrom(["ui/AgentPanel.tsx"]);
    expect(fromCard.has("ui/PanelActions.tsx")).toBe(true);
    expect(fromCard.has("ui/copy.ts")).toBe(true);
  });

  /**
   * No client module talks to the agent at all any more, which is a stronger thing than the
   * boundary this used to assert.
   *
   * It used to be: the phone composer runs an agent turn, and it does it across a `"use server"`
   * line. That composer is gone with the Family texts rebuild — a model call belongs on the queue
   * (`/api/queues/agent`), not behind a button — so the only server action under that folder is
   * the approval decision, and it reaches no provider. Both halves are asserted, because "no
   * client module reaches the agent" is only worth something if the boundary is still declared:
   * a `"use server"` file is where the walk stops, and if that line went away the bundle checks
   * below would follow every import in it.
   */
  it("no client module reaches the agent, and the one server action still declares its boundary", () => {
    expect(isServerAction("app/(app)/family-texts/actions.ts")).toBe(true);
    const onTheServer = reachableFrom(["app/(app)/family-texts/actions.ts"]);
    // The decision model, and nothing that calls a vendor.
    expect(onTheServer.has("modules/approvals/decide.ts")).toBe(true);
    expect(onTheServer.has("modules/agent/providers/remote.ts")).toBe(false);
    // And from a browser, neither server-only module is reachable at all.
    for (const serverOnly of SERVER_ONLY) expect(clientBundle().has(serverOnly)).toBe(false);
  });

  it.each(SERVER_ONLY)("%s is in no client bundle", (serverOnly) => {
    expect({ serverOnly, bundled: clientBundle().has(serverOnly) }).toEqual({ serverOnly, bundled: false });
  });

  it("no module in a client bundle names the key's env var, or reads process.env for it", () => {
    for (const file of clientBundle()) {
      const src = read(file);
      expect({ file, names: /OPENROUTER|AGENT_API_KEY/.test(src) }).toEqual({ file, names: false });
      expect({ file, reads: /process\.env\.[A-Z_]*KEY/.test(src) }).toEqual({ file, reads: false });
    }
  });

  it("the key is never a NEXT_PUBLIC_ var, which is the one way a server value reaches a bundle", () => {
    const publicVars = allFiles.flatMap((f) => [...read(f).matchAll(/NEXT_PUBLIC_[A-Z0-9_]+/g)].map((m) => m[0]));
    expect(publicVars.filter((v) => /KEY|SECRET|TOKEN|PEPPER/.test(v))).toEqual([]);
    expect(readFileSync(path.resolve(SRC_DIR, "..", ".env.example"), "utf8")).toContain("OPENROUTER_API_KEY=");
    expect(readFileSync(path.resolve(SRC_DIR, "..", ".env.example"), "utf8")).not.toContain("NEXT_PUBLIC_OPENROUTER");
  });

  it("the walk would notice: the same graph does reach the module from the server side", () => {
    // The guard is only worth having if the walk can find `remote.ts` at all. It can — from the
    // queue route's deps, which is server code — so "not in the client bundle" is a real finding
    // and not an artefact of a resolver that silently resolves nothing.
    expect(reachableFrom(["modules/agent/run/deps.ts"]).has("modules/agent/providers/remote.ts")).toBe(true);
    expect(clientBundle().size).toBeGreaterThan(5);
  });
});
