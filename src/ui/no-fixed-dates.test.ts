import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import * as copy from "./copy";

/**
 * NO SCREEN WRITES A DATE DOWN — Firia's ruling, 2026-10-17 4:50 PM ET.
 *
 * The founder's walk read "Wed, Oct 14" on the board, on Plan routes and on the ramp iPad, on
 * the 17th. Those three were not a typo: the scenario is a recording of one seeded Wednesday
 * and each screen was printing the recording's own day. The fix is one helper — `demoDateLabel`
 * in src/ui/service-date.ts, which maps a fixture day onto the day the demo is being given on —
 * and the thing that keeps it fixed is this file: a month-and-day written into a string is a
 * date that cannot be re-mapped, so there must not be one anywhere a screen can read it.
 *
 * Scope: every string literal and JSX text node under src/ui, src/app, src/domain, src/fixtures
 * and src/components, plus every string copy.ts exports. Comments are stripped first — a
 * comment saying "Tue, Oct 14" is a note about the fixture, not something a screen says — and
 * the ISO form (`2026-10-14`) is deliberately allowed: that is a *key*, the thing a row is
 * looked up by, and the whole point of the helper is that a key is not a label.
 */
const SRC = path.resolve(__dirname, "..");
const SCANNED = ["ui", "app", "domain", "fixtures", "components"].map((d) => path.join(SRC, d));
const EXTENSIONS = new Set([".ts", ".tsx"]);

/**
 * A date a person reads: a month in words next to a day number, with or without a weekday.
 * "Oct 14", "Wed, Oct 14", "October 14", "14 Oct". Not "{Mmm} {d}" — a placeholder is the
 * opposite of this problem — and not a bare year or a bare month.
 */
const MONTH =
  "(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec|January|February|March|April|June|July|August|September|October|November|December)";
const WRITTEN_DATE = new RegExp(`\\b(?:${MONTH}\\.?\\s+\\d{1,2}\\b|\\b\\d{1,2}\\s+${MONTH}\\b)`, "g");

/**
 * Quoted strings, template literals and one-line JSX text — everything that can reach a screen.
 * The same extraction src/ui/no-internals.test.ts uses, written out here rather than imported
 * from it: importing a spec file collects its tests into this one as well.
 */
function renderedStrings(source: string): string[] {
  const body = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const literals = [...body.matchAll(/"([^"\\\n]*)"|'([^'\\\n]*)'|`([^`\\]*)`/g)].map(
    (m) => m[1] ?? m[2] ?? m[3] ?? "",
  );
  const jsxText = [...body.matchAll(/>([^<>{}\n]*[A-Za-z]{2}[^<>{}\n]*)</g)].map((m) => m[1]);
  return [...literals, ...jsxText].map((s) => s.trim()).filter((s) => s.length > 0);
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return walk(full);
    return EXTENSIONS.has(path.extname(full)) ? [full] : [];
  });
}

function sourceFiles(): string[] {
  return SCANNED.flatMap(walk).filter(
    (f) => !f.endsWith(".test.ts") && !f.endsWith(".test.tsx"),
  );
}

/** Every leaf string exported from copy.ts, with a dotted key for the failure message. */
function copyStrings(): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const visit = (prefix: string, value: unknown) => {
    if (typeof value === "string") return void out.push([prefix, value]);
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
    expect(files.length).toBeGreaterThan(40);
    expect(files.some((f) => f.endsWith(".tsx"))).toBe(true);
    expect(files.some((f) => f.endsWith(path.join("ui", "service-date.ts")))).toBe(true);
  });

  it("catches a planted date, in a literal and in a JSX text node", () => {
    const planted = `const a = "Wed, Oct 14";\nconst b = "Service date: October 14";\n<p>14 Oct</p>`;
    const found = renderedStrings(planted).flatMap((s) => [...s.matchAll(WRITTEN_DATE)].map((m) => m[0]));
    expect(found).toEqual(["Oct 14", "October 14", "14 Oct"]);
  });

  it("lets through the things that are not a written date", () => {
    const fine = `const iso = "2026-10-14";\nconst fmt = "{Mmm} {d}";\nconst year = "2026";\nconst month = "October";`;
    expect(renderedStrings(fine).flatMap((s) => [...s.matchAll(WRITTEN_DATE)].map((m) => m[0]))).toEqual([]);
  });
});

describe("no screen writes a month and a day down", () => {
  it.each(sourceFiles().map((f) => path.relative(SRC, f)))("%s renders no fixed date", (relative) => {
    const strings = renderedStrings(readFileSync(path.join(SRC, relative), "utf8"));
    const offenders = strings.filter((s) => WRITTEN_DATE.test(s) && ((WRITTEN_DATE.lastIndex = 0), true));
    expect(offenders).toEqual([]);
  });

  it("copy.ts exports no string with a date in it", () => {
    const offenders = copyStrings()
      .filter(([, value]) => [...value.matchAll(WRITTEN_DATE)].length > 0)
      .map(([key, value]) => `${key}: ${value}`);
    expect(offenders).toEqual([]);
  });

  /**
   * ...and the one helper is the only thing that builds one. A second formatter is how the
   * board and the ramp ended up a day apart in the first place, so the whole `weekday + month
   * + day` recipe lives in src/ui/service-date.ts and nowhere else under src/.
   *
   * A formatter that asks for a weekday *alone* is not one of these and is left alone: the
   * board asks "is this day a Saturday?" to decide whether the day has runs on it at all
   * (src/domain/board/day.ts), which is a question about the calendar, not a label.
   */
  it("builds a written date in exactly one module", () => {
    const WRITTEN_DATE_FORMATTER = /weekday:\s*"(?:short|long)"[\s\S]{0,200}?month:\s*"(?:short|long)"/;
    const builders = sourceFiles().filter((f) =>
      WRITTEN_DATE_FORMATTER.test(readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "")),
    );
    expect(builders.map((f) => path.relative(SRC, f))).toEqual([path.join("ui", "service-date.ts")]);
  });
});
