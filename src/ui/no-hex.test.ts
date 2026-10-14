import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Token-drift guard (DESIGN-DIRECTION §10: "token-drift grep … clean"). src/ui/tokens.ts is the
 * single source of colour; nothing else under src/ may contain a colour literal, in TS, TSX or
 * CSS. Components read colours through the CSS custom properties tokens.ts emits.
 */
const SRC = path.resolve(__dirname, "..");

/** The only file allowed to hold hexes, plus the tests that assert on them. */
const ALLOWED = new Set([path.join(SRC, "ui", "tokens.ts")]);

const EXTENSIONS = new Set([".ts", ".tsx", ".css", ".js", ".jsx", ".mjs"]);

/** `#fff`, `#ffffff`, `#ffffffff` — the forms CSS and JS actually accept. */
const HEX = /#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b/g;

const OTHER_COLOUR_FUNCTIONS = /\b(?:rgba?|hsla?|oklch|lab|color-mix)\s*\(/g;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return entry === "node_modules" ? [] : walk(full);
    return EXTENSIONS.has(path.extname(full)) ? [full] : [];
  });
}

function scannableFiles(): string[] {
  return walk(SRC).filter((f) => !ALLOWED.has(f) && !f.endsWith(".test.ts") && !f.endsWith(".test.tsx"));
}

function findAll(file: string, pattern: RegExp): string[] {
  const text = readFileSync(file, "utf8");
  return [...text.matchAll(pattern)].map((m) => m[0]);
}

describe("colour literals live only in tokens.ts", () => {
  it("has files to scan (so a broken walk cannot pass silently)", () => {
    const files = scannableFiles();
    expect(files.length).toBeGreaterThan(20);
    expect(files.some((f) => f.endsWith(".tsx"))).toBe(true);
    expect(files.some((f) => f.endsWith(".css"))).toBe(true);
  });

  it("finds no hex colour outside tokens.ts", () => {
    const offenders = scannableFiles()
      .map((file) => ({ file: path.relative(SRC, file), hits: findAll(file, HEX) }))
      .filter((r) => r.hits.length > 0);
    expect(offenders).toEqual([]);
  });

  it("finds no rgb()/hsl()/oklch() colour either", () => {
    const offenders = scannableFiles()
      .map((file) => ({ file: path.relative(SRC, file), hits: findAll(file, OTHER_COLOUR_FUNCTIONS) }))
      .filter((r) => r.hits.length > 0);
    expect(offenders).toEqual([]);
  });

  it("still sees the hexes inside tokens.ts (the grep itself works)", () => {
    const hits = findAll(path.join(SRC, "ui", "tokens.ts"), HEX);
    expect(hits.length).toBeGreaterThanOrEqual(23);
  });
});
