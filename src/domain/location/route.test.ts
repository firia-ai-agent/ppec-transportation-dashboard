import { describe, expect, it } from "vitest";
import {
  DWELL_SECONDS,
  freeFlowSecondsBetween,
  legAtDistance,
  measureRoute,
  nextStopIndex,
  routeGeometry,
  stopHoldSeconds,
  type Route,
} from "./route";

/**
 * A synthetic two-leg route. The domain never imports fixtures (src/fixtures/routes.ts
 * is tested against ADR-007 provenance separately), so the numbers here are chosen to
 * be readable rather than real: each leg is ~1 km of due-north geometry with a round
 * free-flow duration.
 */
const ROUTE: Route = {
  id: "test-route",
  vehicleId: "V9",
  deviceId: "DEV-V9",
  stops: [
    { id: "A", name: "Stop A", coord: [-80.145, 26.6], familyLabel: "F1", serviceSeconds: 0 },
    { id: "B", name: "Stop B", coord: [-80.145, 26.609], familyLabel: "F2", serviceSeconds: 480 },
    { id: "C", name: "PPEC center", coord: [-80.145, 26.618], serviceSeconds: 0 },
  ],
  legs: [
    {
      fromStopId: "A",
      toStopId: "B",
      geometry: [
        [-80.145, 26.6],
        [-80.145, 26.6045],
        [-80.145, 26.609],
      ],
      distanceM: 1000,
      durationSec: 100,
      source: "DERIVED",
    },
    {
      fromStopId: "B",
      toStopId: "C",
      geometry: [
        [-80.145, 26.609],
        [-80.145, 26.618],
      ],
      distanceM: 1000,
      durationSec: 200,
      source: "DERIVED",
    },
  ],
  sourceMode: "SIMULATED",
};

const measured = measureRoute(ROUTE);
const [legA, legB] = measured.legs;

describe("stopHoldSeconds (PRD §8 ASM-12)", () => {
  it("is 3 min of dwell plus the child's service time", () => {
    expect(DWELL_SECONDS).toBe(180);
    expect(stopHoldSeconds(ROUTE.stops[0])).toBe(DWELL_SECONDS);
    // The wheelchair case: 3 min dwell + 8 min service.
    expect(stopHoldSeconds(ROUTE.stops[1])).toBe(DWELL_SECONDS + 480);
  });
});

describe("routeGeometry / measureRoute", () => {
  it("drops the vertex two legs share", () => {
    expect(routeGeometry(ROUTE)).toHaveLength(4);
  });

  it("gives each leg a span on the whole-route chainage, end to end", () => {
    expect(legA.startM).toBe(0);
    expect(legA.endM).toBeCloseTo(legA.geometryM, 6);
    expect(legB.startM).toBeCloseTo(legA.endM, 6);
    expect(legB.endM).toBeCloseTo(measured.path.totalM, 6);
  });

  it("places every stop on the chainage and sums only driving time", () => {
    expect(measured.stopDistanceM[0]).toBe(0);
    expect(measured.stopDistanceM[1]).toBeCloseTo(legA.endM, 6);
    expect(measured.stopDistanceM[2]).toBeCloseTo(measured.path.totalM, 6);
    // Dwell and service are *not* in freeFlowSec — the ETA engine adds them.
    expect(measured.freeFlowSec).toBe(300);
  });
});

describe("legAtDistance", () => {
  it("returns the leg the chainage falls in", () => {
    expect(legAtDistance(measured, 0).leg.toStopId).toBe("B");
    expect(legAtDistance(measured, legA.endM - 1).leg.toStopId).toBe("B");
    expect(legAtDistance(measured, legA.endM + 1).leg.toStopId).toBe("C");
  });

  it("clamps past the end to the last leg rather than throwing", () => {
    expect(legAtDistance(measured, measured.path.totalM * 2).leg.toStopId).toBe("C");
  });
});

describe("nextStopIndex", () => {
  it("is the first stop still ahead of the vehicle", () => {
    expect(nextStopIndex(measured, 0)).toBe(1);
    expect(nextStopIndex(measured, legA.endM - 1)).toBe(1);
    // Standing exactly on a stop counts as having reached it: the next stop is ahead.
    expect(nextStopIndex(measured, measured.stopDistanceM[1])).toBe(2);
  });

  it("is stops.length once every stop has been passed", () => {
    expect(nextStopIndex(measured, measured.path.totalM)).toBe(ROUTE.stops.length);
  });
});

describe("freeFlowSecondsBetween (ADR-007 committed durations only)", () => {
  it("is the whole leg duration from the origin to the next stop", () => {
    expect(freeFlowSecondsBetween(measured, 0, 1)).toBeCloseTo(100, 6);
  });

  it("sums the legs in between for a stop further down the route", () => {
    expect(freeFlowSecondsBetween(measured, 0, 2)).toBeCloseTo(300, 6);
  });

  it("takes a distance-proportional share of the leg the vehicle is on", () => {
    const halfway = legA.endM / 2;
    expect(freeFlowSecondsBetween(measured, halfway, 1)).toBeCloseTo(50, 1);
    // Half of leg A still to drive, then all of leg B.
    expect(freeFlowSecondsBetween(measured, halfway, 2)).toBeCloseTo(250, 1);
  });

  it("is 0 for a stop already reached or passed (no negative driving time)", () => {
    expect(freeFlowSecondsBetween(measured, legA.endM, 1)).toBe(0);
    expect(freeFlowSecondsBetween(measured, measured.path.totalM, 2)).toBe(0);
  });

  it("throws for a stop index that is not on the route", () => {
    expect(() => freeFlowSecondsBetween(measured, 0, 9)).toThrow(/no stop 9/);
  });
});
