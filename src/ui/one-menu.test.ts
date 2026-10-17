import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { LAYOUT, PAGES, ROLE_LADDER, homePathFor } from "@/auth/access";
import { navItems, navItemsFor } from "./nav-items";

/**
 * ONE MENU, ON EVERY SCREEN IT LINKS TO.
 *
 * The founder's 2026-10-17 walk of production: "When I click plan route it changes the page
 * entirely and the only way back is the browser back button. Live map, same problem. Ramp iPad
 * takes you to another page." All three were true, and all three had the same cause — the shell
 * was mounted by src/app/(app)/layout.tsx, which wraps `today`, `exceptions`, `setup` and
 * `health`, and those three screens are routes outside that group.
 *
 * So the rule this file holds is the one that was missing, stated as a property rather than as
 * three cases: **every destination in the menu renders the menu.** A screen added outside the
 * group, or moved out of it, fails here — nothing has to remember to check.
 *
 * Read off the filesystem and the source, because vitest runs in node with no DOM: what is
 * proved here is that each route's layout chain mounts the one shell component and hands it the
 * one caller → role mapping. That the browser then paints it is e2e/one-menu.spec.ts, which
 * measures the rail and the phone drawer on all three screens.
 */
const UI = __dirname;
const SRC = path.resolve(UI, "..");
const REPO = path.resolve(SRC, "..");
const APP = path.join(SRC, "app");

function read(file: string): string {
  return readFileSync(file, "utf8");
}

/** The source file of the page a menu item opens, from the access table's own row. */
function pageFileOf(href: string): string {
  const row = PAGES.find((p) => p.kind === "page" && p.path === href);
  expect(row, `no row in the access table for the menu item ${href}`).toBeDefined();
  return path.join(REPO, (row as { file: string }).file);
}

/**
 * Every layout.tsx Next would apply to a page, nearest first: its own folder, then each folder
 * above it up to src/app. This is the chain that decides whether a route has chrome at all.
 */
function layoutChainOf(pageFile: string): string[] {
  const chain: string[] = [];
  let dir = path.dirname(pageFile);
  for (;;) {
    const layout = path.join(dir, "layout.tsx");
    if (existsSync(layout)) chain.push(layout);
    if (dir === APP) break;
    dir = path.dirname(dir);
  }
  return chain;
}

/** Every layout under src/app that mounts the console shell. */
const shellLayouts = (function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return walk(full);
    return entry === "layout.tsx" && /<ConsoleShell\b/.test(read(full)) ? [full] : [];
  });
})(APP);

describe("every destination in the menu renders the menu", () => {
  it.each(navItems.map((item) => item.href))("%s is inside a layout that mounts the shell", (href) => {
    const chain = layoutChainOf(pageFileOf(href));
    const mounting = chain.filter((file) => /<ConsoleShell\b/.test(read(file)));
    expect(
      mounting.map((f) => path.relative(REPO, f)),
      `${href} renders no shell, so it has no menu and no way back`,
    ).not.toEqual([]);
    // Exactly one, or the header, the nav and the identity would each be on screen twice.
    expect(mounting, `${href} is wrapped by two shells`).toHaveLength(1);
  });

  it("is four layouts and no more: the group, and one per screen outside it", () => {
    expect(shellLayouts.map((f) => path.relative(REPO, f)).sort()).toEqual([
      "src/app/(app)/layout.tsx",
      "src/app/live-map/layout.tsx",
      "src/app/plan-routes/layout.tsx",
      "src/app/ramp-ipad/layout.tsx",
    ]);
  });

  /**
   * The menu a role gets must be the same list on all of them, which is a property of there
   * being one list and one filter — `navItemsFor`, which filters by `canOpenPage` — and of no
   * layout holding a second opinion about the caller's role. Both rails read the role from the
   * shell, and the shell reads it from `ConsoleShell`, so this asserts no layout computes one.
   */
  it("hands every screen the same role, from the one mapping in ConsoleShell", () => {
    for (const file of shellLayouts) {
      const source = read(file);
      expect(source, path.relative(REPO, file)).toMatch(/<ConsoleShell caller=\{caller\}/);
      expect(source, path.relative(REPO, file)).not.toMatch(/\brole=/);
    }
    expect(read(path.join(UI, "ConsoleShell.tsx"))).toMatch(
      /role=\{caller\.kind === "STAFF" \? caller\.role : null\}/,
    );
    // And both rails filter with that one function rather than listing destinations again.
    for (const component of ["NavRail.tsx", "MobileNav.tsx"]) {
      expect(read(path.join(UI, component)), component).toMatch(/navItemsFor\(role\)/);
    }
  });

  /** Nothing a role can reach from the menu is a screen the menu then disappears from. */
  it.each(ROLE_LADDER)("%s sees the same menu on every screen their menu offers", (role) => {
    const reachable = navItemsFor(role).map((item) => item.href);
    expect(reachable.length).toBeGreaterThan(0);
    for (const href of reachable) {
      const chain = layoutChainOf(pageFileOf(href));
      expect(chain.some((file) => /<ConsoleShell\b/.test(read(file))), `${role} → ${href}`).toBe(true);
    }
  });

  /**
   * The front desk is the role this mattered most for: they have no console page, so the ramp
   * iPad is where they land, and before this change the screen they start their day on was the
   * one screen with no way off it.
   */
  it("the front desk lands on a screen with the menu on it", () => {
    const landing = homePathFor({ kind: "STAFF", role: "FRONT_DESK", userId: "u-f" });
    expect(landing).toBe("/ramp-ipad");
    const chain = layoutChainOf(pageFileOf(landing));
    expect(chain.some((file) => /<ConsoleShell\b/.test(read(file))), landing).toBe(true);
    // And the menu they find there is their own two destinations, not a list of 403s.
    expect(navItemsFor("FRONT_DESK").map((item) => item.href)).toEqual(["/live-map", "/ramp-ipad"]);
  });
});

