/**
 * B-08 slice 5 (founder, 2026-10-15): **model ids come only from the config module.**
 *
 * The live agent runs on a free OpenRouter model today and moves to a HIPAA-compliant endpoint
 * once there is a signed BAA. That switch has to be an env change — `AGENT_MODEL` plus
 * `AGENT_MODEL_ALLOW_LIST` — and it only *stays* an env change if no second copy of a model slug
 * exists anywhere else. A literal in a route, a default in a helper, a fixture in a test: each one
 * is a place the switch can be half-done, and a half-done switch means the demo model keeps
 * serving traffic after someone believes it was retired.
 *
 * So this scans every `.ts`/`.tsx` file under `src/` and fails on any model name or id, with three
 * exclusions and no others:
 *
 *  - `modules/agent/config.ts` — the module that is *supposed* to hold them (`MODEL_PRIMARY`,
 *    `MODEL_BACKUP`, `DEFAULT_MODEL_ALLOW_LIST`);
 *  - `modules/agent/config.test.ts` — its test, which has to be able to name what it asserts;
 *  - this file, whose patterns are its subject.
 *
 * Tests are scanned like production code on purpose. A fixture that hard-codes a slug is how the
 * repo quietly acquires a second source of truth, and `gateway.test.ts` and the three `run/*`
 * suites were exactly that before this landed.
 *
 * Comments are stripped before matching, following `no-network.test.ts`: prose explaining which
 * model was chosen and why is documentation, and `config.ts`'s own docstring plus this header
 * would otherwise be the first two failures. The thing being banned is a *value* the code can
 * reach, so matching code is both the narrower and the honest reading.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_MODEL_ALLOW_LIST, MODEL_BACKUP, MODEL_PRIMARY, loadAgentConfig } from "./config";

const SRC_DIR = path.resolve(__dirname, "../..");

/** Where model ids are allowed to be, relative to `src/`. Every path is justified in the header. */
const ALLOWED_FILES: readonly string[] = [
  "modules/agent/config.ts",
  "modules/agent/config.test.ts",
  "modules/agent/no-hardcoded-models.test.ts",
];

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

const scannedFiles = walk(SRC_DIR)
  .filter((f) => f.endsWith(".ts") || f.endsWith(".tsx"))
  .map((f) => path.relative(SRC_DIR, f).split(path.sep).join("/"))
  .filter((f) => !ALLOWED_FILES.includes(f));

/** Comments removed, so a sentence naming a model is not mistaken for a call that uses one. */
function code(file: string): string {
  return readFileSync(path.join(SRC_DIR, file), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/(^|\s)\/\/.*$/, "$1"))
    .join("\n");
}

/**
 * The shapes a model id takes. Two kinds, deliberately:
 *
 *  - *structural* — an OpenRouter-style `vendor/slug`, and the `:free` tier suffix. These catch a
 *    model nobody has heard of yet, which is the case that matters: the patterns have to survive
 *    the next vendor, not just name this one's.
 *  - *by name* — the families actually in play, so a bare `gemma-4-31b` or `claude-opus-5` with no
 *    vendor prefix is caught too.
 *
 * `(?<![@\w.-])` keeps the vendor pattern off scoped package imports (`@google/...`) and off
 * paths that merely end in a vendor's name.
 */
const MODEL_PATTERNS: readonly { readonly what: string; readonly pattern: RegExp }[] = [
  {
    what: "a vendor/model slug",
    pattern:
      /(?<![@\w.-])(?:google|anthropic|openai|nvidia|meta-llama|mistralai|qwen|deepseek|x-ai|cohere|microsoft|amazon|perplexity|moonshotai)\/[a-z0-9][\w.-]*/i,
  },
  // `:free` as a tier suffix. The negative lookahead keeps it off identifiers that merely start
  // with the word, such as the policy engine's `BLOCK:free_text_to_parents`.
  { what: "an OpenRouter :free tier suffix", pattern: /:free(?![\w-])/i },
  { what: "a Gemma model name", pattern: /\bgemma[\w.-]*\b/i },
  { what: "a Nemotron model name", pattern: /\bnemotron[\w.-]*\b/i },
  { what: "a Claude model name", pattern: /\bclaude[-.][\w.-]*/i },
  { what: "a GPT model name", pattern: /\bgpt-[\w.-]*/i },
  { what: "a Llama model name", pattern: /\bllama-?\d[\w.-]*/i },
  { what: "a Gemini model name", pattern: /\bgemini-[\w.-]*/i },
  { what: "a Sonnet/Opus/Haiku tier name", pattern: /\b(?:sonnet|opus|haiku)[-.\d][\w.-]*/i },
];

