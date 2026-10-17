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
    expect(navItems.map((i) => [i.href, i.label])).toEqual([
      ["/today", nav.today],
      // The planning surface and the fleet pane, between the board and the exceptions it
      // raises. Neither is one of §2's four: both were reachable only by typing the URL.
      ["/plan-routes", planRoutes.heading],
      ["/live-map", liveMap.heading],
      ["/exceptions", nav.exceptions],
      ["/setup", nav.setup],
      ["/health", nav.health],
      // Last, where PRD §14 lists it: the ramp iPad is not a console destination (§2), but the
      // front desk can open no console page, so the rail has to offer it.
      ["/ramp-ipad", rampIpad.heading],
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
 * THE MENU LISTS ONLY SCREENS THAT WORK — Firia's ruling, 2026-10-17 2:48 PM ET.
 *
 * Three of the seven destinations are a `Placeholder` saying the page is not built yet
 * (src/ui/Placeholder.tsx, `unbuilt` in copy.ts). A menu item that opens one of those is a
 * founder clicking into a dead end mid-demo, so each row carries an `inMenu` flag and the two
 * rails render the filtered list. The routes are untouched: still there, still guarded the same
 * way, still answering a typed URL exactly as before — which is the next test but one.
 */
describe("the menu lists only screens that work", () => {
  const REPO = path.resolve(__dirname, "..", "..");

  /** The page file behind a destination, from the access table's own row. */
  function sourceOf(href: string): string {
    const row = PAGES.find((p) => p.kind === "page" && p.path === href) as { file: string };
    expect(row, href).toBeDefined();
    return readFileSync(path.join(REPO, row.file), "utf8");
  }

  it("is the four built screens, in the order the rail had them", () => {
    expect(menuItems.map((i) => i.href)).toEqual([
      "/today",
      "/plan-routes",
      "/live-map",
      "/ramp-ipad",
    ]);
  });

  /**
   * The rule, not the list: whichever rows are on the menu, none of them may open a page that
   * renders the "{page} isn't built yet" copy. Turning one back on (PR #60's Health & ROI, PR
   * #61's Exceptions) passes this the moment the page behind it is a real screen, and fails it
   * the moment the flag is flipped ahead of the build.
   */
  it("no item on the menu opens a page that says it is not built", () => {
    const unbuilt = menuItems.filter((item) => /\bunbuilt\b|<Placeholder\b/.test(sourceOf(item.href)));
    expect(unbuilt.map((i) => i.label)).toEqual([]);
  });

  it("the three that are off are off for a reason, and are still routes", () => {
    const off = navItems.filter((item) => !item.inMenu).map((i) => i.href);
    expect(off).toEqual(["/exceptions", "/setup", "/health"]);
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
});

describe("isCurrent", () => {
  it("marks the section, not just the exact path", () => {
    expect(isCurrent("/today", "/today")).toBe(true);
    expect(isCurrent("/today/c8", "/today")).toBe(true);
    expect(isCurrent("/todayish", "/today")).toBe(false);
    expect(isCurrent("/setup", "/today")).toBe(false);
  });
});
