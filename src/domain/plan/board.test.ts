import { describe, expect, it } from "vitest";
import { VANS } from "@/config/vans";
import {
  asAssignment,
  autoPlan,
  boardMap,
  boardRiders,
  boardVans,
  checkPlan,
  emptyPlan,
  moveTo,
  namesOnlyThisDay,
  otherChildren,
  placedCount,
  ridersInVan,
  stopCount,
  stopNumbers,
  unassignedRiders,
  usedInVan,
  vanNameOf,
  type BoardDay,
  type BoardPlan,
} from "./board";
import { fits, rejectReason } from "./fit";
import { needsOf, needsOfKey } from "./needs";
import { resolveSetup, setupToLayout, type SetupRow } from "./setup";
import { CHILDREN, childTokenOf, vehicleIdOf } from "@/modules/demo/fixtures/standard";

/**
 * The board's own day: the three vans, the children of one leg, and the two things a person asks
 * of it — Auto-plan, and "is this plan allowed".
 *
 * The day is the demo fixtures' day, so these assertions are about the scenario the founder is
 * shown: nine riders this afternoon, two of them in their own chair, four needing a car seat, and
 * three vans that can take all nine between them.
 */

const DATE = "2026-10-17";

function dayWith(setupOf: (key: string) => SetupRow[] = () => []): BoardDay {
  return {
    date: DATE,
    direction: "PM",
    vans: boardVans((key) => {
      const resolved = resolveSetup(key, DATE, setupOf(key));
      return {
        setup: resolved.setup,
        setupState: resolved.state,
        setupSource: resolved.source,
        ...(resolved.fromDate ? { setupFromDate: resolved.fromDate } : {}),
        setupBy: resolved.setBy ?? null,
      };
    }),
    riders: boardRiders("PM"),
    others: otherChildren("PM"),
  };
}

describe("§6.4: a child's needs, from their approved profile only", () => {
  it("reads a chair, a car seat, a vest and a nurse off the approved items", () => {
    // Noah O. rides in his own chair; Mia R. has an approved car seat; Owen C. an approved vest;
    // Zoe B. has a chair and a nurse (fixtures/standard.ts).
    expect(needsOfKey("C2")).toMatchObject({ wheelchair: true, carSeat: false, nurse: false });
    expect(needsOfKey("C1")).toMatchObject({ wheelchair: false, carSeat: true });
    expect(needsOfKey("C7")).toMatchObject({ carSeat: true });
    expect(needsOfKey("C6")).toMatchObject({ wheelchair: true, nurse: true });
  });

  it("ignores a need nobody has approved (DECISION-LEDGER row 1)", () => {
    // Zoe B.'s portable suction is REPORTED, not APPROVED, so it asks for no oxygen mount.
    expect(needsOfKey("C6").oxygen).toBe(false);
    const approved = CHILDREN.filter((child) => needsOf(child).oxygen);
    expect(approved).toEqual([]);
  });

  it("gives a child with nothing on file nothing", () => {
    expect(needsOfKey("C8")).toEqual({ wheelchair: false, carSeat: false, oxygen: false, nurse: false });
  });
});

describe("§1.6: which setup a van is planned against", () => {
  const vanOne = vehicleIdOf(VANS[0].vehicleKey);
  const row = (over: Partial<SetupRow> = {}): SetupRow => ({
    vehicleId: vanOne,
    serviceDate: DATE,
    setup: { seats: 2, wheelchairSpots: 2, carSeats: 2, oxygenMounts: 2, hasLift: false },
    state: "CHECKED",
    setBy: "Ana P.",
    setAt: `${DATE}T19:30:00.000Z`,
    ...over,
  });

  it("uses today's row when there is one", () => {
    const resolved = resolveSetup(VANS[0].vehicleKey, DATE, [row()]);
    expect(resolved).toMatchObject({ source: "TODAY", state: "CHECKED", setBy: "Ana P." });
    expect(resolved.setup.seats).toBe(2);
  });

  it("carries the most recent checked day forward, and stops calling it checked", () => {
    const resolved = resolveSetup(VANS[0].vehicleKey, DATE, [
      row({ serviceDate: "2026-10-16" }),
      row({ serviceDate: "2026-10-15", setup: { seats: 9, wheelchairSpots: 0, carSeats: 0, oxygenMounts: 0, hasLift: true } }),
    ]);
    expect(resolved).toMatchObject({ source: "YESTERDAY", state: "DEFAULT", fromDate: "2026-10-16" });
    expect(resolved.setup.seats).toBe(2);
  });

  it("skips a day nobody confirmed and falls back to the configured default", () => {
    const planned = row({ serviceDate: "2026-10-16", state: "PLANNED" });
    const resolved = resolveSetup(VANS[0].vehicleKey, DATE, [planned]);
    expect(resolved).toMatchObject({ source: "DEFAULT", state: "DEFAULT" });
    expect(resolved.setup).toEqual(VANS[0].defaultSetup);
  });

  it("never reads tomorrow as today", () => {
    const resolved = resolveSetup(VANS[0].vehicleKey, DATE, [row({ serviceDate: "2026-10-18" })]);
    expect(resolved.source).toBe("DEFAULT");
  });

  it("§1.4: a setup becomes one seating plan the solver can search", () => {
    const layout = setupToLayout("van", { seats: 3, wheelchairSpots: 1, carSeats: 2, oxygenMounts: 1, hasLift: true });
    expect(layout.liftRequired).toBe(true);
    expect(layout.positions.filter((p) => p.kind === "WC")).toHaveLength(1);
    const seats = layout.positions.filter((p) => p.kind === "AMB");
    expect(seats).toHaveLength(3);
    expect(seats.filter((seat) => "tetherCapable" in seat && seat.tetherCapable)).toHaveLength(2);
    // No spot, no lift to require: a van with seats only does not fail on a lift nobody needs.
    expect(setupToLayout("van", { seats: 3, wheelchairSpots: 0, carSeats: 0, oxygenMounts: 0, hasLift: false }).liftRequired).toBe(false);
  });
});

