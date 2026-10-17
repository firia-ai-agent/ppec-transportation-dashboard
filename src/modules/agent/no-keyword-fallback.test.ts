/**
 * Veri's gate on the founder's rule of 2026-10-17 5:28 PM ET, which overrides PRD §18.1 l.1200
 * ("LLM down → keyword parser"):
 *
 *   "Never compensate with a deterministic text parser if the model isn't available; the
 *    owner/staff need to be notified."
 *
 * The rule is easy to state and easy to undo by accident, because a keyword reader is the obvious
 * thing to reach for the next time a free endpoint rate-limits: it is cheap, it looks like
 * robustness, and it is a mis-parse away from a child nobody collects. So this file is a
 * **structural** test rather than a behavioural one. It reads the source tree and fails if the
 * reader comes back in any of the shapes it could come back in:
 *
 *  1. the file exists again (`providers/keyword.ts`, or a sibling named for the same job);
 *  2. anything under `src/` imports it, by relative path or by `@/` path, or names its export;
 *  3. `providers/remote.ts` references a keyword parser at all — it is the file whose model chain
 *    used to end in one, and the one a "just restore the fallback" change would edit first;
 *  4. the parent-reply path — the agent run loop and its executors — reads the family's words to
 *    extract a time. A requested time comes only from the model's structured output, which means
 *    no `/\d(?::\d\d)?\s*(?:am|pm)/`-shaped regex and no keyword list anywhere on that path.
 *
 * (4) is the part that is not covered by deleting a file: the rule is about *compensating* for a
 * missing model, and a time regex quietly added to an executor would compensate just as much as a
 * keyword table would, while passing (1)–(3).
 *
 * Deliberately a source scan with no imports from the module under test, in the same shape as
 * `no-network.test.ts` and `no-hardcoded-models.test.ts`: a test that imported the thing it is
 * checking for the absence of could not express the check.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SRC = path.join(__dirname, "..", "..");
const AGENT_DIR = __dirname;
const PROVIDERS = path.join(AGENT_DIR, "providers");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

const allSources = walk(SRC).filter((f) => /\.(?:ts|tsx)$/.test(f));

/** This file names every banned string, so it has to be excluded from its own scan. */
const SELF = path.join(AGENT_DIR, "no-keyword-fallback.test.ts");

/** Comments stripped, so prose *about* the removed reader is not read as a use of it. */
function code(file: string): string {
  return readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/(^|\s)\/\/.*$/, "$1"))
    .join("\n");
}

const rel = (f: string) => path.relative(SRC, f).split(path.sep).join("/");

describe("the keyword reader is gone and cannot come back (founder, 2026-10-17)", () => {
  it("providers/keyword.ts does not exist, and nor does its test", () => {
    expect(existsSync(path.join(PROVIDERS, "keyword.ts"))).toBe(false);
    expect(existsSync(path.join(PROVIDERS, "keyword.test.ts"))).toBe(false);
  });

  /**
   * The same file under another name. `providers/` is a short, closed list — one file per way of
   * reaching a model — so an addition here is cheap to review and a *fallback* reader added here
   * is exactly what the rule forbids. New vendors are welcome; a parser is not.
   */
  it("no provider file is named for a text parser", () => {
    const named = readdirSync(PROVIDERS).filter((f) => /keyword|parser|fallback|degraded/i.test(f));
    expect(named).toEqual([]);
  });

  it("nothing under src/ imports the keyword reader or names its export", () => {
    const offenders = allSources
      .filter((f) => f !== SELF)
      .filter((f) => {
        const src = code(f);
        return (
          /from\s+["'](?:\.{1,2}\/)*(?:modules\/agent\/)?providers\/keyword["']/.test(src) ||
          /from\s+["']@\/modules\/agent\/providers\/keyword["']/.test(src) ||
          /from\s+["']\.\/keyword["']/.test(src) ||
          /\bkeywordResponse\b/.test(src) ||
          /\bkeywordProvider\b/.test(src) ||
          /\bKEYWORD_RULES\b/.test(src) ||
          /\bclassifyKeywords\b/.test(src)
        );
      })
      .map(rel);
    expect(offenders).toEqual([]);
  });

  /**
   * The live adapter's model chain ends in a refusal. Every one of these names would have to
   * reappear for it to end in a parser instead, and `ProviderKind` is the type that would have to
   * grow a non-model member to carry one.
   */
  it("providers/remote.ts references no keyword parser and no fallback switch", () => {
    const src = code(path.join(PROVIDERS, "remote.ts"));
    for (const banned of ["keyword", "fellBack", "Fallback", "fallbackResponse"]) {
      // `allow_fallbacks:false` is OpenRouter's own request field and is not a fallback *here*,
      // so the check is case-sensitive on the identifier shapes above and excludes that key.
      expect(src.replace(/allow_fallbacks/g, ""), banned).not.toContain(banned);
    }
    // And the refusal really is the end of the chain.
    expect(src).toContain("RemoteProviderUnavailable");
  });

  it("ProviderKind has no degraded, non-model member", () => {
    const src = code(path.join(PROVIDERS, "provider.ts"));
    const kinds = /export type ProviderKind =([^;]*);/.exec(src)?.[1] ?? "";
    expect(kinds).not.toBe("");
    expect(kinds).not.toMatch(/keyword|parser|fallback|degraded/i);
  });

  it('no file under src/ produces the "keyword_fallback" finish reason', () => {
    const offenders = allSources
      .filter((f) => f !== SELF)
      .filter((f) => /keyword_fallback/.test(code(f)))
      .map(rel);
    expect(offenders).toEqual([]);
  });

  /**
   * The parent-reply path, scanned for the thing a keyword reader would be rebuilt *as*: a regex
   * over the family's words that pulls a time out of them.
   *
   * The path is the run loop, its executors and the proposal writers — everything that sees an
   * inbound message and decides what the agent does about it. A requested time reaches a proposal
   * only as a field of a schema-validated tool call (`tools.ts`), so no file here needs to read a
   * clock time out of prose, and one that did would be compensating for the model.
   */
  it("nothing on the parent-reply path extracts a time from the family's words", () => {
    const pathFiles = allSources.filter(
      (f) =>
        !f.endsWith(".test.ts") &&
        (rel(f).startsWith("modules/agent/run/") ||
          rel(f).startsWith("modules/approvals/") ||
          rel(f) === "modules/agent/gateway.ts" ||
          rel(f) === "modules/agent/staff-alert.ts"),
    );
    expect(pathFiles.length).toBeGreaterThan(5);

    /** A clock time read out of free text: "at 5", "5pm", "5:30 pm", "17:00" in a prose scan. */
    const TIME_FROM_PROSE = [
      /\(\?:\s*am\s*\|\s*pm\s*\)/i,
      /\\b\s*(?:at|by|around)\s*\\b/i,
      /\[ap\]\s*\\?\.?\s*m/i,
      /\ba\.?m\.?\|p\.?m\.?/i,
    ];
    for (const file of pathFiles) {
      const src = code(file);
      for (const pattern of TIME_FROM_PROSE) {
        expect(pattern.test(src), `${rel(file)} matches ${pattern}`).toBe(false);
      }
      // And no keyword table of the kind §18.1 described (ABSENT/SICK/YES/READY/STOP).
      expect(/\bABSENT\b[\s\S]{0,200}\bSICK\b/.test(src), rel(file)).toBe(false);
    }
  });
});
