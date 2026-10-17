import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PAGES } from "@/auth/access";
import { shellComesFromLayout } from "./refused-frame";

/**
 * THE REFUSAL HAS A FRAME, AND EXACTLY ONE.
 *
 * Vera's review, 2026-10-17 4:19 PM ET: "This page isn't part of your role" must always render
 * inside the app frame — the header, the account menu with Sign out in it, and the menu this
 * role carries (the bottom tab bar on a phone, the left rail at a desk) — and never as a bare
 * card whose only exit is the "Go to …" link.
 *
 * Twelve `forbidden.tsx` boundaries used to answer that question one file at a time:
 * src/app/forbidden.tsx mounted the shell itself and the other eleven rendered a bare
 * `<NoAccess />`. Measured on a production build of this branch at 1440 px, that came out two
 * different ways — a refusal under /live-map arrived with one header and both menus, because
 * the folder's layout had mounted the shell before the page inside it refused, while /whoami
 * and the three moved addresses have no layout and arrived with no header and no menu at all.
 *
 * So the rule is stated here as a property over every boundary in the app rather than as a
 * list of four fixes: **each one renders the one shared component, and the card ends up inside
 * exactly one frame.** The browser half — that the frame is painted, at 390 and at 1440 — is
 * e2e/one-menu.spec.ts, which walks a front-desk session onto the card at /refusal-check.
 */
const UI = __dirname;
const SRC = path.resolve(UI, "..");
const REPO = path.resolve(SRC, "..");
const APP = path.join(SRC, "app");

function read(file: string): string {
  return readFileSync(file, "utf8");
}

const rel = (file: string) => path.relative(REPO, file).split(path.sep).join("/");

/** Every 403 boundary in the app, nearest-folder-first order being irrelevant here. */
const boundaries = (function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return walk(full);
    return entry === "forbidden.tsx" ? [full] : [];
  });
})(APP).sort();

/**
 * Every layout.tsx Next applies to a file in this folder, nearest first: the folder's own, then
 * each folder above it up to src/app. The same walk src/ui/one-menu.test.ts uses, and the thing
 * `shellComesFromLayout` has to agree with — it answers from the access table's layout rows,
 * and this is the filesystem it is a claim about.
 */
function layoutChainOf(file: string): string[] {
  const chain: string[] = [];
  let dir = path.dirname(file);
  for (;;) {
    const layout = path.join(dir, "layout.tsx");
    if (existsSync(layout)) chain.push(layout);
    if (dir === APP) break;
    dir = path.dirname(dir);
  }
  return chain;
}

/** How many layouts above this boundary mount the console shell. */
function shellsAbove(file: string): number {
  return layoutChainOf(file).filter((layout) => /<ConsoleShell\b/.test(read(layout))).length;
}

/** The page this boundary names, or `undefined` for the refusal with no page to name. */
function pathNamedBy(file: string): string | undefined {
  return /<RefusedPage path="([^"]+)"/.exec(read(file))?.[1];
}

