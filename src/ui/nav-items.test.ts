import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Flag, type LucideIcon } from "lucide-react";
import { PAGES, ROLE_LADDER, pageLabel } from "@/auth/access";
import { isCurrent, menuItems, navItems, navItemsFor } from "./nav-items";
import { liveMap, nav, planRoutes, rampIpad } from "./copy";
import { sourceModes, vocabularies } from "./states";

/**
 * DESIGN-DIRECTION §3 makes an icon mean a state ("`octagon-alert` = Needs action"). A nav icon
 * that reuses one of those icons turns the rail into a false status light, so the two sets must
 * stay disjoint — this compares the icon *components*, not their names, so an alias cannot slip
 * past. The same goes for the §7.1 source-mode icons (`flask-conical` is the demo marker).
 */
function stateIcons(): Map<LucideIcon, string> {
  const used = new Map<LucideIcon, string>();
  for (const [vocabulary, states] of Object.entries(vocabularies)) {
    for (const [state, descriptor] of Object.entries(states)) {
      if (!used.has(descriptor.icon)) used.set(descriptor.icon, `${vocabulary}.${state}`);
    }
  }
  for (const [mode, descriptor] of Object.entries(sourceModes)) {
    if (!used.has(descriptor.icon)) used.set(descriptor.icon, `source_mode.${mode}`);
  }
  return used;
}

describe("nav icons", () => {
  it("has every destination this app has, in document order", () => {
    /*
     * REDESIGN-SPEC §0's order: the day's four screens, in the order the day happens, then the
     * family thread, then the two surfaces that are about the day rather than in it. The ramp
     * iPad moved up from last (where PRD §14 lists it) because below 768 the first four
     * destinations are the four with a tab of their own, and one of them has to be the front
     * desk's own surface.
     */
    expect(navItems.map((i) => [i.href, i.label])).toEqual([
      ["/today", nav.today],
      ["/plan-routes", planRoutes.heading],
      ["/live-map", liveMap.heading],
      ["/ramp-ipad", rampIpad.heading],
      ["/family-texts", nav.familyTexts],
      ["/exceptions", nav.exceptions],
      ["/health", nav.health],
      // Off the menu, and still a destination: §0 moves van counts onto the ramp iPad.
      ["/setup", nav.setup],
    ]);
  });

  it("labels the three surfaces §2 does not name with the words their own screens use", () => {
    for (const href of ["/plan-routes", "/live-map", "/ramp-ipad"]) {
      const item = navItems.find((i) => i.href === href);
      expect(item, href).toBeDefined();
      // The access table's label and the rail's label are the same string, which is the
      // screen's own heading: there is no second copy of any of these names.
      expect(pageLabel(href)).toBe(item?.label);
      expect(item?.label.length).toBeGreaterThan(0);
    }
    expect(navItems.find((i) => i.href === "/plan-routes")?.label).toBe(planRoutes.heading);
    expect(navItems.find((i) => i.href === "/live-map")?.label).toBe(liveMap.heading);
    expect(navItems.find((i) => i.href === "/ramp-ipad")?.label).toBe(rampIpad.heading);
  });

  it("names the ramp iPad the way PRD §14 names it (l.1055, l.1061)", () => {
    expect(rampIpad.heading).toBe("Ramp iPad");
  });

  it("every label is also the label the access table carries for that row", () => {
    for (const item of navItems) {
      expect(pageLabel(item.href), item.href).toBe(item.label);
    }
  });

  it("gives Exceptions & Approvals the `flag` icon (Vera's answer, 2026-10-14)", () => {
    const exceptions = navItems.find((item) => item.href === "/exceptions");
    expect(exceptions?.icon).toBe(Flag);
  });

  it("sees a non-empty state-icon set (so the guard below cannot pass vacuously)", () => {
    expect(stateIcons().size).toBeGreaterThan(30);
  });

  it("uses no icon that §3 or §7.1 gives a meaning to", () => {
    const used = stateIcons();
    // Named explicitly because `flag` is the one Vera chose for the rail: if §3 ever adopts it
    // for a state, this is the assertion that has to be answered before the state lands.
    expect(used.has(Flag), "§3/§7.1 must not claim `flag`").toBe(false);
    const collisions = navItems
      .filter((item) => used.has(item.icon))
      .map((item) => `${item.label} → ${used.get(item.icon)}`);
    expect(collisions).toEqual([]);
  });

  it("gives every destination its own icon", () => {
    expect(new Set(navItems.map((i) => i.icon)).size).toBe(navItems.length);
  });
});

