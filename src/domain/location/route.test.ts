import { describe, expect, it } from "vitest";
import {
  DWELL_SECONDS,
  freeFlowSecondsBetween,
  legAtDistance,
  measureRoute,
  nextStopIndex,
  reverseRoute,
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

/**
 * The afternoon of a morning run (`reverseRoute`). The demo scenario's afternoon is its morning
 * reversed — everyone boards at the centre and is set down in the reverse of the pickup order —
 * so the geometry is one survey read backwards rather than a second one that could drift from it.
 */
describe("reverseRoute", () => {
  const back = reverseRoute(ROUTE, { id: "test-route-pm" });

  it("keeps the vehicle and its device, and takes the new id", () => {
    expect(back.id).toBe("test-route-pm");
    expect(back.vehicleId).toBe(ROUTE.vehicleId);
    expect(back.deviceId).toBe(ROUTE.deviceId);
    expect(back.sourceMode).toBe(ROUTE.sourceMode);
  });

  it("visits the same stops in the opposite order, with their own labels and service times", () => {
    expect(back.stops.map((s) => s.id)).toEqual(["C", "B", "A"]);
    expect(back.stops.map((s) => s.familyLabel)).toEqual([undefined, "F2", "F1"]);
    expect(back.stops.map((s) => s.serviceSeconds)).toEqual([0, 480, 0]);
  });

  it("chains its legs stop to stop the other way, with each geometry reversed", () => {
    expect(back.legs.map((l) => [l.fromStopId, l.toStopId])).toEqual([
      ["C", "B"],
      ["B", "A"],
    ]);
    back.legs.forEach((leg, i) => {
      expect(leg.fromStopId).toBe(back.stops[i].id);
      expect(leg.toStopId).toBe(back.stops[i + 1].id);
      expect(leg.geometry[0]).toEqual(back.stops[i].coord);
    });
    expect(back.legs[0].geometry).toEqual([...ROUTE.legs[1].geometry].reverse());
  });

  it("is as long and as slow one way as the other, and leaves the original alone", () => {
    const there = measureRoute(ROUTE);
    const andBack = measureRoute(back);
    expect(andBack.path.totalM).toBeCloseTo(there.path.totalM, 6);
    expect(andBack.freeFlowSec).toBeCloseTo(there.freeFlowSec, 6);
    expect(ROUTE.stops.map((s) => s.id)).toEqual(["A", "B", "C"]);
    expect(ROUTE.legs[0].geometry[0]).toEqual([-80.145, 26.6]);
  });

  it("reversing twice is the route it started as", () => {
    const again = reverseRoute(back, { id: ROUTE.id });
    expect(again).toEqual(ROUTE);
  });
});
