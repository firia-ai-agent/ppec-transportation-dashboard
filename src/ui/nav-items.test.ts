import { describe, expect, it } from "vitest";
import type { LucideIcon } from "lucide-react";
import { isCurrent, navItems } from "./nav-items";
import { nav } from "./copy";
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
  it("has the four §2 destinations, in document order", () => {
    expect(navItems.map((i) => [i.href, i.label])).toEqual([
      ["/today", nav.today],
      ["/exceptions", nav.exceptions],
      ["/setup", nav.setup],
      ["/health", nav.health],
    ]);
  });

  it("sees a non-empty state-icon set (so the guard below cannot pass vacuously)", () => {
    expect(stateIcons().size).toBeGreaterThan(30);
  });

  it("uses no icon that §3 or §7.1 gives a meaning to", () => {
    const used = stateIcons();
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
