import { describe, expect, it } from "vitest";
import { VANS, defaultSetupOf, vanNameOf } from "@/config/vans";
import {
  autoPlan,
  boardMap,
  checkPlan,
  emptyPlan,
  moveTo,
  namesOnlyThisDay,
  placeableVans,
  placedCount,
  ridersInVan,
  shortfallsOfDay,
  stopCount,
  stopNumbers,
  unassignedRiders,
  usedInVan,
  type BoardPlan,
} from "./board";
import { fits, placeRiders, rejectReason } from "./fit";
import { needsOf, needsOfKey } from "./needs";
import { resolveSetup, type SetupRow } from "./setup";
import { CHILDREN, childTokenOf, vehicleIdOf } from "@/modules/demo/fixtures/standard";
import { TEST_DATE, scenarioPlan, testDay, vanIdOfSlot } from "@/test/board-day";

/**
 * The board's own day: the three vans, the children of one leg, and the three things a person
 * asks of it — Auto-plan, "can this child go here", and "is this plan allowed".
 *
 * The day is the one roster every screen reads (src/modules/demo/day-source.ts behind the day
 * port), so these assertions are about the scenario the founder is shown.
 */
const DATE = TEST_DATE;

describe("§6.4: a child's needs, from their approved profile only", () => {
  it("reads a chair, a car seat, a vest and a nurse off the approved items", () => {
    expect(needsOfKey("C2")).toMatchObject({ wheelchair: true, carSeat: false, nurse: false });
    expect(needsOfKey("C1")).toMatchObject({ wheelchair: false, carSeat: true });
    expect(needsOfKey("C7")).toMatchObject({ carSeat: true });
    expect(needsOfKey("C6")).toMatchObject({ wheelchair: true, nurse: true });
  });

  it("ignores a need nobody has approved (DECISION-LEDGER row 1)", () => {
    // Zoe B.'s portable suction is REPORTED, not APPROVED, so it asks for no oxygen mount.
    expect(needsOfKey("C6").oxygen).toBe(false);
    expect(CHILDREN.filter((child) => needsOf(child).oxygen)).toEqual([]);
  });

  it("gives a child with nothing on file nothing", () => {
    expect(needsOfKey("C8")).toEqual({ wheelchair: false, carSeat: false, oxygen: false, nurse: false });
  });
});

/**
 * Firia/Veri, 2026-10-17 6:00 PM ET: two rungs and no carry-over. Today's `CHECKED` row, or the
 * shared config's defaults — never yesterday's counts, and never a state a person did not set.
 */
describe("§1.6 as re-cut: which counts a van is planned on", () => {
  const key = VANS[0].vehicleKey;
  const row = (over: Partial<SetupRow> = {}): SetupRow => ({
    vehicleId: vehicleIdOf(key),
    serviceDate: DATE,
    setup: { seats: 2, wheelchairSpots: 2, carSeats: 2, oxygenMounts: 2, hasLift: false },
    state: "CHECKED",
    setBy: "Ana P.",
    setAt: `${DATE}T19:30:00.000Z`,
    ...over,
  });

  it("uses today's confirmed row when there is one", () => {
    const resolved = resolveSetup(key, DATE, [row()]);
    expect(resolved).toMatchObject({ source: "CHECKED", state: "CHECKED", setBy: "Ana P." });
    expect(resolved.setup.seats).toBe(2);
  });

  it("never carries an earlier day forward: yesterday's confirmed van is not today's", () => {
    const resolved = resolveSetup(key, DATE, [
      row({ serviceDate: "2026-10-16" }),
      row({ serviceDate: "2026-10-15" }),
    ]);
    expect(resolved).toMatchObject({ source: "DEFAULT", state: "DEFAULT" });
    expect(resolved.setup).toEqual(defaultSetupOf(key));
    expect(resolved).not.toHaveProperty("fromDate");
  });

  it("never reads tomorrow as today", () => {
    expect(resolveSetup(key, DATE, [row({ serviceDate: "2026-10-18" })]).source).toBe("DEFAULT");
  });

  it("has only the two states a screen can see", () => {
    for (const state of [resolveSetup(key, DATE, [row()]).state, resolveSetup(key, DATE, []).state]) {
      expect(["CHECKED", "DEFAULT"]).toContain(state);
    }
  });
});