describe("one `main` landmark per screen (§9)", () => {
  /**
   * The three screens outside the group were built as whole pages and each is its own `<main>`.
   * The shell's content area is a `main` too, so each of those layouts passes `pageOwnsMain` and
   * the shell hands them a plain `#content` wrapper instead. Asserted from both ends, because
   * getting one of them wrong is either two `main` landmarks or none.
   */
  it.each(["plan-routes", "live-map", "ramp-ipad"])("%s brings its own main, and says so", (route) => {
    const dir = path.join(APP, route);
    const screens = readdirSync(dir).filter((f) => f.endsWith(".tsx") && f !== "layout.tsx");
    expect(screens.some((f) => /<main\b/.test(read(path.join(dir, f)))), route).toBe(true);
    expect(read(path.join(dir, "layout.tsx"))).toMatch(/pageOwnsMain/);
  });

  it("the group's own pages do not, so the shell is their main", () => {
    expect(read(path.join(APP, "(app)", "layout.tsx"))).not.toMatch(/pageOwnsMain/);
    const group = (function walk(dir: string): string[] {
      return readdirSync(dir).flatMap((entry) => {
        const full = path.join(dir, entry);
        if (statSync(full).isDirectory()) return walk(full);
        return entry.endsWith(".tsx") ? [full] : [];
      });
    })(path.join(APP, "(app)"));
    expect(group.filter((f) => /<main\b/.test(read(f)))).toEqual([]);
  });

  it("the skip link still has something to skip to either way", () => {
    const shell = read(path.join(UI, "AppShell.tsx"));
    expect(shell).toMatch(/href="#content"/);
    expect(shell).toMatch(/<Content id="content"/);
    expect(shell).toMatch(/const Content = pageOwnsMain \? "div" : "main"/);
  });
});

/**
 * The phone drawer, from the same walk: "You can't click on anything."
 *
 * The drawer was positioned against the hamburger's own 44 px wrapper, so `left: 0; right: 0`
 * measured 44 px — every label broken one word per line, Sign out crushed to a sliver. The rules
 * below are what make it a full-width sheet under the header instead; e2e/one-menu.spec.ts
 * measures the result at 390 px, which is the half a stylesheet assertion cannot prove.
 */
describe("§2 hamburger drawer, <768", () => {
  const css = read(path.join(UI, "MobileNav.module.css"));
  const phone = css.slice(css.indexOf("@media (max-width: 767px)"));

  it("does not position the hamburger's wrapper, so the drawer is not the button's width", () => {
    expect(phone).toMatch(/\.wrap \{[^}]*display: block/);
    expect(phone).not.toMatch(/\.wrap \{[^}]*position:/);
    // The header is what it anchors to instead, and the header is positioned for it.
    expect(read(path.join(UI, "AppShell.module.css"))).toMatch(/\.header \{[^}]*position: relative/);
  });

  it("spans the width it is anchored to, with no width cap left on it", () => {
    const drawer = css.slice(css.indexOf(".drawer {"), css.indexOf(".drawer[hidden]"));
    expect(drawer).toMatch(/left: 0/);
    expect(drawer).toMatch(/right: 0/);
    expect(drawer).toMatch(/top: 100%/);
    expect(drawer).not.toMatch(/max-width/);
    // Seven destinations plus the identity can be taller than a phone: scroll, never clip.
    expect(drawer).toMatch(/overflow-y: auto/);
  });

  it("keeps every row a §9 target and every label on one line", () => {
    const link = css.slice(css.indexOf(".link {"), css.indexOf('.link[aria-current="page"]'));
    expect(link).toMatch(/min-height: var\(--target-console\)/);
    expect(link).toMatch(/white-space: nowrap/);
    // Sign out is the row under them, and it is full width inside the drawer.
    expect(read(path.join(UI, "SignOutButton.module.css"))).toMatch(
      /min-height: var\(--target-console\)/,
    );
  });

  it("the three screens get the drawer, because they get the shell", () => {
    // The hamburger is in the shell's header, so "the menu button is missing on these three"
    // and "the menu is missing on these three" were one bug with one fix.
    expect(read(path.join(UI, "AppShell.tsx"))).toMatch(/<MobileNav /);
    expect(shellLayouts).toHaveLength(4);
    expect(LAYOUT.planRoutes).toBe("layout:plan-routes");
  });
});
