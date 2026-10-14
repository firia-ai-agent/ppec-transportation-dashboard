import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

/**
 * The scenario seed truncates data. It must therefore be reachable only from the two deliberate entry
 * points (POST /api/demo/reset and scripts/demo-reset.ts) — never from a build or boot step, where it
 * would wipe a deployment's data on deploy. These tests walk the real import graph, so adding an import
 * anywhere in a build path fails here rather than in production.
 */
const ROOT = resolve(__dirname, "..", "..", "..");
const DEMO_DIR = "src/modules/demo";
const SEED_FILE = "src/modules/demo/seed.ts";

/** Steps that run during `vercel-build` or at server boot. */
const BUILD_AND_BOOT_ENTRIES = [
  "scripts/vercel-db-step.mjs",
  "scripts/vercel-seed.ts",
  "src/instrumentation.ts",
  "next.config.ts",
];
/** The only files allowed to import the seed. */
const ALLOWED_SEED_IMPORTERS = [
  "src/modules/demo/reset.ts",
  "scripts/demo-reset.ts",
  "src/modules/demo/seed.test.ts",
];

const SRC_RE = /\.(ts|tsx|mjs|js)$/;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (/node_modules|\.next/.test(p)) continue;
    if (statSync(p).isDirectory()) walk(p, out);
    else if (SRC_RE.test(p)) out.push(relative(ROOT, p));
  }
  return out;
}

const PROJECT_FILES = [...walk(join(ROOT, "src")), ...walk(join(ROOT, "scripts"))]
  .concat(["next.config.ts", "drizzle.config.ts"].filter((f) => existsSync(join(ROOT, f))));

const IMPORT_RE = /(?:^|\n)\s*(?:import|export)[\s\S]{0,400}?from\s+["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)|\brequire\(\s*["']([^"']+)["']\s*\)/g;

function specifiers(file: string): string[] {
  const text = readFileSync(join(ROOT, file), "utf8");
  const out: string[] = [];
  for (const m of text.matchAll(IMPORT_RE)) out.push(m[1] ?? m[2] ?? m[3]);
  return out.filter(Boolean);
}

/** Resolve a local import to a repo-relative file, or null for packages. */
function resolveLocal(from: string, spec: string): string | null {
  const base = spec.startsWith("@/") ? join(ROOT, "src", spec.slice(2))
    : spec.startsWith(".") ? resolve(ROOT, dirname(from), spec)
      : null;
  if (!base) return null;
  for (const cand of [base, `${base}.ts`, `${base}.tsx`, `${base}.mjs`, `${base}.js`, join(base, "index.ts")]) {
    if (existsSync(cand) && statSync(cand).isFile()) return relative(ROOT, cand);
  }
  return null;
}

function closure(entry: string): Set<string> {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length) {
    const f = queue.pop()!;
    if (seen.has(f) || !existsSync(join(ROOT, f))) continue;
    seen.add(f);
    for (const s of specifiers(f)) {
      const r = resolveLocal(f, s);
      if (r) queue.push(r);
    }
  }
  return seen;
}

describe("the scenario seed never runs from a build step", () => {
  it("the import graph proves it: no build or boot entry point reaches the demo module", () => {
    for (const entry of BUILD_AND_BOOT_ENTRIES) {
      expect(existsSync(join(ROOT, entry))).toBe(true);
      const reached = [...closure(entry)].filter((f) => f.startsWith(DEMO_DIR));
      expect({ entry, reached }).toEqual({ entry, reached: [] });
    }
  });

  it("the reverse direction holds too: only the two entry points (and their tests) import the seed", () => {
    const importers = PROJECT_FILES.filter((f) =>
      specifiers(f).some((s) => resolveLocal(f, s) === SEED_FILE));
    expect(importers.sort()).toEqual([...ALLOWED_SEED_IMPORTERS].sort());
  });

  it("no npm script except demo:reset mentions the reset, and vercel-build does not", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> };
    expect(pkg.scripts["vercel-build"]).toBeDefined();
    for (const [name, cmd] of Object.entries(pkg.scripts)) {
      if (name === "demo:reset") continue;
      expect({ name, hit: /demo-reset|demo:reset|seedStandardScenario/.test(cmd) }).toEqual({ name, hit: false });
    }
    // The build chain itself: db migration step, user seed, next build. Nothing else.
    expect(pkg.scripts["vercel-build"]).toBe("node scripts/vercel-db-step.mjs && tsx scripts/vercel-seed.ts && next build");
  });

  it("the build-time user seed and the migration step carry no demo-module text at all", () => {
    for (const f of ["scripts/vercel-seed.ts", "scripts/vercel-db-step.mjs", "src/instrumentation.ts", "vercel.json"]) {
      const text = readFileSync(join(ROOT, f), "utf8");
      expect({ f, hit: /modules\/demo|seedStandardScenario|demo-reset/.test(text) }).toEqual({ f, hit: false });
    }
  });
});
