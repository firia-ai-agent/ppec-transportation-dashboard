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
/**
 * The only files allowed to import the seed: the two entry points, and the tests that need a
 * seeded database to assert against.
 *
 * src/modules/plan/sql.test.ts is the second of those — the plan board's three tables hold
 * foreign keys to the children and the vans, so the only honest way to exercise its statements is
 * against a database the seed has filled (PGlite, as src/db/migrations.test.ts does). A test is
 * not a build step, and the first assertion in this file is the one that proves no build or boot
 * entry point reaches the demo module at all.
 */
const ALLOWED_SEED_IMPORTERS = [
  "src/modules/demo/reset.ts",
  "scripts/demo-reset.ts",
  "src/modules/demo/seed.test.ts",
  // The drags and the child panel's Save, asserted against a seeded database (`pnpm test:db`).
  "src/modules/plan/place.db.test.ts",
  "src/modules/plan/sql.test.ts",
  // Two sessions saving at once, on the real local Postgres (`pnpm test:db`).
  "src/modules/plan/race.db.test.ts",
  // Ramp Confirm, proved against a seeded day to write one table and never the plan.
  "src/modules/plan/confirm.db.test.ts",
  /*
   * One saved plan read by four screens — the board, Today, Health and the Live map — against a
   * seeded day (S1, 2026-10-18). The memory store cannot reach the SQL those tiles are counted
   * from, so this one needs the rows.
   */
  "src/app/(app)/today/saved-plan.db.test.ts",
  /*
   * The Live map's plan reader and its test (#77). They import the demo **site id** constant —
   * `DEFAULT_DEMO_SITE`, which is where a synthetic day's rows live — and never the seeding
   * function: the first test above is the one that holds the real rule, and it still shows no
   * build or boot entry point reaching this module at all.
   */
  "src/modules/live-map/plan-read.ts",
  "src/modules/live-map/plan-read.test.ts",
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
    // The build chain itself, pinned exactly so that adding a step to it has to be a
    // deliberate edit here: db migration step, user seed, the MapLibre worker copy (a file
    // copy out of node_modules, no database and no network), next build. Nothing else.
    expect(pkg.scripts["vercel-build"]).toBe(
      "node scripts/vercel-db-step.mjs && tsx scripts/vercel-seed.ts && node scripts/copy-maplibre-worker.mjs && next build",
    );
  });

  it("the build-time user seed and the migration step carry no demo-module text at all", () => {
    for (const f of ["scripts/vercel-seed.ts", "scripts/vercel-db-step.mjs", "src/instrumentation.ts", "vercel.json"]) {
      const text = readFileSync(join(ROOT, f), "utf8");
      expect({ f, hit: /modules\/demo|seedStandardScenario|demo-reset/.test(text) }).toEqual({ f, hit: false });
    }
  });
});
