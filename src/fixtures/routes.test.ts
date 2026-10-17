/**
 * The three tracks the simulator replays (src/fixtures/routes.ts).
 *
 * The geometry itself is held by run-routes.test.ts — the measured distances, the derived
 * durations, the landmark coordinates, the leg chaining, the windows the plan promised. This file
 * is about the three tracks *as tracks*: which run each one is, which van drives it, and the
 * demo properties PRD §18.2 leans on. Asserting the geometry here too would only assert it twice,
 * because a track and its run are the same stops and the same legs — and that identity is the
 * first thing this file checks, since it is the whole of what changed
 * (docs/ui/B12-SLICE1-DEFERRED.md §3.1).
 */
import { describe, expect, it } from "vitest";
import osrmProbe from "../../docs/research/osrm-okeeheelee-to-center.json";
import { measureRoute, routeGeometry, type Route } from "@/domain/location/route";
import { CHILDREN, RUNS, childByKey } from "@/modules/demo/fixtures/standard";
import { PROBE_SPEED_MPS } from "./survey";
import { runRoute } from "./run-routes";
import { FIXTURE_ROUTES, ROUTE_1, ROUTE_2, ROUTE_3, routeById } from "./routes";

/** Which run's morning each track is. The mapping the module doc states, as a test. */
const TRACK_RUNS: Array<{ route: Route; runKey: string; vehicleId: string }> = [
  { route: ROUTE_1, runKey: "R3", vehicleId: "V4" },
  { route: ROUTE_2, runKey: "R1", vehicleId: "V1" },
  { route: ROUTE_3, runKey: "R2", vehicleId: "V2" },
];