describe("B-08 slice 5: no hard-coded model name or id anywhere in src/", () => {
  it("scans the tree it claims to scan, production and tests alike", () => {
    // If the walk ever silently stopped finding files, every assertion below would pass vacuously.
    expect(scannedFiles.length).toBeGreaterThan(50);
    expect(scannedFiles).toEqual(
      expect.arrayContaining([
        "modules/agent/gateway.ts",
        "modules/agent/gateway.test.ts",
        "modules/agent/providers/remote.ts",
        "modules/agent/run/queue.test.ts",
      ]),
    );
    // And the exclusions are the three named ones, not a list that grew.
    expect([...ALLOWED_FILES].sort()).toEqual([
      "modules/agent/config.test.ts",
      "modules/agent/config.ts",
      "modules/agent/no-hardcoded-models.test.ts",
    ]);
  });

  it.each(MODEL_PATTERNS.map((p) => [p.what, p.pattern] as const))("no file contains %s", (_what, pattern) => {
    const offenders = scannedFiles.filter((f) => pattern.test(code(f)));
    // The message names files, never the matched text: that is the whole point of the rule.
    expect(offenders).toEqual([]);
  });

  it("the config module does hold them, so the rule has somewhere to point", () => {
    const cfg = readFileSync(path.join(SRC_DIR, "modules/agent/config.ts"), "utf8");
    expect(cfg).toContain(MODEL_PRIMARY);
    expect(cfg).toContain(MODEL_BACKUP);
    // And what the rest of the code reads instead of a literal.
    const c = loadAgentConfig({});
    expect([c.model, c.backupModel]).toEqual([MODEL_PRIMARY, MODEL_BACKUP]);
    expect([...DEFAULT_MODEL_ALLOW_LIST]).toContain(c.model);
  });

  it("would notice a slug arriving, in any of the shapes it bans", () => {
    // Guards the guard. Every string here is a model id someone could plausibly paste in, and
    // includes both configured models — if a pattern stopped matching those, the scan would pass
    // while the literal it exists to find sat in a route handler.
    const samples = [
      MODEL_PRIMARY,
      MODEL_BACKUP,
      `const m = "${MODEL_PRIMARY}"`,
      'model: "anthropic/claude-sonnet-5.5"',
      'model: "openai/gpt-5-mini"',
      '"google/gemini-3-pro"',
      '"meta-llama/llama-4-70b-instruct"',
      '"qwen/qwen-3-max"',
      "const fallback = 'gemma-4-31b-it'",
      "nemotron-3-super-120b",
      'model: "claude-opus-5"',
      '"us.anthropic.claude-sonnet-5"',
      '"sonnet-5"',
    ];
    for (const sample of samples) {
      expect(
        MODEL_PATTERNS.some((p) => p.pattern.test(sample)),
        `no pattern catches ${sample}`,
      ).toBe(true);
    }
  });

  it("does not fire on the things that merely look like one", () => {
    // False positives are how a guard like this gets switched off. These must stay clean.
    const innocent = [
      'import { z } from "zod"',
      'import maplibre from "maplibre-gl"',
      '"BLOCK:free_text_to_parents"',
      'sendCopy: { kind: "free_text" }',
      'import { drain } from "@/modules/outbox/outbox"',
      'endpoint: "/api/v1/chat/completions"',
      'from "@google/third-party-sdk"',
      "const freeText = true",
      "status: 429",
      'provider: "openrouter"',
    ];
    for (const sample of innocent) {
      const hit = MODEL_PATTERNS.find((p) => p.pattern.test(sample));
      expect(hit?.what ?? null, `${hit?.what} fired on ${sample}`).toBeNull();
    }
  });
});
