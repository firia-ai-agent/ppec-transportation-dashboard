import { describe, expect, it } from "vitest";
import { planMap, planMapCoords, PLAN_CENTER_COORD, PLAN_CENTER_LABEL, type PlanMapVan } from "./map";
import { boardMap, moveTo, ridersInVan, stopNumbers } from "./board";
import { scenarioPlan, testDay, vanIdOfSlot } from "@/test/board-day";
import { places } from "@/ui/copy";

/**
 * The plan, as the map beside the columns draws it.
 *
 * Everything here is read off a real board — the one roster, the one van list and the board's
 * own `ridersInVan` ordering — rather than a hand-written plan, because the whole claim of this
 * module is that the line on the map and the stop list in the column are two readings of one
 * answer. A fixture plan could agree with itself and with nothing a coordinator sees.
 *
 * It is handed stops and not a `RoutePlan`: the capacity solver makes no placement decision in
 * the rebuild and the map is not drawn off one of its verdicts either (Firia's rule 2).
 */
const AM = () => testDay("AM");
const PM = () => testDay("PM");

/** The van's own stops, numbered as its column numbers them — what the board hands the map. */
function stopsOf(day: ReturnType<typeof testDay>, plan: ReturnType<typeof scenarioPlan>, slot: number) {
  const vanId = vanIdOfSlot(slot);
  const riders = ridersInVan(day, plan, vanId);
  const numbers = stopNumbers(riders);
  const stops: { order: number; label: string }[] = [];
  for (const rider of riders) {
    const order = numbers.get(rider.token) ?? 0;
    if (stops[stops.length - 1]?.order === order) continue;
    stops.push({ order, label: rider.stopLabel });
  }
  return stops;
}

describe("what the map is handed", () => {
  it("names every van the day has, in the day's own order, each with its own colour", () => {
    const day = AM();
    const data = boardMap(day, scenarioPlan(day));
    expect(data.routes.map((route) => route.laneId)).toEqual(day.vans.map((van) => van.id));
    expect(data.routes.map((route) => route.vanName)).toEqual(day.vans.map((van) => van.name));
    expect(data.routes.map((route) => route.colorIndex)).toEqual([0, 1, 2]);
    // Two vans never share a colour, and the colour is the van's position rather than anything
    // about the vehicle on it — so a substitution does not recolour the line.
    expect(new Set(data.routes.map((r) => r.colorIndex)).size).toBe(data.routes.length);
  });

  it("names a van by its number and never by a vehicle code", () => {
    const day = AM();
    for (const route of boardMap(day, scenarioPlan(day)).routes) {
      expect(route.vanName).toMatch(/^Van \d$/);
      expect(route.vanName).not.toMatch(/\bV\d\b/);
    }
  });

  it("puts the centre on the map once, by name and never by address", () => {
    const day = AM();
    const data = boardMap(day, scenarioPlan(day));
    expect(data.center).toEqual(PLAN_CENTER_COORD);
    expect(data.centerLabel).toBe(PLAN_CENTER_LABEL);
    expect(data.centerLabel).toBe(places.center);
    for (const route of data.routes) {
      expect(route.stops.map((stop) => stop.label)).not.toContain(data.centerLabel);
    }
  });

  it("has nothing to draw before anybody is in a van, and says so", () => {
    const day = AM();
    const data = boardMap(day, {});
    expect(data.empty).toBe(true);
    for (const route of data.routes) {
      expect(route.stops).toEqual([]);
      expect(route.line).toEqual([]);
      expect(route.minutes).toBe(0);
    }
    // The centre is still on it, so the pane is never a blank canvas.
    expect(planMapCoords(data)).toEqual([PLAN_CENTER_COORD]);
  });
});

describe("the stops, in the order the van drives them", () => {
  it("numbers each van's discs the way its column numbers its rider cards", () => {
    const day = PM();
    const plan = scenarioPlan(day);
    const data = boardMap(day, plan);
    for (const van of day.vans) {
      const route = data.routes.find((r) => r.laneId === van.id);
      const numbers = [...stopNumbers(ridersInVan(day, plan, van.id)).values()];
      expect(route?.stops.map((stop) => stop.order)).toEqual([...new Set(numbers)]);
    }
  });

  it("draws a kerb two children share once", () => {
    const day = PM();
    const plan = scenarioPlan(day);
    for (const van of day.vans) {
      const riders = ridersInVan(day, plan, van.id);
      const kerbs = new Set(riders.map((rider) => rider.stopLabel));
      const route = boardMap(day, plan).routes.find((r) => r.laneId === van.id);
      expect(route?.stops.length).toBe(kerbs.size);
    }
  });

  it("runs the morning to the centre and the afternoon out of it", () => {
    const morning = AM();
    const afternoon = PM();
    const first = (day: ReturnType<typeof testDay>) => {
      const plan = scenarioPlan(day);
      const van = day.vans.find((v) => ridersInVan(day, plan, v.id).length > 0);
      if (!van) throw new Error("no loaded van in the scenario");
      const route = boardMap(day, plan).routes.find((r) => r.laneId === van.id);
      return { route, stops: stopsOf(day, plan, van.slot) };
    };
    // The morning's line ends at the centre: its last coordinate is the centre's.
    const am = first(morning);
    expect(am.route?.line.at(-1)).toEqual(PLAN_CENTER_COORD);
    // The afternoon's starts there.
    const pm = first(afternoon);
    expect(pm.route?.line[0]).toEqual(PLAN_CENTER_COORD);
  });
});

