/**
 * Privacy shape of the fleet fixtures (PRD §18.1, MOCKS-AND-DEMO §1-2, COPY-GUIDE §3).
 *
 * These fixtures are the ones the ramp check and the capacity solver render, so a name added
 * here reaches a screen. §3 fixes the form: "first name + last initial, synthetic only
 * ('Mia R.')", with siblings sharing the family's initial. Nothing here asserts the solver's
 * behaviour — src/domain/solver/solver.test.ts owns that.
 */
import { describe, expect, it } from "vitest";
import { ARRIVING_VEHICLES, CHILDREN, FLEET, PROVIDERS, SERVICE_DATE, STOPS } from "./fleet";
import { PROVIDERS as DEMO_PROVIDERS } from "@/modules/demo/fixtures/standard";

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
    // C4 and C5 are the one sibling pair the demo scenario needs (PRD §18.1).
    expect(byFamily.get("P.")).toEqual(["C4", "C5"]);
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

  it("a vehicle is still coded, and its operator is now a name rather than a column label", () => {
    const names = Object.values(PROVIDERS).map((p) => p.name);
    for (const vehicle of FLEET) {
      expect(vehicle.label).toMatch(/^V\d+$/);
      // Vera's review, 2026-10-17: "Provider P1" was the fixture key with a column label in
      // front of it, on every ramp tile and every vehicle card. The operator is one of the
      // scenario's own providers now.
      expect(names, vehicle.providerName).toContain(vehicle.providerName);
      expect(vehicle.providerName).not.toMatch(/^Provider P\d+$/);
    }
  });

  /**
   * The operators are invented, and they are the *same* invented ones the Today board runs on:
   * one van has one company across the board, Plan routes, the ramp iPad and the live map. The
   * "SYN" marker stays in the fixture and in the seeded rows; it is off on screen, because it is
   * a marker between engineers and the database (Vera's review, 2026-10-17).
   */
  it("names each operator from the demo scenario, with the synthetic marker off", () => {
    const fromScenario = DEMO_PROVIDERS.map((p) => p.name);
    for (const { id, name } of Object.values(PROVIDERS)) {
      expect(name).not.toMatch(/^SYN /);
      expect(fromScenario, name).toContain(`SYN ${name}`);
      expect(DEMO_PROVIDERS.map((p) => p.key)).toContain(id);
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