describe("route fixtures (ADR-007: geometry and durations are committed, not computed)", () => {
  it("ships the three PRD §18.1 routes, one per run", () => {
    expect(FIXTURE_ROUTES.map((r) => r.id)).toEqual(["route1", "route2", "route3"]);
    expect(FIXTURE_ROUTES).toHaveLength(RUNS.length);
    expect(FIXTURE_ROUTES.map((r) => r.vehicleId)).toEqual(["V4", "V1", "V2"]);
    expect(new Set(FIXTURE_ROUTES.map((r) => r.deviceId)).size).toBe(3);
    expect(routeById("route2")).toBe(ROUTE_2);
    expect(() => routeById("route9")).toThrow(/unknown fixture route/);
  });

  /**
   * The §3.1 fix, stated as identity rather than as agreement: a track does not *match* its run's
   * geometry, it **is** its run's geometry, so there is no second survey left to drift.
   */
  it("is each run's own morning geometry, not a copy of it", () => {
    for (const { route, runKey, vehicleId } of TRACK_RUNS) {
      const run = runRoute(runKey, "AM");
      expect(route.stops, route.id).toBe(run.stops);
      expect(route.legs, route.id).toBe(run.legs);
      // The van and its device come from the run; only the fixture id is the track's own.
      expect(route.vehicleId, route.id).toBe(vehicleId);
      expect(route.deviceId, route.id).toBe(`DEV-${vehicleId}`);
      expect(route.id).not.toBe(run.id);
    }
  });

  it("drives the van the scenario puts on that run", () => {
    for (const { runKey, vehicleId } of TRACK_RUNS) {
      expect(RUNS.find((r) => r.key === runKey)?.vehicleKey, runKey).toBe(vehicleId);
    }
  });

  it("marks every route Simulated (NFR-09, ADR-015)", () => {
    for (const route of FIXTURE_ROUTES) expect(route.sourceMode).toBe("SIMULATED");
  });

  /**
   * What the board could not read before: a stop on the track is one of *this run's* children's
   * own kerbs, and its family label is that child's family. `route2` used to carry V1 past John
   * Prince Park labelled "F8" — R3's kerb, and a family who rides from Wellington Green.
   */
  it("stops only at its own run's children's stops, labelled with their own families", () => {
    for (const { route, runKey } of TRACK_RUNS) {
      const run = RUNS.find((r) => r.key === runKey)!;
      const theirs = new Set(run.childKeys.map((key) => childByKey(key).stopKey));
      for (const stop of route.stops) {
        if (stop.id === "CENTER") {
          // No family is texted about a van reaching the centre.
          expect(stop.familyLabel).toBeUndefined();
          expect(stop.serviceSeconds).toBe(0);
          continue;
        }
        expect(theirs, `${route.id} ${stop.id}`).toContain(stop.id);
        const riders = CHILDREN.filter((c) => c.stopKey === stop.id);
        expect(stop.familyLabel, stop.id).toBe(riders[0].familyKey);
      }
      expect(route.stops[route.stops.length - 1].id).toBe("CENTER");
    }
  });

  it("leaves route2 more than ten minutes of driving after its first leg", () => {
    // ASM-14 only notifies about a stop ≥10 min away, so the PRD step 7 stall needs a long
    // enough run to be demonstrable at all. R1's morning is the longest the scenario plans, and
    // replays.test.ts holds the other end of it: the stall really does damp a downstream window.
    const afterFirstLeg = ROUTE_2.legs.slice(1).reduce((a, l) => a + l.durationSec, 0);
    expect(afterFirstLeg).toBeGreaterThan(600);
    const longest = Math.max(...FIXTURE_ROUTES.map((r) => measureRoute(r).freeFlowSec));
    expect(measureRoute(ROUTE_2).freeFlowSec).toBe(longest);
  });

  it("gives route3 the GPS-gap run's three pickups, Okeeheelee first", () => {
    expect(ROUTE_3.stops.map((s) => s.id)).toEqual(["S2", "S3", "S8", "CENTER"]);
  });

  it("gives route1 the van whose device is never bound (LOC-01)", () => {
    expect(ROUTE_1.stops.map((s) => s.id)).toEqual(["S1", "S4", "CENTER"]);
    expect(ROUTE_1.vehicleId).toBe("V4");
  });

  /**
   * The one probe that was actually run (docs/research/osrm-probe.txt) measures Okeeheelee Park →
   * the centre, which no run in the scenario drives: R2 picks C2 up there and goes on to City
   * Hall. So it is no longer a committed leg, and the thing it still is — the speed every derived
   * duration is divided by — is asserted here, because nothing else would notice if it drifted.
   */
  it("keeps the committed OSRM response as the speed behind every derived duration", () => {
    const probe = osrmProbe.routes[0];
    expect(PROBE_SPEED_MPS).toBe(probe.distance / probe.duration);
    expect(PROBE_SPEED_MPS).toBeCloseTo(12.0114, 3);
    for (const route of FIXTURE_ROUTES) {
      for (const leg of route.legs) {
        // Unverified, every one of them: ADR-007's "replace with real OSRM responses when the
        // fixtures are regenerated" is now the only way a survey-grade leg gets in.
        expect(leg.source, `${route.id} ${leg.fromStopId}→${leg.toStopId}`).toBe("DERIVED");
        expect(leg.durationSec).toBeCloseTo(leg.distanceM / PROBE_SPEED_MPS, 0);
      }
    }
  });

  it("stays inside the Palm Beach County demo area (ledger row 5)", () => {
    for (const route of FIXTURE_ROUTES) {
      for (const [lng, lat] of routeGeometry(route)) {
        expect(lng).toBeGreaterThan(-80.3);
        expect(lng).toBeLessThan(-80.0);
        expect(lat).toBeGreaterThan(26.5);
        expect(lat).toBeLessThan(26.8);
      }
    }
  });
});

describe("measureRoute", () => {
  it("places stops on the chainage and sums the free-flow durations", () => {
    const measured = measureRoute(ROUTE_2);
    expect(measured.stopDistanceM[0]).toBe(0);
    expect(measured.stopDistanceM[1]).toBeCloseTo(ROUTE_2.legs[0].distanceM, 0);
    expect(measured.stopDistanceM[ROUTE_2.stops.length - 1]).toBeCloseTo(measured.path.totalM, 6);
    expect(measured.freeFlowSec).toBeCloseTo(
      ROUTE_2.legs.reduce((a, l) => a + l.durationSec, 0),
      6,
    );
  });

  it("does not repeat the vertex two legs share", () => {
    const vertices = ROUTE_2.legs.reduce((n, l) => n + l.geometry.length, 0);
    expect(routeGeometry(ROUTE_2)).toHaveLength(vertices - (ROUTE_2.legs.length - 1));
  });

  it("refuses a route with no legs", () => {
    const broken = { ...ROUTE_1, legs: [] } as Route;
    expect(() => measureRoute(broken)).toThrow(/no legs/);
  });
});
