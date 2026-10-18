import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The two import rules Firia made binding on 2026-10-17 at 5:48 PM ET, enforced by reading the
 * source rather than by asking everyone to remember them.
 *
 * **Rule 5 — no fixtures in a screen.** A rebuilt screen reads the day through one domain
 * interface (src/domain/day/source.ts) and never from `@/fixtures` or
 * `src/modules/demo/fixtures`. That is what stopped there being three rosters and three fleets:
 * a screen that reaches into a fixture is a screen that can disagree with the one the next
 * screen reached into ("Noah O." against "Noah O.", a board "Van 3" that was the map's V4).
 *
 * **Rule 2 — no solver in a screen.** The capacity solver makes no placement decision anywhere:
 * placement is `src/domain/plan/fit.ts`, once. A screen that imports `domain/solver` has either
 * started asking it something or borrowed one of its types, and both are how the second answer
 * crept back in last time.
 */

const SRC = path.join(__dirname, "..");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

const code = (dir: string) =>
  walk(path.join(SRC, dir)).filter((file) => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file));

const rel = (file: string) => path.relative(SRC, file).replaceAll(path.sep, "/");

/** Every `from "…"` in a file, which is every way it can reach another module. */
function importsOf(file: string): string[] {
  const source = readFileSync(file, "utf8");
  return [...source.matchAll(/from\s+["']([^"']+)["']|import\(["']([^"']+)["']\)/g)].map(
    (match) => match[1] ?? match[2],
  );
}

/** The screens this PR rebuilt (redesign spec §1 and §2). */
const REBUILT = ["app/plan-routes", "app/ramp-ipad"];

describe("rule 5: the rebuilt screens read the day through one interface", () => {
  it("imports no fixture module anywhere under the rebuilt screens", () => {
    const offenders = REBUILT.flatMap((dir) =>
      code(dir)
        .map((file) => ({ file: rel(file), bad: importsOf(file).filter(isFixture) }))
        .filter((hit) => hit.bad.length > 0),
    );
    expect(offenders).toEqual([]);
  });

  it("covers screens that exist, so a renamed directory fails here rather than passing", () => {
    for (const dir of REBUILT) expect(code(dir).length, dir).toBeGreaterThan(0);
  });
});

describe("rule 2: no screen or component imports the capacity solver", () => {
  it("finds no import of domain/solver under src/app or src/components", () => {
    const offenders = ["app", "components"].flatMap((dir) =>
      code(dir)
        .map((file) => ({ file: rel(file), bad: importsOf(file).filter(isSolver) }))
        .filter((hit) => hit.bad.length > 0),
    );
    expect(offenders).toEqual([]);
  });
});

function isFixture(specifier: string): boolean {
  return (
    specifier.startsWith("@/fixtures") ||
    specifier.includes("modules/demo/fixtures") ||
    /(^|\/)fixtures\//.test(specifier)
  );
}

function isSolver(specifier: string): boolean {
  return specifier === "@/domain/solver" || specifier.startsWith("@/domain/solver/") || /(^|\/)domain\/solver/.test(specifier);
}