describe("the geometry is the committed survey, and says where it is not", () => {
  it("follows the surveyed road for the pairs the day's own runs drive", () => {
    const day = AM();
    const data = boardMap(day, scenarioPlan(day));
    const drawn = data.routes.filter((route) => route.stops.length > 0);
    expect(drawn.length).toBeGreaterThan(0);
    // Every stretch of a scenario run is a road somebody measured, and it is longer than the
    // two-point line a straight guess would be.
    for (const route of drawn) {
      expect(route.surveyed, route.vanName).toBe(true);
      for (const segment of route.segments) {
        expect(segment.geometry.length).toBeGreaterThan(2);
        expect(segment.durationSec).toBeGreaterThan(0);
      }
    }
  });

  it("draws the line between two stops nobody surveyed, and marks it", () => {
    const day = AM();
    const plan = scenarioPlan(day);
    // A child moved into another van makes a kerb pair nobody drove.
    const from = day.vans[0];
    const to = day.vans[2];
    const rider = ridersInVan(day, plan, from.id)[0];
    const moved = moveTo(plan, rider.token, to.id);
    const route = boardMap(day, moved).routes.find((r) => r.laneId === to.id);
    expect(route?.surveyed).toBe(false);
    const guessed = route?.segments.filter((segment) => !segment.surveyed) ?? [];
    expect(guessed.length).toBeGreaterThan(0);
    for (const segment of guessed) {
      expect(segment.geometry).toHaveLength(2);
      expect(segment.durationSec).toBeGreaterThan(0);
    }
  });

  it("joins the stretches into one line with no repeated vertex", () => {
    const day = AM();
    const data = boardMap(day, scenarioPlan(day));
    for (const route of data.routes) {
      for (let i = 1; i < route.line.length; i += 1) {
        expect(route.line[i]).not.toEqual(route.line[i - 1]);
      }
    }
  });
});

describe("the map follows a move, because it is the same answer the columns are", () => {
  it("takes a child's kerb off one van's line and puts it on another's", () => {
    const day = PM();
    const plan = scenarioPlan(day);
    const from = day.vans[0];
    const to = day.vans[1];
    const rider = ridersInVan(day, plan, from.id).find(
      (candidate) =>
        ridersInVan(day, plan, from.id).filter((r) => r.stopLabel === candidate.stopLabel).length === 1,
    );
    if (!rider) throw new Error("no rider with a kerb of their own");
    const before = boardMap(day, plan);
    const after = boardMap(day, moveTo(plan, rider.token, to.id));
    const labels = (data: typeof before, laneId: string) =>
      data.routes.find((route) => route.laneId === laneId)?.stops.map((stop) => stop.label) ?? [];
    expect(labels(before, from.id)).toContain(rider.stopLabel);
    expect(labels(after, from.id)).not.toContain(rider.stopLabel);
    expect(labels(after, to.id)).toContain(rider.stopLabel);
  });

  it("drops a line entirely when the last rider is taken out of a van", () => {
    const day = PM();
    let plan = scenarioPlan(day);
    const van = day.vans[2];
    for (const rider of ridersInVan(day, plan, van.id)) {
      plan = moveTo(plan, rider.token, null);
    }
    const route = boardMap(day, plan).routes.find((r) => r.laneId === van.id);
    expect(route?.stops).toEqual([]);
    expect(route?.line).toEqual([]);
  });
});

describe("the module on its own", () => {
  it("drops a stop the fixtures place nowhere rather than guessing a coordinate", () => {
    const vans: PlanMapVan[] = [
      { laneId: "v1", vanName: "Van 1", stops: [{ order: 1, label: "Nowhere At All" }] },
    ];
    const data = planMap("AM", vans);
    expect(data.routes[0].stops).toEqual([]);
    expect(data.routes[0].line).toEqual([]);
  });
});
