import { describe, expect, it } from "vitest";
import { distanceM, measurePath } from "@/domain/location/geo";
import { measureRoute, routeGeometry } from "@/domain/location/route";
import { formatClock, plannedEta } from "@/domain/eta/eta";
import { trafficMultiplierAt } from "@/domain/eta/traffic";
import { manifestFor, plannedStops, plannedWindow } from "@/domain/board/scenario";
import { demoDay, localTimeOn } from "@/domain/board/day";
import { CHILDREN, RUNS, STOPS, childByKey } from "@/modules/demo/fixtures/standard";
import { places } from "@/ui/copy";
import { PROBE_SPEED_MPS, WHEELCHAIR_SERVICE_SECONDS } from "./survey";
import { CENTER_STOP_ID, RUN_ROUTES, runRoute } from "./run-routes";

/**
 * The geometry of the runs the scenario plans (ADR-007: committed, never computed at runtime).
 *
 * Two different questions in here. The first is the one every route fixture is asked: are the
 * numbers the geometry's own numbers, do the legs chain stop to stop, is every coordinate a
 * MOCKS §1 landmark. The second is the one this file exists for — **does the route agree with
 * the scenario**: the same stops, in the same order, with the same families against them, and
 * arrivals that land on the windows the plan promises. That second question is what was
 * unanswerable while the committed routes and the standard scenario were two separate stories
 * (docs/ui/B12-SLICE1-DEFERRED.md §3.1–§3.2).
 */

/** MOCKS §1 landmark coordinates, from the scenario's own stop table. */
const LANDMARKS: Record<string, [number, number]> = Object.fromEntries(
  STOPS.map((s) => [s.key, [s.lng, s.lat]]),
);

const routes = Object.values(RUN_ROUTES);

describe("one route per run per direction", () => {
  it("covers every run the scenario plans, both ways", () => {
    expect(Object.keys(RUN_ROUTES).sort()).toEqual(
      RUNS.flatMap((r) => [`${r.key}/AM`, `${r.key}/PM`]).sort(),
    );
    expect(runRoute("R1", "AM").vehicleId).toBe("V1");
    expect(() => runRoute("R9", "AM")).toThrow(/no AM route for run R9/);
  });

  it("marks every route Simulated (NFR-09, ADR-015)", () => {
    for (const route of routes) expect(route.sourceMode).toBe("SIMULATED");
  });

  it("drives one vehicle per run, with that vehicle's own device (ADR-013)", () => {
    for (const run of RUNS) {
      for (const direction of ["AM", "PM"] as const) {
        const route = runRoute(run.key, direction);
        expect(route.vehicleId).toBe(run.vehicleKey);
        expect(route.deviceId).toBe(`DEV-${run.vehicleKey}`);
      }
    }
  });

  it("uses only MOCKS §1 public landmarks, never a home", () => {
    for (const route of routes) {
      for (const stop of route.stops) {
        expect(LANDMARKS[stop.id], stop.id).toBeDefined();
        expect(stop.coord).toEqual(LANDMARKS[stop.id]);
      }
    }
  });

  it("names the centre and never addresses it (COPY-GUIDE §7)", () => {
    for (const route of routes) {
      const centre = route.stops.find((s) => s.id === CENTER_STOP_ID);
      expect(centre?.name).toBe(places.center);
      // No family is texted about a van reaching the centre, and no child is served there.
      expect(centre?.familyLabel).toBeUndefined();
      expect(centre?.serviceSeconds).toBe(0);
      expect(centre?.name).not.toMatch(/\d/);
    }
  });

  it("chains legs stop to stop, in travel order", () => {
    for (const route of routes) {
      expect(route.legs, route.id).toHaveLength(route.stops.length - 1);
      route.legs.forEach((leg, i) => {
        expect(leg.fromStopId).toBe(route.stops[i].id);
        expect(leg.toStopId).toBe(route.stops[i + 1].id);
      });
    }
  });

  it("starts and ends each leg's geometry at its own stops (±10 m)", () => {
    for (const route of routes) {
      for (const leg of route.legs) {
        const first = leg.geometry[0];
        const last = leg.geometry[leg.geometry.length - 1];
        expect(distanceM(first, LANDMARKS[leg.fromStopId]), leg.fromStopId).toBeLessThan(10);
        expect(distanceM(last, LANDMARKS[leg.toStopId]), leg.toStopId).toBeLessThan(10);
      }
    }
  });

  it("keeps every committed number its geometry's own number (ADR-007)", () => {
    for (const route of routes) {
      for (const leg of route.legs) {
        expect(Math.abs(measurePath(leg.geometry).totalM - leg.distanceM)).toBeLessThan(2);
        // DERIVED: duration = distance ÷ the one committed OSRM probe speed.
        expect(leg.source).toBe("DERIVED");
        expect(leg.durationSec).toBeCloseTo(leg.distanceM / PROBE_SPEED_MPS, 0);
      }
    }
  });

  it("stays inside the Palm Beach County demo area (ledger row 5)", () => {
    for (const route of routes) {
      for (const [lng, lat] of routeGeometry(route)) {
        expect(lng).toBeGreaterThan(-80.3);
        expect(lng).toBeLessThan(-80.0);
        expect(lat).toBeGreaterThan(26.5);
        expect(lat).toBeLessThan(26.8);
      }
    }
  });
});