describe("the day the board opens on", () => {
  it("names each van by number and nothing else", () => {
    expect(testDay().vans.map((van) => van.name)).toEqual(["Van 1", "Van 2", "Van 3"]);
    expect(vanNameOf(2)).toBe("Van 2");
    for (const van of testDay().vans) {
      expect(van.name).not.toMatch(/\bV\d\b/);
      expect(van.id).not.toMatch(/^V\d$/);
    }
  });

  it("gives every van a colour from the one shared config, and no two the same", () => {
    const tokens = testDay().vans.map((van) => van.colourToken);
    expect(new Set(tokens).size).toBe(tokens.length);
    for (const token of tokens) expect(token).not.toMatch(/^#/);
  });

  it("drives the children with a stop of their own, and nobody else", () => {
    const day = testDay();
    expect(day.riders.length).toBeGreaterThan(0);
    for (const rider of day.riders) {
      expect(rider.stopLabel.length).toBeGreaterThan(0);
      expect(rider.name).toMatch(/^[A-Z][a-z]+ [A-Z]\.$/);
    }
    // Everybody else is in one of the two groups, and nobody is in both halves of the day.
    const riding = new Set(day.riders.map((rider) => rider.token));
    for (const other of day.others) expect(riding.has(other.token)).toBe(false);
  });

  it("puts a child the day records as away in the Absent group instead", () => {
    const away = childTokenOf("C1");
    const day = testDay("PM", {}, [away]);
    expect(day.riders.some((rider) => rider.token === away)).toBe(false);
    expect(day.others.find((other) => other.token === away)?.bucket).toBe("ABSENT");
  });

  it("opens with everybody waiting (§1.3 Empty)", () => {
    const day = testDay();
    const plan = emptyPlan(day);
    expect(placedCount(day, plan)).toBe(0);
    expect(unassignedRiders(day, plan)).toHaveLength(day.riders.length);
    for (const other of day.others) expect(plan[other.token].bucket).toBe(other.bucket);
  });
});

describe("§1.4: Auto-plan is the one placement function", () => {
  it("places every rider of the day across the three vans", () => {
    const day = testDay();
    const plan = autoPlan(day, emptyPlan(day));
    expect(placedCount(day, plan)).toBe(day.riders.length);
    expect(unassignedRiders(day, plan)).toEqual([]);
  });

  it("gives no van more than it can carry", () => {
    const day = testDay();
    const plan = autoPlan(day, emptyPlan(day));
    for (const van of day.vans) {
      expect(fits(van.setup, ridersInVan(day, plan, van.id)), van.name).toBe(true);
    }
  });

  it("keeps a child a person placed by hand, and plans the rest around them", () => {
    const day = testDay();
    const rider = day.riders[0];
    const van = day.vans[1];
    const pinned = moveTo(emptyPlan(day), rider.token, van.id);
    const plan = autoPlan(day, pinned);
    expect(plan[rider.token]).toMatchObject({ bucket: "VAN", vanId: van.id, pinned: true });
    expect(placedCount(day, plan)).toBe(day.riders.length);
  });

  it("leaves a child a person took out of a van out of it", () => {
    const day = testDay();
    const rider = day.riders[0];
    const plan = autoPlan(day, moveTo(emptyPlan(day), rider.token, null));
    expect(plan[rider.token]).toMatchObject({ bucket: "UNASSIGNED", pinned: true });
  });

  it("leaves a rider no van can take unplaced, and says exactly what the day is short of", () => {
    // Every van loses its car seats, so the children who need one cannot ride at all.
    const day = testDay("PM", {
      1: { carSeats: 0 },
      2: { carSeats: 0 },
      3: { carSeats: 0 },
    });
    const plan = autoPlan(day, emptyPlan(day));
    const needsCarSeat = day.riders.filter((rider) => rider.needs.carSeat);
    expect(needsCarSeat.length).toBeGreaterThan(0);
    for (const rider of needsCarSeat) {
      expect(plan[rider.token].bucket, rider.name).toBe("UNASSIGNED");
    }
    const short = shortfallsOfDay(day, plan);
    expect(short.map((one) => one.token).sort()).toEqual(needsCarSeat.map((r) => r.token).sort());
    for (const one of short) expect(one.shortfall).toEqual({ reason: "CAR_SEAT", short: 1 });
  });

  it("never puts a chair on a van whose lift does not work", () => {
    const day = testDay("PM", { 1: { hasLift: false }, 2: { hasLift: false } });
    const plan = autoPlan(day, emptyPlan(day));
    for (const van of day.vans) {
      if (van.setup.hasLift) continue;
      expect(ridersInVan(day, plan, van.id).some((rider) => rider.needs.wheelchair)).toBe(false);
    }
  });

  it("is the same answer the board's own vans give the placement function directly", () => {
    const day = testDay();
    const direct = placeRiders(placeableVans(day), day.riders);
    const plan = autoPlan(day, emptyPlan(day));
    for (const rider of day.riders) {
      expect(plan[rider.token].vanId).toBe(direct.vanOf[rider.token] ?? null);
    }
  });
});

describe("§1.7 #1: a refused drop changes nothing", () => {
  it("refuses a chair onto the van with no spot and no lift, and names it", () => {
    const day = testDay();
    const vanThree = day.vans.find((van) => van.slot === 3);
    if (!vanThree) throw new Error("no Van 3");
    expect(vanThree.setup.wheelchairSpots).toBe(0);
    expect(vanThree.setup.hasLift).toBe(false);
    const chair = day.riders.find((rider) => rider.needs.wheelchair);
    if (!chair) throw new Error("no chair rider in the day");
    expect(rejectReason(vanThree.setup, [], chair)).toBe("WHEELCHAIR");
  });

  it("refuses the whole save when a posted plan puts them there anyway", () => {
    const day = testDay();
    const vanThree = vanIdOfSlot(3);
    const chair = day.riders.find((rider) => rider.needs.wheelchair);
    if (!chair) throw new Error("no chair rider in the day");
    const posted = moveTo(emptyPlan(day), chair.token, vanThree);
    expect(checkPlan(day, posted)).toEqual({
      ok: false,
      childToken: chair.token,
      vanId: vanThree,
      reason: "WHEELCHAIR",
    });
  });

  it("passes a plan the fit rule agrees with", () => {
    const day = testDay();
    expect(checkPlan(day, autoPlan(day, emptyPlan(day)))).toEqual({ ok: true });
  });

  it("refuses a plan naming a child or a van the day does not have", () => {
    const day = testDay();
    const good = autoPlan(day, emptyPlan(day));
    expect(namesOnlyThisDay(day, good)).toBe(true);
    const strangeChild: BoardPlan = { ...good, "not-a-child": { bucket: "UNASSIGNED", vanId: null, pinned: false } };
    expect(namesOnlyThisDay(day, strangeChild)).toBe(false);
    const strangeVan: BoardPlan = { ...good, [day.riders[0].token]: { bucket: "VAN", vanId: "not-a-van", pinned: false } };
    expect(namesOnlyThisDay(day, strangeVan)).toBe(false);
    const bucketWithVan: BoardPlan = { ...good, [day.riders[0].token]: { bucket: "UNASSIGNED", vanId: "x", pinned: false } };
    expect(namesOnlyThisDay(day, bucketWithVan)).toBe(false);
  });
});

describe("stops, in the order a van drives them", () => {
  it("numbers the stops from one, and gives two children at one kerb the same number", () => {
    const day = testDay();
    const plan = scenarioPlan(day);
    for (const van of day.vans) {
      const riders = ridersInVan(day, plan, van.id);
      if (riders.length === 0) continue;
      const numbers = [...stopNumbers(riders).values()];
      expect(numbers[0]).toBe(1);
      expect(Math.max(...numbers)).toBe(stopCount(riders));
      // In window order, and never going backwards.
      for (let i = 1; i < numbers.length; i += 1) expect(numbers[i]).toBeGreaterThanOrEqual(numbers[i - 1]);
    }
  });

  it("counts a van's meters off the riders in it", () => {
    const day = testDay();
    const plan = autoPlan(day, emptyPlan(day));
    for (const van of day.vans) {
      const riders = ridersInVan(day, plan, van.id);
      const used = usedInVan(day, plan, van.id);
      expect(used.wheelchairSpots).toBe(riders.filter((rider) => rider.needs.wheelchair).length);
      expect(used.carSeats).toBe(riders.filter((rider) => rider.needs.carSeat).length);
      expect(used.seats).toBe(
        riders.filter((rider) => !rider.needs.wheelchair).length + riders.filter((r) => r.needs.nurse).length,
      );
    }
  });

  it("hands the map the same plan the columns show", () => {
    const day = testDay();
    const plan = autoPlan(day, emptyPlan(day));
    const data = boardMap(day, plan);
    for (const van of day.vans) {
      const route = data.routes.find((r) => r.laneId === van.id);
      expect(route?.vanName).toBe(van.name);
      expect(route?.riderCount).toBe(stopCount(ridersInVan(day, plan, van.id)));
    }
  });
});
