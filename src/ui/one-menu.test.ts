import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { LAYOUT, PAGES, ROLE_LADDER, homePathFor } from "@/auth/access";
import { layout } from "./tokens";
import { navItems, navItemsFor } from "./nav-items";
import { splitTabs, TAB_SLOTS } from "./TabBar";

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
 * measures the rail and the phone tab bar on all three screens.
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
    for (const component of ["NavRail.tsx", "TabBar.tsx"]) {
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
   * The front desk is the role this mattered most for: they have no console page, so one of the
   * three screens outside the group is where they land, and before this change the screen they
   * start their day on was the one screen with no way off it.
   */
  it("the front desk lands on a screen with the menu on it", () => {
    const landing = homePathFor({ kind: "STAFF", role: "FRONT_DESK", userId: "u-f" });
    // Firia's final ruling, 2026-10-17 3:08 PM ET: "Front desk gets two tabs, Live map (their
    // home) and Ramp iPad." `homePathFor` is what sign-in, `/` and every refusal read.
    expect(landing).toBe("/live-map");
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
 * THE MENU ON A PHONE: a bottom tab bar, and no drawer left to open.
 *
 * Firia's final ruling, 2026-10-17 3:08 PM ET, which supersedes the 3:07 PM full-height panel:
 * "On phone, the menu is the bottom tab bar in #64, not the left panel. There's no hamburger
 * and no side panel on phone." So the rules below are about a bar that is always on screen, and
 * the first of them is that the drawer is *gone* — not hidden, not behind a flag, deleted, with
 * its stylesheet and its "Open menu" copy. e2e/one-menu.spec.ts measures the bar at 390 px on
 * every screen; what is proved here is that there is one and that nothing of the old one is
 * left to come back.
 */
describe("§2 bottom tab bar, <768", () => {
  const css = read(path.join(UI, "TabBar.module.css"));
  const phone = css.slice(css.indexOf("@media (max-width: 767px)"));

  it("has no hamburger and no drawer anywhere in the app", () => {
    for (const gone of ["MobileNav.tsx", "MobileNav.module.css"]) {
      expect(existsSync(path.join(UI, gone)), gone).toBe(false);
    }
    const sources = readdirSync(UI)
      .filter((f) => f.endsWith(".tsx") && !f.endsWith(".test.tsx"))
      .map((f) => [f, read(path.join(UI, f))] as const);
    for (const [file, source] of sources) {
      expect(source, file).not.toMatch(/MobileNav|data-nav-drawer|nav\.openMenu|nav\.closeMenu/);
    }
    // And the two words a hamburger needs are not sitting in copy.ts waiting for one.
    const copy = read(path.join(UI, "copy.ts"));
    expect(copy).not.toMatch(/openMenu|closeMenu/);
  });

  it("is on screen without being opened, and only below 768", () => {
    /*
     * The *bar* has nothing to toggle: no `hidden`, and the tabs are in the markup whatever
     * state anything is in. What it does have, since the menu grew past five destinations, is a
     * fifth slot that opens the rest (`splitTabs` below) — a tab, in the bar, opening a sheet
     * over the page. That is not the hamburger coming back and the next test is what says so:
     * the four destinations and the way to the others are on screen without a tap.
     */
    const component = read(path.join(UI, "TabBar.tsx"));
    expect(component).not.toMatch(/\shidden=/);
    expect(css).toMatch(/\.bar \{\s*display: none/);
    expect(phone).toMatch(/\.bar \{[^}]*display: block/);
    expect(phone).toMatch(/\.bar \{[^}]*position: fixed/);
    expect(phone).toMatch(/\.bar \{[^}]*bottom: 0/);
  });

  /**
   * FIVE SLOTS, AND "MORE" — REDESIGN-SPEC §9.2 ("five equal tabs") meeting §0's menu, which is
   * seven destinations for a console role. Seven tabs at 390 px is 55 px each: under the §9
   * target and unreadable with it. So four tabs and a fifth slot that opens the rest.
   *
   * What makes it not the deleted hamburger, stated as the rules it has to keep: the primary
   * tabs are always on screen, the thing that opens is in the frame rather than a panel from
   * the side, every row in it is a §9 target, and it closes on a selection, on Escape and on a
   * tap outside. The browser check measures all of that (e2e/rework-frame.spec.ts); this is
   * where the split itself is decided, so it is where the split is pinned down.
   */
  it("gives a role with more than five destinations four tabs and a More", () => {
    expect(TAB_SLOTS).toBe(5);
    const director = navItemsFor("DIRECTOR");
    expect(director.length).toBeGreaterThan(TAB_SLOTS);
    const split = splitTabs(director);
    expect(split.tabs).toHaveLength(TAB_SLOTS - 1);
    expect(split.tabs.length + split.overflow.length).toBe(director.length);
    // Nothing is lost and nothing is repeated: the bar still offers the whole menu.
    expect([...split.tabs, ...split.overflow]).toEqual(director);
    // The four with a tab of their own are the first four of §0's order, the day's own order.
    expect(split.tabs.map((i) => i.href)).toEqual([
      "/today",
      "/plan-routes",
      "/live-map",
      "/ramp-ipad",
    ]);
  });

  it("gives a role with five or fewer every one as a tab, and no More at all", () => {
    const frontDesk = navItemsFor("FRONT_DESK");
    expect(frontDesk.length).toBeLessThanOrEqual(TAB_SLOTS);
    expect(splitTabs(frontDesk)).toEqual({ tabs: frontDesk, overflow: [] });
  });

  it("the sheet closes the three ways anything that opens has to", () => {
    const component = read(path.join(UI, "TabBar.tsx"));
    // A selection: every link in it, and every tab beside it, closes on click.
    expect(component).toMatch(/onClick=\{close\}/);
    // Escape, from anywhere on the page, with the focus put back on the tab that opened it.
    expect(component).toMatch(/event\.key !== "Escape"/);
    expect(component).toMatch(/moreRef\.current\?\.focus\(\)/);
    // A tap outside, which is what the scrim is.
    expect(component).toMatch(/styles\.scrim/);
    // And focus goes *into* it when it opens, so the next Tab is inside it (§9).
    expect(component).toMatch(/sheetRef\.current\?\.querySelector\("a"\)\?\.focus\(\)/);
    // Every row in it is a §9 target, and it is a sheet on the bar — not a drawer from the side.
    expect(css).toMatch(/\.sheetItem \{[^}]*min-height: var\(--target-console\)/);
    expect(css).toMatch(/\.sheet \{[^}]*bottom: 100%/);
    expect(css).not.toMatch(/\.sheet \{[^}]*inset-inline-start: auto/);
  });

  it("gives every tab a §9 target, an icon and a label", () => {
    const tab = css.slice(css.indexOf(".tab {"), css.indexOf('.tab[aria-current="page"]'));
    expect(tab).toMatch(/min-height: var\(--layout-tab-bar-height\)/);
    expect(layout.tabBarHeight).toBe("64px");
    expect(Number.parseInt(layout.tabBarHeight, 10)).toBeGreaterThanOrEqual(44);
    const component = read(path.join(UI, "TabBar.tsx"));
    expect(component).toMatch(/<Icon size=\{icon\.nav\}/);
    expect(component).toMatch(/\{item\.label\}/);
  });

  it("marks the page you are on by more than colour", () => {
    expect(read(path.join(UI, "TabBar.tsx"))).toMatch(/aria-current=\{current \? "page" : undefined\}/);
    const current = css.slice(css.indexOf('.tab[aria-current="page"]'));
    expect(current).toMatch(/border-top-color: var\(--color-brand\)/);
    expect(current).toMatch(/font-weight: var\(--weight-semibold\)/);
  });

  it("sits clear of the iPhone home bar, and the page clears the bar", () => {
    expect(phone).toMatch(/padding-bottom: env\(safe-area-inset-bottom, 0px\)/);
    // The same two lengths on the page's side, so nothing is hidden behind the bar.
    const shell = read(path.join(UI, "AppShell.module.css"));
    const shellPhone = shell.slice(shell.indexOf("@media (max-width: 767px)"));
    expect(shellPhone).toMatch(
      /padding-bottom: calc\(var\(--layout-tab-bar-height\) \+ env\(safe-area-inset-bottom, 0px\)\)/,
    );
  });

  it("the three screens get the bar, because they get the shell", () => {
    expect(read(path.join(UI, "AppShell.tsx"))).toMatch(/<TabBar role=\{role\} \/>/);
    expect(shellLayouts).toHaveLength(4);
    expect(LAYOUT.planRoutes).toBe("layout:plan-routes");
  });
});
