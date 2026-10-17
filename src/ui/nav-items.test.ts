import { describe, expect, it } from "vitest";
import { Flag, type LucideIcon } from "lucide-react";
import { pageLabel } from "@/auth/access";
import { isCurrent, navItems } from "./nav-items";
import { nav, phonePanel, planRoutes } from "./copy";
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
  it("has the four §2 destinations, Plan routes and Family texts, in document order", () => {
    expect(navItems.map((i) => [i.href, i.label])).toEqual([
      ["/today", nav.today],
      // The planning surface, between the board and the exceptions it raises. Not one of §2's
      // four: it is a destination staff could previously only reach by typing the URL.
      ["/plan-preview", planRoutes.heading],
      // The persona-phone panel (§6.3), for the same reason: the text a family was sent was
      // readable only by typing the URL.
      ["/phone-preview", phonePanel.heading],
      ["/exceptions", nav.exceptions],
      ["/setup", nav.setup],
      ["/health", nav.health],
    ]);
  });

  it("labels Plan routes with the words its own screen uses, not a second string", () => {
    const plan = navItems.find((item) => item.href === "/plan-preview");
    expect(plan?.label).toBe(planRoutes.heading);
    expect(pageLabel("/plan-preview")).toBe(plan?.label);
  });

  it("labels Family texts with its own screen's heading too", () => {
    const phone = navItems.find((item) => item.href === "/phone-preview");
    expect(phone?.label).toBe(phonePanel.heading);
    expect(pageLabel("/phone-preview")).toBe(phone?.label);
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
