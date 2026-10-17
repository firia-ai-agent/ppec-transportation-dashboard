import { describe, expect, it } from "vitest";
import { planMap, planMapCoords, PLAN_CENTER_COORD, PLAN_CENTER_LABEL } from "./map";
import { planLanes, planRiders } from "./day";
import { routePlan, tryMove, type Assignment, type PlanInput } from "@/domain/solver";
import { RUNS } from "@/modules/demo/fixtures/standard";
import { places, vanName } from "@/ui/copy";

/**
 * The plan, as the map beside the lanes draws it.
 *
 * Everything here is read off a real `RoutePlan` — the lanes, the riders and the solver — rather
 * than a hand-written one, because the whole claim of this module is that the line on the map and
 * the stop list in the lane are two readings of one answer. A fixture plan could agree with
 * itself and with nothing a coordinator sees.
 */
function input(direction: "AM" | "PM" = "AM"): PlanInput {
  return {
    direction,
    centerLabel: places.center,
    lanes: planLanes("EVERY_RIDER_FITS"),
    riders: planRiders(direction),
  };
}

/**
 * Each run's own children in its own van, as src/modules/demo/fixtures/standard.ts writes them.
 *
 * Used because it is *stable* geometry — those are the kerb pairs ADR-007 surveyed — and not
 * because it is a feasibility claim: whether a van fits its riders is the solver's answer and is
 * asserted where that is the question (src/domain/solver, src/domain/plan/save.test.ts). This
 * module draws the plan it is handed.
 */
function scenarioAssignment(direction: "AM" | "PM" = "AM"): Assignment {
  const lanes = planLanes("EVERY_RIDER_FITS");
  const riders = new Set(planRiders(direction).map((rider) => rider.child.token));
  return Object.fromEntries(
    lanes.map((lane) => {
      const run = RUNS.find((r) => r.vehicleKey === lane.id);
      return [lane.id, (run?.childKeys ?? []).filter((key) => riders.has(key))];
    }),
  );
}

const EMPTY: Assignment = Object.fromEntries(planLanes("EVERY_RIDER_FITS").map((l) => [l.id, []]));

describe("what the map is handed", () => {
  it("names every van the day has, in lane order, each with its own colour", () => {
    const data = planMap(routePlan(input(), scenarioAssignment()));
    expect(data.routes.map((route) => route.laneId)).toEqual(
      planLanes("EVERY_RIDER_FITS").map((lane) => lane.id),
    );
    expect(data.routes.map((route) => route.colorIndex)).toEqual([0, 1, 2]);
    // Two vans never share a colour, and the colour is the lane's position rather than anything
    // about the vehicle on it — so a substitution does not recolour the line.
    expect(new Set(data.routes.map((r) => r.colorIndex)).size).toBe(data.routes.length);
  });

  it("labels each line with the van's own name, never the code the fixtures file it under", () => {
    const data = planMap(routePlan(input(), scenarioAssignment()));
    expect(data.routes.map((route) => route.vanName)).toEqual([
      vanName("convertible van"),
      vanName("center van"),
      vanName("sedan"),
    ]);
    for (const route of data.routes) expect(route.vanName).not.toMatch(/\bV\d\b/);
  });

  it("puts the centre on the map once, by name and never by address", () => {
    const data = planMap(routePlan(input(), scenarioAssignment()));
    expect(data.center).toEqual(PLAN_CENTER_COORD);
    expect(data.centerLabel).toBe(PLAN_CENTER_LABEL);
    expect(data.centerLabel).toBe(places.center);
    expect(data.centerLabel).not.toMatch(/\d/);
    // The centre is nobody's numbered stop: it is the one pin every line runs to.
    for (const route of data.routes) {
      expect(route.stops.map((stop) => stop.label)).not.toContain(data.centerLabel);
    }
  });

  it("has nothing to draw before anybody is in a van, and says so", () => {
    const data = planMap(routePlan(input(), EMPTY));
    expect(data.empty).toBe(true);
    for (const route of data.routes) {
      expect(route.stops).toEqual([]);
      expect(route.line).toEqual([]);
      expect(route.riderCount).toBe(0);
    }
    // The centre is still there, so the pane opens on the neighbourhood rather than on the ocean.
    expect(planMapCoords(data)).toEqual([PLAN_CENTER_COORD]);
  });
});

