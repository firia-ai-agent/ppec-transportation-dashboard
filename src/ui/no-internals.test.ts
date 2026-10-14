import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import * as copy from "./copy";

/**
 * No internal plumbing on a user-facing screen (Vera's review, COPY-GUIDE §1–§2).
 *
 * Two things leak and both read as someone else's notes to a coordinator:
 *  - ticket / build-step codes: "Coming in B-12", "PPE-21", "AT-18", "TEST-INF-3";
 *  - internal endpoints: "Health: /api/health".
 *
 * Scope: every string copy.ts exports, copy.ts's own text (the copy file stays clean of codes
 * so a grep over it is meaningful), and every string literal or JSX text node rendered from
 * src/ui and src/app. Comments elsewhere may still carry a code — a comment is a note to the
 * next engineer, not something the screen says — so they are stripped before scanning.
 */
const TICKET = /\b(?:B|PPE|AT|TEST-INF)-\d+/g;
const ENDPOINT = /\/api\//g;

const SRC = path.resolve(__dirname, "..");
const SCANNED_DIRS = [path.join(SRC, "ui"), path.join(SRC, "app")];
const EXTENSIONS = new Set([".ts", ".tsx"]);

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return walk(full);
    return EXTENSIONS.has(path.extname(full)) ? [full] : [];
  });
}

function sourceFiles(): string[] {
  return SCANNED_DIRS.flatMap(walk).filter((f) => !f.endsWith(".test.ts") && !f.endsWith(".test.tsx"));
}

function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/** Quoted strings, template literals and one-line JSX text — everything that can reach a screen. */
export function renderedStrings(source: string): string[] {
  const body = stripComments(source);
  const literals = [...body.matchAll(/"([^"\\\n]*)"|'([^'\\\n]*)'|`([^`\\]*)`/g)].map(
    (m) => m[1] ?? m[2] ?? m[3] ?? "",
  );
  const jsxText = [...body.matchAll(/>([^<>{}\n]*[A-Za-z]{2}[^<>{}\n]*)</g)].map((m) => m[1]);
  return [...literals, ...jsxText].map((s) => s.trim()).filter((s) => s.length > 0);
}

function hits(text: string, pattern: RegExp): string[] {
  return [...text.matchAll(pattern)].map((m) => m[0]);
}

/** Every leaf string exported from copy.ts, with a dotted key for the failure message. */
function copyStrings(): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const visit = (prefix: string, value: unknown) => {
    if (typeof value === "string") {
      out.push([prefix, value]);
      return;
    }
    if (value && typeof value === "object") {
      for (const [k, v] of Object.entries(value)) visit(prefix ? `${prefix}.${k}` : k, v);
    }
  };
  for (const [name, value] of Object.entries(copy)) {
    if (typeof value === "function") continue;
    visit(name, value);
  }
  return out;
}

describe("the scan itself works", () => {
  it("finds the files it claims to scan", () => {
    const files = sourceFiles();
    expect(files.length).toBeGreaterThan(15);
    expect(files.some((f) => f.endsWith(".tsx"))).toBe(true);
    expect(files.some((f) => f.endsWith(path.join("ui", "copy.ts")))).toBe(true);
  });

  it("finds the strings it claims to scan", () => {
    expect(copyStrings().length).toBeGreaterThan(40);
    expect(copyStrings().map(([, v]) => v)).toContain("Demo accounts only.");
  });

  it("catches a planted code and a planted endpoint", () => {
    const planted = `const a = "Coming in B-12";\nconst b = "Health: /api/health";\n<p>PPE-21 shipped</p>`;
    const strings = renderedStrings(planted);
    expect(strings.flatMap((s) => hits(s, TICKET))).toEqual(["B-12", "PPE-21"]);
    expect(strings.flatMap((s) => hits(s, ENDPOINT))).toEqual(["/api/"]);
  });

  it("does not fault a code that only appears in a comment", () => {
    const commented = `/** Lands in B-12. */\n// also AT-18\nconst a = "Nothing needs action right now.";`;
    expect(renderedStrings(commented).flatMap((s) => hits(s, TICKET))).toEqual([]);
  });
});

describe("no ticket codes or internal endpoints in UI copy", () => {
  it("copy.ts exports no string with a ticket code", () => {
    const offenders = copyStrings()
      .filter(([, value]) => hits(value, TICKET).length > 0)
      .map(([key, value]) => `${key}: ${value}`);
    expect(offenders).toEqual([]);
  });

  it("copy.ts exports no string with an internal endpoint", () => {
    const offenders = copyStrings()
      .filter(([, value]) => hits(value, ENDPOINT).length > 0)
      .map(([key, value]) => `${key}: ${value}`);
    expect(offenders).toEqual([]);
  });

  it("copy.ts carries no ticket code at all, comments included", () => {
    const text = readFileSync(path.join(SRC, "ui", "copy.ts"), "utf8");
    expect(hits(text, TICKET)).toEqual([]);
    expect(hits(text, ENDPOINT)).toEqual([]);
  });

  it.each(sourceFiles().map((f) => path.relative(SRC, f)))(
    "%s renders no ticket code or internal endpoint",
    (relative) => {
      const strings = renderedStrings(readFileSync(path.join(SRC, relative), "utf8"));
      const offenders = strings.filter(
        (s) => hits(s, TICKET).length > 0 || hits(s, ENDPOINT).length > 0,
      );
      expect(offenders).toEqual([]);
    },
  );
});