describe("every forbidden.tsx renders the one shared framed component", () => {
  it("found all twelve boundaries, one per guarded page and one at the root", () => {
    expect(boundaries.map(rel)).toEqual([
      "src/app/(app)/exceptions/forbidden.tsx",
      "src/app/(app)/health/forbidden.tsx",
      "src/app/(app)/setup/forbidden.tsx",
      "src/app/(app)/today/forbidden.tsx",
      "src/app/forbidden.tsx",
      "src/app/live-map/forbidden.tsx",
      "src/app/map-preview/forbidden.tsx",
      "src/app/plan-preview/forbidden.tsx",
      "src/app/plan-routes/forbidden.tsx",
      "src/app/ramp-ipad/forbidden.tsx",
      "src/app/ramp-preview/forbidden.tsx",
      "src/app/whoami/forbidden.tsx",
    ]);
  });

  it.each(boundaries.map(rel))("%s renders RefusedPage and nothing else", (file) => {
    const source = read(path.join(REPO, file));
    expect(source).toMatch(/import \{ RefusedPage \} from "@\/ui\/RefusedPage";/);
    expect(source).toMatch(/return <RefusedPage( path="[^"]+")? \/>;/);
    // No shell wiring of its own: that is the duplication this component replaced.
    expect(source).not.toMatch(/ConsoleShell|AppShell|getCaller/);
    // And no second card: the boundary names a page, the shared component renders the screen.
    expect(source).not.toMatch(/<NoAccess\b/);
  });

  it("the refusal's frame is wired in one file, and it is the shared component", () => {
    const mounting = readdirSync(UI)
      .filter((f) => f.endsWith(".tsx") && !f.endsWith(".test.tsx"))
      .filter((f) => /<ConsoleShell\b/.test(read(path.join(UI, f))));
    expect(mounting).toEqual(["RefusedPage.tsx"]);
  });
});

describe("the card ends up inside exactly one frame", () => {
  it.each(boundaries.map(rel))("%s", (file) => {
    const full = path.join(REPO, file);
    const framedByLayout = shellsAbove(full);
    // Nothing is wrapped twice by layouts — src/ui/one-menu.test.ts states that for the screens.
    expect(framedByLayout, `${file} has ${framedByLayout} shells above it`).toBeLessThanOrEqual(1);
    /*
     * The one claim the shared component makes about the filesystem, checked against it: it
     * reads the access table's layout rows to decide whether a frame is already around the
     * card. A screen moved into or out of a group changes the answer, and this fails first.
     */
    const fromTheTable = shellComesFromLayout(pathNamedBy(full));
    expect(fromTheTable, `${file}: the table says ${fromTheTable}, the folders say ${framedByLayout}`)
      .toBe(framedByLayout === 1);
    // Layout or component, the card is framed, and framed once.
    expect(framedByLayout + (fromTheTable ? 0 : 1)).toBe(1);
  });

  it("names a page the access table holds, or no page at all", () => {
    for (const file of boundaries) {
      const named = pathNamedBy(file);
      if (!named) {
        expect(rel(file)).toBe("src/app/forbidden.tsx");
        continue;
      }
      expect(PAGES.map((row) => row.path)).toContain(named);
    }
  });

  /**
   * The five boundaries with nothing above them but the document shell, named, because they
   * are the fix: four of them (the three moved addresses and /whoami) arrived with no header,
   * no menu and one link off the card, and the fifth is the root boundary, which was the one
   * file that had already been given a frame by hand.
   */
  it("the boundaries with no layout above them are framed by the component", () => {
    const alone = boundaries.filter((file) => shellsAbove(file) === 0).map(rel);
    expect(alone).toEqual([
      "src/app/forbidden.tsx",
      "src/app/map-preview/forbidden.tsx",
      "src/app/plan-preview/forbidden.tsx",
      "src/app/ramp-preview/forbidden.tsx",
      "src/app/whoami/forbidden.tsx",
    ]);
    for (const file of alone) expect(shellComesFromLayout(pathNamedBy(path.join(REPO, file)))).toBe(false);
  });
});

/**
 * Who is refused is not what this change is about, and `shellComesFromLayout` must not be able
 * to become part of that answer: it is handed a path and reads the table's layout rows, so it
 * is asserted here to be a question about folders only.
 */
describe("it changes what a refusal looks like, not who is refused", () => {
  it("takes no caller and reads no session", () => {
    const source = read(path.join(UI, "refused-frame.ts"));
    expect(source).toMatch(/export function shellComesFromLayout\(path\?: string\): boolean/);
    /*
     * The guard is untouched, and neither file reaches for it: no import of the page guard, and
     * no call into the decision functions. (Both name `requirePage` in prose, which is where a
     * reference to it belongs.)
     */
    for (const file of ["refused-frame.ts", "RefusedPage.tsx"]) {
      const code = read(path.join(UI, file)).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
      expect(code, file).not.toMatch(/page-guard|pageOutcome\(|canOpenPage\(|requirePage\(/);
    }
  });

  it("answers for a page the table does not hold the way the root boundary needs", () => {
    expect(shellComesFromLayout(undefined)).toBe(false);
    expect(shellComesFromLayout("/not-a-page")).toBe(false);
  });
});