describe("the stops, in the order the van drives them", () => {
  it("numbers each van's stops from one, earliest pickup first", () => {
    const data = planMap(routePlan(input(), scenarioAssignment()));
    const convertible = data.routes[0];
    expect(convertible.stops.map((stop) => [stop.order, stop.label])).toEqual([
      [1, "Palm Beach State College, Lake Worth"],
      [2, "Lantana Public Library"],
      [3, "Boynton Beach Mall"],
    ]);
    // Which is the order the lane's own stop list is in: the manifest the solver was given.
    const lane = routePlan(input(), scenarioAssignment()).lanes[0];
    expect(lane.leg.stops.slice(0, -1).map((stop) => stop.label)).toEqual(
      convertible.stops.map((stop) => stop.label),
    );
  });

  it("draws a kerb two children share once, and numbers what it drew", () => {
    // The scenario's siblings board at one kerb, so the manifest has two stops there and the map
    // has one circle: two circles on one coordinate are one circle and a smudge.
    const plan = routePlan(input(), scenarioAssignment());
    const sedan = planMap(plan).routes[2];
    const manifest = plan.lanes[2].leg.stops.slice(0, -1).map((stop) => stop.label);
    expect(manifest).toEqual([
      "Greenacres Branch Library",
      "John Prince Park",
      "John Prince Park",
    ]);
    expect(sedan.stops.map((stop) => [stop.order, stop.label])).toEqual([
      [1, "Greenacres Branch Library"],
      [2, "John Prince Park"],
    ]);
  });

  it("runs the morning to the centre and the afternoon out of it", () => {
    const am = planMap(routePlan(input("AM"), scenarioAssignment("AM"))).routes[0];
    expect(am.line[am.line.length - 1]).toEqual(PLAN_CENTER_COORD);
    expect(am.line[0]).toEqual(am.stops[0].coord);

    const pm = planMap(routePlan(input("PM"), scenarioAssignment("PM"))).routes[0];
    expect(pm.line[0]).toEqual(PLAN_CENTER_COORD);
    expect(pm.line[pm.line.length - 1]).toEqual(pm.stops[pm.stops.length - 1].coord);
    // The afternoon is the morning's stops in reverse, which is what the scenario says it is.
    expect(pm.stops.map((stop) => stop.label)).toEqual(
      [...am.stops.map((stop) => stop.label)].reverse(),
    );
  });
});

describe("the geometry is the committed survey, and says where it is not", () => {
  it("follows the surveyed road for every pair the day's own runs drive", () => {
    const data = planMap(routePlan(input(), scenarioAssignment()));
    for (const route of data.routes) {
      expect({ van: route.vanName, surveyed: route.surveyed }).toEqual({
        van: route.vanName,
        surveyed: true,
      });
      // A surveyed stretch is a road, not a ruler: more vertices than its two ends.
      for (const segment of route.segments) expect(segment.geometry.length).toBeGreaterThan(2);
    }
  });

  it("draws the line between two stops nobody surveyed, and marks it", () => {
    // Ivy H. into the centre van: a van that has never driven from Boynton Beach Mall now does,
    // and ADR-007 has no road for that pair. The stop is still drawn, and the stretch says it is
    // not a road.
    const base = input();
    const moved = tryMove(base, scenarioAssignment(), "C8", "V2");
    expect(moved.ok).toBe(true);
    if (!moved.ok) return;

    const route = planMap(routePlan(base, moved.assignment)).routes[1];
    expect(route.stops.map((stop) => stop.label)).toContain("Boynton Beach Mall");
    expect(route.surveyed).toBe(false);
    const straight = route.segments.filter((segment) => !segment.surveyed);
    expect(straight.length).toBeGreaterThan(0);
    for (const segment of straight) expect(segment.geometry).toHaveLength(2);
  });

  it("joins the stretches into one line with no repeated vertex", () => {
    const route = planMap(routePlan(input(), scenarioAssignment())).routes[0];
    const vertices = route.segments.reduce((n, segment) => n + segment.geometry.length, 0);
    expect(route.line).toHaveLength(vertices - (route.segments.length - 1));
    for (let i = 1; i < route.line.length; i += 1) {
      expect(route.line[i]).not.toEqual(route.line[i - 1]);
    }
  });
});

describe("the map follows a move, because it is the same answer the lanes are", () => {
  it("takes a child's kerb off one van's line and puts it on another's", () => {
    const base = input();
    const before = planMap(routePlan(base, scenarioAssignment()));
    const moved = tryMove(base, scenarioAssignment(), "C8", "V2");
    expect(moved.ok).toBe(true);
    if (!moved.ok) return;
    const after = planMap(routePlan(base, moved.assignment));

    const kerb = "Boynton Beach Mall";
    const labels = (data: typeof before, lane: string) =>
      data.routes.find((route) => route.laneId === lane)?.stops.map((stop) => stop.label) ?? [];
    expect(labels(before, "V1")).toContain(kerb);
    expect(labels(after, "V1")).not.toContain(kerb);
    expect(labels(before, "V2")).not.toContain(kerb);
    expect(labels(after, "V2")).toContain(kerb);
    // And the rider counts the pane prints beside each van moved with it.
    expect(after.routes.map((r) => r.riderCount)).toEqual([2, 4, 3]);
  });

  it("drops a line entirely when the last rider is taken out of a van", () => {
    const base = input();
    let assignment = scenarioAssignment();
    for (const token of ["C6", "C7", "C8"]) {
      const result = tryMove(base, assignment, token, null);
      expect(result.ok).toBe(true);
      if (result.ok) assignment = result.assignment;
    }
    const route = planMap(routePlan(base, assignment)).routes[0];
    expect(route.riderCount).toBe(0);
    expect(route.stops).toEqual([]);
    expect(route.line).toEqual([]);
    // One van emptied is not an empty map.
    expect(planMap(routePlan(base, assignment)).empty).toBe(false);
  });
});
