import { describe, expect, it } from "vitest";
import { ROUTE_1, ROUTE_2 } from "@/fixtures/routes";
import { distanceM, measurePath } from "./geo";
import { measureRoute, routeGeometry, stopHoldSeconds } from "./route";
import {
  JITTER_METERS,
  mulberry32,
  runSimulation,
  SIM_TICK_SECONDS,
  TRAFFIC_FAULT_MULTIPLIER,
  type SimFault,
} from "./simulator";

const START = Date.UTC(2026, 9, 14, 11, 30, 0);

/** Simulated seconds spent driving, i.e. the run minus every stop hold. */
function driveSeconds(result: { points: { speedMps: number }[] }): number {
  return result.points.filter((p) => p.speedMps > 0).length * SIM_TICK_SECONDS;
}

function run(faults: SimFault[] = [], seed = 1, route = ROUTE_1, travelTimeMultiplier = 1) {
  return runSimulation({ route, startAtMs: START, seed, faults, travelTimeMultiplier });
}

describe("simulator cadence (ADR-013: 1 point / 5 s simulated)", () => {
  it("emits one point every 5 simulated seconds", () => {
    const { points } = run();
    expect(SIM_TICK_SECONDS).toBe(5);
    for (let i = 1; i < points.length; i += 1) {
      expect(points[i].recordedAtMs - points[i - 1].recordedAtMs).toBe(5000);
      expect(points[i].simSeconds - points[i - 1].simSeconds).toBe(5);
    }
    expect(points[0].recordedAtMs).toBe(START);
  });

  it("carries the route's device id and marks points bound by default", () => {
    const { points } = run();
    expect(new Set(points.map((p) => p.deviceId))).toEqual(new Set([ROUTE_1.deviceId]));
    expect(points.every((p) => p.bound)).toBe(true);
  });

  it("stays on the route geometry and finishes at the last stop", () => {
    const measured = measureRoute(ROUTE_1);
    const { points } = run();
    for (const point of points) {
      expect(point.routeDistanceM).toBeGreaterThanOrEqual(0);
      expect(point.routeDistanceM).toBeLessThanOrEqual(measured.path.totalM + 1e-6);
    }
    const last = points[points.length - 1];
    expect(last.routeDistanceM).toBeCloseTo(measured.path.totalM, 6);
    const end = routeGeometry(ROUTE_1).slice(-1)[0];
    expect(distanceM([last.lon, last.lat], end)).toBeLessThan(1);
  });

  it("takes about as long as the committed fixture durations plus the stop holds", () => {
    const measured = measureRoute(ROUTE_2);
    const holds = ROUTE_2.stops.slice(1).reduce((n, s) => n + stopHoldSeconds(s), 0);
    const { durationSeconds } = run([], 1, ROUTE_2);
    expect(durationSeconds).toBeGreaterThanOrEqual(measured.freeFlowSec + holds);
    expect(durationSeconds).toBeLessThan(measured.freeFlowSec + holds + 4 * SIM_TICK_SECONDS);
  });

  it("holds at every stop after the first for dwell + service, with speed 0 (PRD §8)", () => {
    const { points } = run([], 1, ROUTE_2);
    const measured = measureRoute(ROUTE_2);
    const s1 = measured.stopDistanceM[1];
    const atS1 = points.filter((p) => Math.abs(p.routeDistanceM - s1) < 1e-6);
    const hold = stopHoldSeconds(ROUTE_2.stops[1]);
    // Every point at the stop reports speed 0 except the last, which is the departure.
    expect(atS1.slice(0, -1).every((p) => p.speedMps === 0)).toBe(true);
    expect(atS1[atS1.length - 1].speedMps).toBeGreaterThan(0);
    const span = atS1[atS1.length - 1].simSeconds - atS1[0].simSeconds;
    expect(span).toBe(hold);
  });

  it("drives the simulated world at the travel-time multiplier it is given", () => {
    // Compare driving time, not run length: the dwell at the center is a fixed cost.
    expect(driveSeconds(run([], 1, ROUTE_1, 1.25)) / driveSeconds(run([], 1, ROUTE_1, 1))).toBeCloseTo(
      1.25,
      1,
    );
  });
});

describe("determinism (AT-03: same seed ⇒ same run)", () => {
  it("replays identically for the same seed and faults", () => {
    const faults: SimFault[] = [{ kind: "jitter", atSimSeconds: 0 }];
    expect(run(faults, 5).points).toEqual(run(faults, 5).points);
  });

  it("differs for a different seed, but only in the jittered positions", () => {
    const faults: SimFault[] = [{ kind: "jitter", atSimSeconds: 0 }];
    const a = run(faults, 5).points;
    const b = run(faults, 6).points;
    expect(a).not.toEqual(b);
    expect(a.map((p) => p.routeDistanceM)).toEqual(b.map((p) => p.routeDistanceM));
  });

  it("has a seeded PRNG that is stable in [0, 1)", () => {
    const first = Array.from({ length: 5 }, mulberry32(123));
    expect(Array.from({ length: 5 }, mulberry32(123))).toEqual(first);
    for (const value of first) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });
});

