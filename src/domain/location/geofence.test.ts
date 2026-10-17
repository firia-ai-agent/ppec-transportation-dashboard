import { describe, expect, it } from "vitest";
import { ROUTE_2 } from "@/fixtures/routes";
import {
  ARRIVAL_IS_NOT_HANDOFF,
  arrivalStateFor,
  emptyGeofenceState,
  GEOFENCE_DWELL_SECONDS,
  GEOFENCE_MAX_SPEED_MPS,
  GEOFENCE_RADIUS_M,
  geofenceStep,
  type GeofenceState,
} from "./geofence";
import { offsetByMeters } from "./geo";
import type { StoredPoint } from "./ingest";

const T0 = Date.UTC(2026, 9, 14, 11, 30, 0);
const STOPS = ROUTE_2.stops;
/** A mid-run pickup on the committed track, and the centre it ends at — by position, not by id. */
const PICKUP = STOPS[1];
const CENTRE = STOPS[STOPS.length - 1];

let sequence = 0;
function at(
  coord: [number, number],
  offsetSeconds: number,
  speedMps = 0,
): StoredPoint {
  sequence += 1;
  return {
    deviceId: ROUTE_2.deviceId,
    recordedAtMs: T0 + offsetSeconds * 1000,
    lat: coord[1],
    lon: coord[0],
    speedMps,
    headingDeg: 0,
    bound: true,
    sequence,
  };
}

function feed(points: StoredPoint[]): { state: GeofenceState; arrivals: string[] } {
  let state = emptyGeofenceState();
  const arrivals: string[] = [];
  for (const point of points) {
    const step = geofenceStep(state, STOPS, point);
    state = step.state;
    if (step.arrival) arrivals.push(`${step.arrival.stopId}:${step.arrival.state}`);
  }
  return { state, arrivals };
}

describe("ASM-18 geofence rule: 100 m and <2 m/s for ≥20 s", () => {
  it("uses the decided thresholds", () => {
    expect([GEOFENCE_RADIUS_M, GEOFENCE_MAX_SPEED_MPS, GEOFENCE_DWELL_SECONDS]).toEqual([
      100, 2, 20,
    ]);
  });

  it("fires once the 20 s condition is met, not on the first slow point", () => {
    const { arrivals } = feed([
      at(PICKUP.coord, 0),
      at(PICKUP.coord, 10),
      at(PICKUP.coord, 15),
      at(PICKUP.coord, 20),
    ]);
    expect(arrivals).toEqual([`${PICKUP.id}:ARRIVED_PICKUP`]);
  });

  it("does not fire before 20 s have passed", () => {
    expect(feed([at(PICKUP.coord, 0), at(PICKUP.coord, 15)]).arrivals).toEqual([]);
  });

  it("does not fire for a vehicle driving past at speed", () => {
    expect(
      feed([at(PICKUP.coord, 0, 12), at(PICKUP.coord, 20, 12), at(PICKUP.coord, 40, 12)]).arrivals,
    ).toEqual([]);
  });

  it("does not fire outside 100 m", () => {
    const far = offsetByMeters(PICKUP.coord, 150, 0);
    expect(feed([at(far, 0), at(far, 30)]).arrivals).toEqual([]);
  });

  it("fires inside 100 m", () => {
    const near = offsetByMeters(PICKUP.coord, 80, 0);
    expect(feed([at(near, 0), at(near, 25)]).arrivals).toEqual([`${PICKUP.id}:ARRIVED_PICKUP`]);
  });

  it("restarts the streak when the vehicle leaves the geofence", () => {
    const far = offsetByMeters(PICKUP.coord, 300, 0);
    const { arrivals } = feed([
      at(PICKUP.coord, 0),
      at(PICKUP.coord, 15),
      at(far, 20, 12),
      at(PICKUP.coord, 25),
      at(PICKUP.coord, 35),
    ]);
    expect(arrivals).toEqual([]);
  });

  it("fires once per stop, not once per point", () => {
    const { arrivals } = feed([
      at(PICKUP.coord, 0),
      at(PICKUP.coord, 25),
      at(PICKUP.coord, 50),
      at(PICKUP.coord, 75),
    ]);
    expect(arrivals).toEqual([`${PICKUP.id}:ARRIVED_PICKUP`]);
  });

  it("reports which stop, when, and how far out", () => {
    const near = offsetByMeters(PICKUP.coord, 50, 0);
    const step = geofenceStep(
      { candidateSinceMs: { [PICKUP.id]: T0 }, arrived: [] },
      STOPS,
      at(near, 25),
    );
    expect(step.arrival).toMatchObject({ stopId: PICKUP.id, state: "ARRIVED_PICKUP", atMs: T0 + 25_000 });
    expect(step.arrival?.distanceM).toBeCloseTo(50, 0);
  });
});

describe("AT-10: geofence sets ARRIVED_* only, never COMPLETED_HANDOFF", () => {
  it("has no value for handoff to return", () => {
    // Structural, not a matter of discipline: the only states are the two ARRIVED_*.
    expect(arrivalStateFor(0, 3)).toBe("ARRIVED_PICKUP");
    expect(arrivalStateFor(1, 3)).toBe("ARRIVED_PICKUP");
    expect(arrivalStateFor(2, 3)).toBe("ARRIVED_DROPOFF");
  });

  it("produces ARRIVED_DROPOFF at the center and never a handoff", () => {
    let state = emptyGeofenceState();
    const results = [at(CENTRE.coord, 0), at(CENTRE.coord, 30)].map((point) => {
      const step = geofenceStep(state, STOPS, point);
      state = step.state;
      return step.arrival;
    });
    const arrival = results.filter(Boolean).at(-1);
    expect(arrival?.state).toBe("ARRIVED_DROPOFF");
    for (const value of results) {
      expect(String(value?.state)).not.toContain("HANDOFF");
    }
  });

  it("says in words that an arrival is not a handoff (SURF-01 l.1058)", () => {
    expect(ARRIVAL_IS_NOT_HANDOFF).toContain("Arrived (vehicle)");
    expect(ARRIVAL_IS_NOT_HANDOFF).toContain("custody event");
    expect(ARRIVAL_IS_NOT_HANDOFF).not.toContain("Handed off");
  });
});