describe("the day the board opens on", () => {
  it("names each van by number and nothing else", () => {
    expect(dayWith().vans.map((van) => van.name)).toEqual(["Van 1", "Van 2", "Van 3"]);
    expect(vanNameOf(2)).toBe("Van 2");
  });

  it("drives the children with a stop of their own, and nobody else", () => {
    const day = dayWith();
    expect(day.riders).toHaveLength(9);
    expect(day.riders.every((rider) => rider.stopLabel.length > 0)).toBe(true);
    // The census children arrive with their family: they are a group, not a rider.
    expect(day.others.every((other) => other.bucket === "FAMILY_DRIVES")).toBe(true);
    expect(day.riders.length + day.others.length).toBe(CHILDREN.length);
  });

  it("puts a child the day records as away in the Absent group instead", () => {
    const away = childTokenOf("C1");
    const riders = boardRiders("PM", [away]);
    expect(riders.some((rider) => rider.token === away)).toBe(false);
    expect(otherChildren("PM", [away]).find((other) => other.token === away)?.bucket).toBe("ABSENT");
  });

  it("opens with everybody waiting (§1.3 Empty)", () => {
    const day = dayWith();
    const plan = emptyPlan(day);
    expect(placedCount(day, plan)).toBe(0);
    expect(unassignedRiders(day, plan)).toHaveLength(9);
    for (const van of day.vans) {
      expect(Object.values(usedInVan(day, plan, van.id))).toEqual([0, 0, 0, 0]);
    }
  });
});

describe("§1.4: Auto-plan over the vans' own counts", () => {
  it("places every rider of the day across the three vans", () => {
    const day = dayWith();
    const planned = autoPlan(day, emptyPlan(day));
    expect(placedCount(day, planned)).toBe(9);
    expect(unassignedRiders(day, planned)).toHaveLength(0);
  });

  it("gives no van more than it can carry", () => {
    const day = dayWith();
    const planned = autoPlan(day, emptyPlan(day));
    for (const van of day.vans) {
      expect(fits(van.setup, ridersInVan(day, planned, van.id))).toBe(true);
    }
    expect(checkPlan(day, planned)).toEqual({ ok: true });
  });

  it("keeps a child a person placed by hand, and plans the rest around them", () => {
    const day = dayWith();
    const chair = day.riders.find((rider) => rider.needs.wheelchair);
    const vanTwo = day.vans[1];
    const byHand = moveTo(emptyPlan(day), chair!.token, vanTwo.id);
    const planned = autoPlan(day, byHand);
    expect(planned[chair!.token]).toMatchObject({ vanId: vanTwo.id, pinned: true });
    expect(placedCount(day, planned)).toBe(9);
  });

  it("leaves a child a person took out of a van out of it", () => {
    const day = dayWith();
    const someone = day.riders[0];
    const planned = autoPlan(day, moveTo(emptyPlan(day), someone.token, null));
    expect(planned[someone.token]).toMatchObject({ bucket: "UNASSIGNED", pinned: true });
    expect(placedCount(day, planned)).toBe(8);
  });

  it("leaves a rider no van can take in Unassigned rather than in a van that cannot hold them", () => {
    // Every van loses its wheelchair spot and its lift: the two children in their own chairs have
    // nowhere to go, and the other seven still get a van.
    const day: BoardDay = {
      ...dayWith(),
      vans: dayWith().vans.map((van) => ({
        ...van,
        setup: { ...van.setup, wheelchairSpots: 0, hasLift: false, seats: 6, carSeats: 3 },
      })),
    };
    const planned = autoPlan(day, emptyPlan(day));
    const chairs = day.riders.filter((rider) => rider.needs.wheelchair);
    expect(chairs).toHaveLength(2);
    for (const chair of chairs) expect(planned[chair.token].bucket).toBe("UNASSIGNED");
    expect(placedCount(day, planned)).toBe(7);
    expect(checkPlan(day, planned)).toEqual({ ok: true });
  });

  it("does not put more oxygen aboard than a van has mounts for", () => {
    // No child of the synthetic day has an approved oxygen need, so the rule is asserted on a day
    // that does: one rider travels with oxygen and only Van 1 has a mount.
    const base = dayWith();
    const day: BoardDay = {
      ...base,
      vans: base.vans.map((van, i) => ({
        ...van,
        setup: { ...van.setup, oxygenMounts: i === 0 ? 1 : 0 },
      })),
      riders: base.riders.map((rider, i) =>
        i === 0 ? { ...rider, needs: { ...rider.needs, oxygen: true } } : rider,
      ),
    };
    const planned = autoPlan(day, emptyPlan(day));
    const withOxygen = day.riders[0];
    const placedIn = planned[withOxygen.token].vanId;
    expect(placedIn === day.vans[0].id || planned[withOxygen.token].bucket === "UNASSIGNED").toBe(true);
    for (const van of day.vans) {
      expect(usedInVan(day, planned, van.id).oxygenMounts).toBeLessThanOrEqual(van.setup.oxygenMounts);
    }
  });
});

