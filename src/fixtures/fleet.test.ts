/**
 * Privacy shape of the fleet fixtures (PRD §18.1, MOCKS-AND-DEMO §1-2, COPY-GUIDE §3).
 *
 * These fixtures are the ones the ramp check and the capacity solver render, so a name added
 * here reaches a screen. §3 fixes the form: "first name + last initial, synthetic only
 * ('Mia R.')", with siblings sharing the family's initial. Nothing here asserts the solver's
 * behaviour — src/domain/solver/solver.test.ts owns that.
 */
import { describe, expect, it } from "vitest";
import { ARRIVING_VEHICLES, CHILDREN, FLEET, SERVICE_DATE, STOPS } from "./fleet";

/** "Mia R." / "Zoe P." — one given name, then one initial and a period. Nothing more. */
const FIRST_NAME_LAST_INITIAL = /^[A-Z][a-z]+ [A-Z]\.$/;

describe("children are named the way COPY-GUIDE §3 allows", () => {
  it("has children to check", () => {
    expect(CHILDREN.length).toBeGreaterThan(4);
  });

  it.each(CHILDREN.map((child) => [child.token, child.displayName]))(
    "%s is first name + last initial: %s",
    (_token, displayName) => {
      expect(displayName).toMatch(FIRST_NAME_LAST_INITIAL);
    },
  );

  it("carries no full surname anywhere in a rendered name", () => {
    for (const child of CHILDREN) {
      const [, family] = child.displayName.split(" ");
      expect(family, `${child.token} spells out a surname`).toHaveLength(2);
    }
  });

  it("gives siblings the same family initial, so a family reads as one", () => {
    const byFamily = new Map<string, string[]>();
    for (const child of CHILDREN) {
      const initial = child.displayName.split(" ")[1];
      byFamily.set(initial, [...(byFamily.get(initial) ?? []), child.token]);
    }
    // C4 and C5 are the one sibling pair the demo scenario needs (PRD §18.1) — F4's two
    // children, who share a phone and now share their initial here too, because the names are
    // the scenario's (src/modules/demo/fixtures/names.ts).
    expect(byFamily.get("N.")).toEqual(["C4", "C5"]);
  });

  it("identifies a child by an opaque token, never by the name", () => {
    for (const child of CHILDREN) {
      expect(child.token).toMatch(/^C\d+$/);
    }
    expect(new Set(CHILDREN.map((c) => c.token)).size).toBe(CHILDREN.length);
  });
});

describe("the rest of the fixture stays synthetic", () => {
  it("stops are public landmarks, never a home address", () => {
    for (const label of Object.values(STOPS)) {
      // A street number would mean somebody's address; landmarks are named, not numbered.
      expect(label, label).not.toMatch(/\d/);
    }
  });

  it("vehicles and providers are synthetic, not real businesses", () => {
    for (const vehicle of FLEET) {
      expect(vehicle.label).toMatch(/^V\d+$/);
      // The provider names are the scenario's own, and every one of them carries the SYN marker
      // that says so (ADR-015). src/modules/demo/fixtures/names.test.ts holds them against the
      // Today board's names; this only asks that nothing real got in.
      expect(vehicle.providerName, vehicle.id).toMatch(/^SYN /);
    }
  });

  it("every arriving vehicle carries only children the fixture declares", () => {
    const tokens = new Set(CHILDREN.map((c) => c.token));
    for (const arrival of ARRIVING_VEHICLES) {
      for (const child of arrival.leg.children) expect(tokens.has(child.token)).toBe(true);
    }
  });

  it("is dated, not timestamped to whenever the suite runs", () => {
    expect(SERVICE_DATE).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