/**
 * NOTHING ON THE MENU 404s OR DEAD-ENDS — the founder's rule, 2026-10-17 6:19 PM ET, which
 * supersedes Firia's 2:48 PM ET "the menu lists only screens that work".
 *
 * The two rulings answer the same complaint and the second one answers it better. 2:48 PM took
 * three destinations off the menu because each opened a `Placeholder` saying the page was not
 * built — a founder clicking into a dead end mid-demo. 6:19 PM puts the menu back and fixes the
 * pages instead: a screen whose data is not built is its own title and one line about what it
 * will hold (src/ui/StubPage.tsx), which is a screen rather than an apology. What is still
 * barred, and is the test below, is a menu item that opens the "isn't built yet" copy — and
 * what is new beside it is that every item has a page at all, because `/family-texts` answered
 * 404 from the menu on production.
 *
 * `inMenu` is still the mechanism, and Setup is the one row that is off: §0 moves van counts
 * onto the ramp iPad, so the screen behind it is being taken apart rather than finished. Its
 * route, its row and its answer to a typed URL are untouched.
 */
describe("the menu lists only screens that work", () => {
  const REPO = path.resolve(__dirname, "..", "..");

  /** The page file behind a destination, from the access table's own row. */
  function sourceOf(href: string): string {
    const row = PAGES.find((p) => p.kind === "page" && p.path === href) as { file: string };
    expect(row, href).toBeDefined();
    return readFileSync(path.join(REPO, row.file), "utf8");
  }

  it("is every destination but Setup, in §0's order", () => {
    expect(menuItems.map((i) => i.href)).toEqual([
      "/today",
      "/plan-routes",
      "/live-map",
      "/ramp-ipad",
      "/family-texts",
      "/exceptions",
      "/health",
    ]);
  });

  /**
   * NOTHING ON THE MENU 404s — the founder's rule, 2026-10-17 6:19 PM ET, and the reason
   * `/family-texts` is a page at all: the walk of production found it answering 404 from a
   * menu that linked to it.
   *
   * Asked of the filesystem, not of a list: every menu item has a row in the access table and
   * the file that row names exists. A menu item added without a page fails here.
   */
  it("every menu item has a row and a page file behind it", () => {
    for (const item of menuItems) {
      const row = PAGES.find((p) => p.kind === "page" && p.path === item.href);
      expect(row, `${item.href} is on the menu with no row in the access table`).toBeDefined();
      expect(sourceOf(item.href).length, item.href).toBeGreaterThan(0);
    }
  });

  /**
   * The rule, not the list: whichever rows are on the menu, none of them may open a page that
   * renders the "{page} isn't built yet" copy. A screen whose data is not built yet is its own
   * title and one line instead (src/ui/StubPage.tsx) — a founder clicking a menu item mid-demo
   * lands on a screen, never on a notice about the build.
   */
  it("no item on the menu opens a page that says it is not built", () => {
    const unbuilt = menuItems.filter((item) => /\bunbuilt\b|<Placeholder\b/.test(sourceOf(item.href)));
    expect(unbuilt.map((i) => i.label)).toEqual([]);
  });

  it("the one that is off is off for a reason, and is still a route", () => {
    const off = navItems.filter((item) => !item.inMenu).map((i) => i.href);
    // Setup alone, and §0's reason rather than the build's: van counts move to the ramp iPad.
    expect(off).toEqual(["/setup"]);
    // Off the menu is not deleted and not closed: every one still has a row and a page.
    for (const href of off) {
      expect(PAGES.some((p) => p.kind === "page" && p.path === href), href).toBe(true);
      expect(sourceOf(href)).toMatch(/requirePage/);
    }
  });

  it("is the same filtered list at both widths, for every role", () => {
    for (const role of ROLE_LADDER) {
      const theirs = navItemsFor(role);
      // Nothing off the menu reaches a role's list...
      expect(theirs.every((item) => item.inMenu), role).toBe(true);
      // ...and the list is the menu narrowed by the access table, nothing else.
      expect(theirs).toEqual(menuItems.filter((item) => theirs.includes(item)));
    }
    expect(navItemsFor("FRONT_DESK").map((i) => i.href)).toEqual(["/live-map", "/ramp-ipad"]);
    expect(navItemsFor(null)).toEqual([]);
  });

  /**
   * Approvals is reachable and is not a menu item (REDESIGN-SPEC §9.2: "Approvals is the For
   * you tab inside Family texts, not a menu item"). Both halves, because either one alone is a
   * bug: on the menu it is an eighth rail item the spec does not have, and with no way to it
   * it is an address nobody can reach.
   */
  it("keeps Approvals off the menu and reachable from Family texts", () => {
    expect(navItems.some((item) => item.href === "/approvals")).toBe(false);
    expect(sourceOf("/family-texts")).toMatch(/href="\/approvals"/);
  });
});

describe("isCurrent", () => {
  it("marks the section, not just the exact path", () => {
    expect(isCurrent("/today", "/today")).toBe(true);
    expect(isCurrent("/today/c8", "/today")).toBe(true);
    expect(isCurrent("/todayish", "/today")).toBe(false);
    expect(isCurrent("/setup", "/today")).toBe(false);
  });
});
