import { describe, expect, it } from "vitest";
import { Flag, type LucideIcon } from "lucide-react";
import { pageLabel } from "@/auth/access";
import { isCurrent, navItems } from "./nav-items";
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

describe("isCurrent", () => {
  it("marks the section, not just the exact path", () => {
    expect(isCurrent("/today", "/today")).toBe(true);
    expect(isCurrent("/today/c8", "/today")).toBe(true);
    expect(isCurrent("/todayish", "/today")).toBe(false);
    expect(isCurrent("/setup", "/today")).toBe(false);
  });
});