describe("faults (MOCKS-AND-DEMO §5)", () => {
  it("stall: the vehicle stops dead for the fault's duration, GPS still reporting", () => {
    const stalled = run([{ kind: "stall", atSimSeconds: 60, durationSec: 300 }], 1, ROUTE_2);
    const during = stalled.points.filter((p) => p.simSeconds >= 60 && p.simSeconds < 360);
    expect(during.length).toBeGreaterThan(50);
    expect(during.every((p) => p.speedMps === 0)).toBe(true);
    expect(during.every((p) => p.stalled)).toBe(true);
    expect(new Set(during.map((p) => p.routeDistanceM)).size).toBe(1);
    // It keeps reporting: this is a stall, not a gap.
    expect(during.every((p) => p.bound)).toBe(true);
    const clean = run([], 1, ROUTE_2);
    expect(stalled.durationSeconds - clean.durationSeconds).toBe(300);
  });

  it("traffic: ×1.5 travel time means ÷1.5 speed and a ~1.5× longer run", () => {
    const clean = run([], 1, ROUTE_1);
    const slow = run([{ kind: "traffic", atSimSeconds: 0 }], 1, ROUTE_1);
    expect(TRAFFIC_FAULT_MULTIPLIER).toBe(1.5);
    const drivingClean = clean.points.filter((p) => p.speedMps > 0);
    const drivingSlow = slow.points.filter((p) => p.speedMps > 0);
    expect(drivingSlow[0].speedMps).toBeCloseTo(drivingClean[0].speedMps / 1.5, 6);
    expect(driveSeconds(slow) / driveSeconds(clean)).toBeCloseTo(1.5, 1);
  });

  it("GPS gap: nothing is emitted while the vehicle keeps driving", () => {
    const gap = run([{ kind: "gpsGap", atSimSeconds: 100, durationSec: 200 }], 1, ROUTE_2);
    expect(gap.points.some((p) => p.simSeconds >= 100 && p.simSeconds < 300)).toBe(false);
    const after = gap.points.find((p) => p.simSeconds >= 300);
    const before = gap.points.filter((p) => p.simSeconds < 100).slice(-1)[0];
    expect(after).toBeDefined();
    // The truck moved on during the silence — that is the point of the fault.
    expect(after!.routeDistanceM).toBeGreaterThan(before.routeDistanceM + 1000);
    const clean = run([], 1, ROUTE_2);
    expect(gap.durationSeconds).toBe(clean.durationSeconds);
  });

  it("jitter: ±40 m of seeded noise on the reported position, never on the chainage", () => {
    const path = measurePath(routeGeometry(ROUTE_1));
    const clean = run([], 3, ROUTE_1);
    const jittered = run([{ kind: "jitter", atSimSeconds: 0 }], 3, ROUTE_1);
    const offsets = jittered.points.map((p, i) =>
      distanceM([p.lon, p.lat], [clean.points[i].lon, clean.points[i].lat]),
    );
    expect(Math.max(...offsets)).toBeGreaterThan(5);
    expect(Math.max(...offsets)).toBeLessThanOrEqual(JITTER_METERS * Math.SQRT2 + 1);
    expect(jittered.points.map((p) => p.routeDistanceM)).toEqual(
      clean.points.map((p) => p.routeDistanceM),
    );
    expect(path.totalM).toBeGreaterThan(0);
  });

  it("duplicate: the same (device, recorded_at) is emitted twice", () => {
    const { points } = run([{ kind: "duplicate", atSimSeconds: 20, count: 2 }]);
    const stamps = points.map((p) => p.recordedAtMs);
    const dupes = stamps.filter((s, i) => stamps.indexOf(s) !== i);
    expect(dupes).toHaveLength(2);
  });

  it("out-of-order: one pair arrives swapped, so a later stamp is delivered first", () => {
    const { points } = run([{ kind: "outOfOrder", atSimSeconds: 40 }]);
    const inversions = points.filter((p, i) => i > 0 && p.recordedAtMs < points[i - 1].recordedAtMs);
    expect(inversions).toHaveLength(1);
    // Nothing is lost: the same stamps, in a different order.
    expect([...points].map((p) => p.recordedAtMs).sort((a, b) => a - b)).toEqual(
      run().points.map((p) => p.recordedAtMs),
    );
  });

  it("unbound device: every point is marked bound=false", () => {
    const { points } = run([{ kind: "unboundDevice" }]);
    expect(points.every((p) => !p.bound)).toBe(true);
  });

  it("combines faults without interfering", () => {
    const { points } = run(
      [
        { kind: "jitter", atSimSeconds: 0 },
        { kind: "duplicate", atSimSeconds: 20 },
        { kind: "stall", atSimSeconds: 50, durationSec: 60 },
      ],
      9,
    );
    expect(points.some((p) => p.stalled)).toBe(true);
    expect(points.some((p) => p.jitterOffsetM[0] !== 0)).toBe(true);
  });
});