describe("§1.7 #1: a refused drop changes nothing", () => {
  it("refuses a chair onto the van with no spot and no lift, and names it", () => {
    const day = dayWith();
    const vanThree = day.vans[2];
    expect(vanThree.setup.wheelchairSpots).toBe(0);
    expect(vanThree.setup.hasLift).toBe(false);
    const chair = day.riders.find((rider) => rider.needs.wheelchair)!;
    expect(rejectReason(vanThree.setup, ridersInVan(day, emptyPlan(day), vanThree.id), chair)).toBe("WHEELCHAIR");
  });

  it("refuses the whole save when a posted plan puts them there anyway", () => {
    const day = dayWith();
    const vanThree = day.vans[2];
    const chair = day.riders.find((rider) => rider.needs.wheelchair)!;
    const plan = moveTo(emptyPlan(day), chair.token, vanThree.id);
    expect(checkPlan(day, plan)).toEqual({
      ok: false,
      childToken: chair.token,
      vanId: vanThree.id,
      reason: "WHEELCHAIR",
    });
  });

  it("refuses a plan naming a child or a van the day does not have", () => {
    const day = dayWith();
    const plan = emptyPlan(day);
    expect(namesOnlyThisDay(day, plan)).toBe(true);
    expect(namesOnlyThisDay(day, { ...plan, stranger: { bucket: "UNASSIGNED", vanId: null, pinned: false } })).toBe(false);
    const someone = day.riders[0].token;
    expect(namesOnlyThisDay(day, { ...plan, [someone]: { bucket: "VAN", vanId: "nowhere", pinned: false } })).toBe(false);
    // A group cannot carry a van: the database checks this too.
    expect(namesOnlyThisDay(day, { ...plan, [someone]: { bucket: "UNASSIGNED", vanId: day.vans[0].id, pinned: false } })).toBe(false);
  });
});

describe("stops, in the order a van drives them", () => {
  it("numbers the stops from one, and gives two children at one kerb the same number", () => {
    const day = dayWith();
    // Ava N. and Eli N. are siblings at one stop (fixtures/standard.ts).
    const siblings = [childTokenOf("C4"), childTokenOf("C5")];
    let plan: BoardPlan = emptyPlan(day);
    for (const token of siblings) plan = moveTo(plan, token, day.vans[0].id);
    const riders = ridersInVan(day, plan, day.vans[0].id);
    const numbers = stopNumbers(riders);
    expect(new Set(numbers.values())).toEqual(new Set([1]));
    expect(stopCount(riders)).toBe(1);
  });

  it("hands the map the same plan the columns show", () => {
    const day = dayWith();
    const planned = autoPlan(day, emptyPlan(day));
    const map = boardMap(day, planned);
    expect(map.routes.map((route) => route.vanName)).toEqual(["Van 1", "Van 2", "Van 3"]);
    expect(map.empty).toBe(false);
    for (const van of day.vans) {
      const route = map.routes.find((r) => r.laneId === van.id)!;
      expect(route.riderCount).toBe(ridersInVan(day, planned, van.id).length);
      // A drive time, from the survey's own measured legs (never a guessed one).
      expect(route.minutes).toBeGreaterThanOrEqual(0);
    }
    expect(asAssignment(day, planned)[day.vans[0].id]).toEqual(
      ridersInVan(day, planned, day.vans[0].id).map((rider) => rider.token),
    );
  });
});