/**
 * The alignment itself: the route is the scenario's run, not a route that happens to be near it.
 */
describe("the route is the run the scenario planned", () => {
  it("visits this run's own children's own stops, and nobody else's", () => {
    for (const run of RUNS) {
      const theirs = new Set(run.childKeys.map((k) => childByKey(k).stopKey));
      const visited = runRoute(run.key, "AM")
        .stops.filter((s) => s.id !== CENTER_STOP_ID)
        .map((s) => s.id);
      expect(new Set(visited), run.key).toEqual(theirs);
      // Once each: two siblings share a stop and a van stops there once (F4's C4 and C5).
      expect(new Set(visited).size).toBe(visited.length);
    }
  });

  it("stops in the order the manifest plans, and in the order the stops are named on it", () => {
    for (const run of RUNS) {
      for (const direction of ["AM", "PM"] as const) {
        const route = runRoute(run.key, direction);
        // The manifest names the centre once and each rider's stop once, in service order; two
        // siblings at one stop give it the same label twice, which a route visits once.
        const manifest = manifestFor(run, direction).map((s) => s.label);
        const routeNames = route.stops.map((s) => s.name);
        expect([...new Set(manifest)], `${run.key} ${direction}`).toEqual(routeNames);
      }
    }
  });

  it("labels each stop with the family that rides from it, for the §8 notifications", () => {
    for (const route of routes) {
      for (const stop of route.stops) {
        if (stop.id === CENTER_STOP_ID) continue;
        const riders = CHILDREN.filter((c) => c.stopKey === stop.id);
        expect(stop.familyLabel, stop.id).toBe(riders[0].familyKey);
      }
    }
  });

  it("gives a wheelchair stop its ASM-12 service time, and an ambulatory one none", () => {
    for (const route of routes) {
      for (const stop of route.stops) {
        if (stop.id === CENTER_STOP_ID) continue;
        const wheelchair = CHILDREN.some((c) => c.stopKey === stop.id && c.mobility === "WC");
        expect(stop.serviceSeconds, stop.id).toBe(wheelchair ? WHEELCHAIR_SERVICE_SECONDS : 0);
      }
    }
    // The scenario's two wheelchair riders, so this suite is about something: C2 at S2, C6 at S5.
    const service = routes.flatMap((r) => r.stops).filter((s) => s.serviceSeconds > 0);
    expect(new Set(service.map((s) => s.id))).toEqual(new Set(["S2", "S5"]));
  });

  /** The afternoon is the morning reversed, which is what the scenario says a run's day is. */
  it("drives the afternoon back down the same road", () => {
    for (const run of RUNS) {
      const am = runRoute(run.key, "AM");
      const pm = runRoute(run.key, "PM");
      expect(pm.stops.map((s) => s.id)).toEqual([...am.stops].reverse().map((s) => s.id));
      expect(pm.stops[0].id).toBe(CENTER_STOP_ID);
      expect(pm.legs.map((l) => [l.fromStopId, l.toStopId])).toEqual(
        [...am.legs].reverse().map((l) => [l.toStopId, l.fromStopId]),
      );
      // Same road, so the same length: the afternoon cannot drift from the morning's survey.
      expect(measureRoute(pm).path.totalM).toBeCloseTo(measureRoute(am).path.totalM, 6);
    }
  });
});

/**
 * And the part a coordinator sees: the window the geometry implies is the window the plan
 * promised the family. The run is anchored on its first family stop and everything after that
 * comes off the committed durations, so this is the check that the two agree the whole way down
 * the route rather than only at the top.
 */
describe("the plan's windows and the route's arrivals are the same story", () => {
  const day = demoDay();

  it.each(RUNS.flatMap((run) => (["AM", "PM"] as const).map((direction) => ({ run, direction }))))(
    "$run.key $direction reaches each child's stop within ten minutes of their window",
    ({ run, direction }) => {
      const planned = plannedStops(run, direction, day);
      for (const key of run.childKeys) {
        const child = childByKey(key);
        const stop = planned.find((s) => s.stopId === child.stopKey);
        expect(stop, `${key} has no stop on ${run.key} ${direction}`).toBeDefined();
        const promised = localTimeOn(day, plannedWindow(child, direction));
        const driftMinutes = Math.abs(stop!.etaMs! - promised) / 60000;
        expect(
          driftMinutes,
          `${key} ${direction}: route says ${formatClock(stop!.etaMs!)}, plan says ${formatClock(promised)}`,
        ).toBeLessThanOrEqual(10);
      }
    },
  );

  it("serves the first family of a run at exactly the window they were given", () => {
    // The anchor, stated as a promise rather than as an accident of the geometry: the morning
    // leaves a child's stop at their window, and the afternoon leaves the centre early enough.
    const measured = measureRoute(runRoute("R1", "PM"));
    const planned = plannedEta({
      measured,
      departureMs: localTimeOn(day, "15:45") - 1417.5 * 1.2 * 1000,
      trafficMultiplier: 1.2,
    });
    expect(planned.find((s) => s.stopId === "S7")?.etaMs).toBe(localTimeOn(day, "15:45"));
    expect(plannedWindow(childByKey("C8"), "PM")).toBe("15:45");
  });
});
