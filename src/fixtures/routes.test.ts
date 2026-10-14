import { describe, expect, it } from "vitest";
import osrmProbe from "../../docs/research/osrm-okeeheelee-to-center.json";
import { distanceM, measurePath } from "@/domain/location/geo";
import { measureRoute, routeGeometry, type Route } from "@/domain/location/route";
import {
  CENTER_COORD,
  FIXTURE_ROUTES,
  PROBE_SPEED_MPS,
  ROUTE_1,
  ROUTE_2,
  ROUTE_3,
  WHEELCHAIR_SERVICE_SECONDS,
  routeById,
} from "./routes";

/** MOCKS §1 landmark coordinates, from docs/research/geocode.txt. */
const LANDMARKS: Record<string, [number, number]> = {
  S1: [-80.145953, 26.622639],
  S2: [-80.164767, 26.652165],
  S3: [-80.135511, 26.607061],
  S4: [-80.080532, 26.602482],
  CENTER: CENTER_COORD,
};

describe("route fixtures (ADR-007: geometry and durations are committed, not computed)", () => {
  it("ships the three PRD §18.1 routes, one per vehicle", () => {
    expect(FIXTURE_ROUTES.map((r) => r.id)).toEqual(["route1", "route2", "route3"]);
    expect(FIXTURE_ROUTES.map((r) => r.vehicleId)).toEqual(["V3", "V1", "V2"]);
    expect(new Set(FIXTURE_ROUTES.map((r) => r.deviceId)).size).toBe(3);
    expect(routeById("route2")).toBe(ROUTE_2);
    expect(() => routeById("route9")).toThrow(/unknown fixture route/);
  });

  it("marks every route Simulated (NFR-09, ADR-015)", () => {
    for (const route of FIXTURE_ROUTES) expect(route.sourceMode).toBe("SIMULATED");
  });

  it("uses only MOCKS §1 public landmarks, never a home", () => {
    for (const route of FIXTURE_ROUTES) {
      for (const stop of route.stops) {
        expect(LANDMARKS[stop.id]).toBeDefined();
        expect(stop.coord).toEqual(LANDMARKS[stop.id]);
      }
    }
  });

  it("ends every route at the center and visits each stop once", () => {
    for (const route of FIXTURE_ROUTES) {
      expect(route.stops[route.stops.length - 1].id).toBe("CENTER");
      expect(new Set(route.stops.map((s) => s.id)).size).toBe(route.stops.length);
    }
  });

  it("chains legs stop to stop, in travel order", () => {
    for (const route of FIXTURE_ROUTES) {
      expect(route.legs).toHaveLength(route.stops.length - 1);
      route.legs.forEach((leg, i) => {
        expect(leg.fromStopId).toBe(route.stops[i].id);
        expect(leg.toStopId).toBe(route.stops[i + 1].id);
      });
    }
  });

  it("starts and ends each leg's geometry at its stops (±10 m for the OSRM road snap)", () => {
    for (const route of FIXTURE_ROUTES) {
      for (const leg of route.legs) {
        const from = LANDMARKS[leg.fromStopId];
        const to = LANDMARKS[leg.toStopId];
        const first = leg.geometry[0];
        const last = leg.geometry[leg.geometry.length - 1];
        expect(distanceM(first, from)).toBeLessThan(10);
        expect(distanceM(last, to)).toBeLessThan(10);
      }
    }
  });

  it("keeps the committed distance within a metre or two of the committed geometry", () => {
    for (const route of FIXTURE_ROUTES) {
      for (const leg of route.legs) {
        const measured = measurePath(leg.geometry).totalM;
        expect(Math.abs(measured - leg.distanceM)).toBeLessThan(2);
      }
    }
  });

  it("derives every DERIVED duration from the one committed OSRM probe speed", () => {
    const derived = FIXTURE_ROUTES.flatMap((r) => r.legs).filter((l) => l.source === "DERIVED");
    expect(derived.length).toBeGreaterThan(0);
    for (const leg of derived) {
      expect(leg.durationSec).toBeCloseTo(leg.distanceM / PROBE_SPEED_MPS, 0);
    }
  });

  it("takes route1's one leg verbatim from the committed OSRM response", () => {
    const route = osrmProbe.routes[0];
    const leg = ROUTE_1.legs[0];
    expect(leg.source).toBe("OSRM_FIXTURE");
    expect(leg.distanceM).toBe(route.distance);
    expect(leg.durationSec).toBe(route.duration);
    expect(leg.geometry).toEqual(route.geometry.coordinates);
    expect(PROBE_SPEED_MPS).toBeCloseTo(12.0114, 3);
  });

  it("gives S1 the wheelchair service time and the center none (PRD §18.1 F2/C2, §8 ASM-12)", () => {
    const s1 = ROUTE_2.stops.find((s) => s.id === "S1");
    expect(s1?.serviceSeconds).toBe(WHEELCHAIR_SERVICE_SECONDS);
    expect(s1?.familyLabel).toBe("F2");
    for (const route of FIXTURE_ROUTES) {
      const center = route.stops[route.stops.length - 1];
      expect(center.serviceSeconds).toBe(0);
      // No family is texted about the vehicle reaching the center.
      expect(center.familyLabel).toBeUndefined();
    }
  });

  it("leaves route2 more than 10 minutes of driving after its first leg's midpoint", () => {
    // ASM-14 only notifies about a stop ≥10 min away, so the PRD step 7 stall needs a
    // long enough leg to be demonstrable at all. This is the assumption that fixes it.
    const legA = ROUTE_2.legs[0];
    expect(legA.durationSec).toBeGreaterThan(600);
  });

  it("gives route3 the shorter City Hall leg, for the GPS-gap run", () => {
    expect(ROUTE_3.stops.map((s) => s.id)).toEqual(["S3", "S1", "CENTER"]);
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
    expect(measured.stopDistanceM[2]).toBeCloseTo(measured.path.totalM, 6);
    expect(measured.freeFlowSec).toBeCloseTo(
      ROUTE_2.legs.reduce((a, l) => a + l.durationSec, 0),
      6,
    );
  });

  it("does not repeat the vertex two legs share", () => {
    const vertices = ROUTE_2.legs.reduce((n, l) => n + l.geometry.length, 0);
    expect(routeGeometry(ROUTE_2)).toHaveLength(vertices - 1);
  });

  it("refuses a route with no legs", () => {
    const broken = { ...ROUTE_1, legs: [] } as Route;
    expect(() => measureRoute(broken)).toThrow(/no legs/);
  });
});
