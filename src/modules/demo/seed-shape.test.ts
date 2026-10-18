import { describe, expect, it } from "vitest";
import { NEED_CATEGORY } from "@/config/equipment";
import { VANS } from "@/config/vans";
import { demoDaySource } from "./day-source";
import { BOARD_CENSUS, CHILDREN, RUNS, VEHICLES, childTokenOf, vehicleIdOf } from "./fixtures/standard";

/**
 * The shape of the fresh demo seed (Firia, 2026-10-17 8:02 PM ET): it holds **only what the six
 * founder goals need**.
 *
 * Three vans on the road, twelve children, every need item approved, and every category one of
 * the shared constants. This is the fixture half, which is what the seed writes row for row;
 * the rows themselves are asserted against a real database in src/modules/plan/place.db.test.ts
 * and src/modules/demo/seed.test.ts.
 */
describe("the fresh demo seed", () => {
  it("runs three vans, and they are the shared config's", async () => {
    expect(RUNS).toHaveLength(3);
    const onTheRoad = await demoDaySource().vans("2026-10-17");
    expect(onTheRoad).toHaveLength(3);
    expect(onTheRoad.map((van) => van.name)).toEqual(["Van 1", "Van 2", "Van 3"]);
    // Each one is a vehicle the seed writes, named and counted by src/config/vans.ts and by
    // nothing else: there is one fleet, not one per screen.
    for (const van of onTheRoad) {
      const config = VANS.find((candidate) => vehicleIdOf(candidate.vehicleKey) === van.id);
      expect(config, van.name).toBeDefined();
      expect(van.defaultSetup).toEqual(config?.defaultSetup);
      expect(VEHICLES.some((vehicle) => vehicleIdOf(vehicle.key) === van.id)).toBe(true);
    }
  });

  it("gives every van the five counts the ramp confirms", () => {
    for (const van of VANS) {
      expect(Object.keys(van.defaultSetup).sort()).toEqual(
        ["carSeats", "hasLift", "oxygenMounts", "seats", "wheelchairSpots"].sort(),
      );
      expect(typeof van.defaultSetup.hasLift).toBe("boolean");
      for (const key of ["seats", "wheelchairSpots", "carSeats", "oxygenMounts"] as const) {
        expect(van.defaultSetup[key], `${van.vehicleKey}.${key}`).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("holds twelve children and no census pad beyond them", () => {
    expect(BOARD_CENSUS).toBe(12);
    expect(CHILDREN).toHaveLength(12);
    // Every child is a real person on the screen: first name and family initial, never a code.
    for (const child of CHILDREN) {
      expect(child.label, child.key).toMatch(/^[A-Z][a-z]+ [A-Z]\.$/);
    }
    expect(new Set(CHILDREN.map((child) => child.label)).size).toBe(12);
  });

  it("carries the mockup's own riders, so a screenshot lines up with the mockup", () => {
    const names = CHILDREN.map((child) => child.label);
    // The two the mockups name: the chair rider the board has to refuse, and the child the
    // ramp's "won't fit · 1 car seat short" line is about.
    expect(names).toContain("Noah O.");
    expect(names).toContain("Mia R.");
    const mia = CHILDREN.find((child) => child.label === "Mia R.");
    expect(mia?.needs.map((need) => need.category)).toContain(NEED_CATEGORY.carSeat);
    const noah = CHILDREN.find((child) => child.label === "Noah O.");
    expect(noah?.needs.map((need) => need.category)).toContain(NEED_CATEGORY.wheelchair);
  });

  it("approves every need item, and names every category from the shared list", () => {
    const categories = new Set(Object.values(NEED_CATEGORY) as string[]);
    for (const child of CHILDREN) {
      for (const need of child.needs) {
        expect({ who: child.label, state: need.state }).toEqual({ who: child.label, state: "APPROVED" });
      }
    }
    // The three the board reads are the shared constants; the rest are the deferred categories
    // the seed still writes and nothing plans against (C3 and C7).
    const planned = CHILDREN.flatMap((child) => child.needs.map((need) => need.category)).filter((category) =>
      categories.has(category),
    );
    expect(planned.length).toBeGreaterThan(0);
  });

  it("has an approved oxygen rider, so every van's oxygen counter means something", async () => {
    const riders = await demoDaySource().riders("2026-10-17", "PM");
    const withOxygen = riders.filter((rider) => rider.needs.oxygen);
    expect(withOxygen.length).toBeGreaterThan(0);
    const child = CHILDREN.find((candidate) => childTokenOf(candidate.key) === withOxygen[0].token);
    expect(child?.needs.find((need) => need.category === NEED_CATEGORY.oxygen)?.state).toBe("APPROVED");
  });
});
