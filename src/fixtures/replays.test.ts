/**
 * The four demo runs (src/fixtures/replays.ts).
 *
 * These fixtures drive both /live-map and the replay tests, so the things the live map
 * assumes about them are asserted here rather than left as a comment: that each run really
 * shows the fault its label claims, that the clock's loop length actually covers every run,
 * and that the unbound device stays invisible.
 *
 * Pure: `runReplay` takes no clock and touches no database, so this file runs the whole
 * simulated fleet in milliseconds.
 */
import { describe, expect, it } from "vitest";
import { displayablePosition } from "@/domain/location/ingest";
import { runReplay } from "@/domain/eta/replay";
import { GPS_LOST_SECONDS, GPS_STALE_SECONDS } from "@/domain/location/freshness";
import { trafficBandAt } from "@/domain/eta/traffic";
import { CHILDREN, RUNS, VEHICLES } from "@/modules/demo/fixtures/standard";
import { ROUTE_1, ROUTE_2 } from "./routes";
import {
  DEMO_RUNS,
  DEMO_RUN_SECONDS,
  RUN_GPS_GAP,
  RUN_JITTER,
  RUN_STALL,
  RUN_UNBOUND,
  SCENARIO_START_MS,
  UNBOUND_ROUTE,
  VAN3_ROUTE,
} from "./replays";

describe("the demo run set", () => {
  it("is the four runs the live map's vehicle list holds, each one once", () => {
    expect(DEMO_RUNS.map((r) => r.spec)).toEqual([RUN_STALL, RUN_GPS_GAP, RUN_JITTER, RUN_UNBOUND]);
    expect(new Set(DEMO_RUNS.map((r) => r.spec.route.id)).size).toBe(DEMO_RUNS.length);
    expect(new Set(DEMO_RUNS.map((r) => r.spec.route.vehicleId)).size).toBe(DEMO_RUNS.length);
    expect(new Set(DEMO_RUNS.map((r) => r.spec.route.deviceId)).size).toBe(DEMO_RUNS.length);
  });

  it("gives every run a fault label, in words a reviewer can read", () => {
    for (const run of DEMO_RUNS) {
      expect(run.faultLabel.length).toBeGreaterThan(0);
      expect(run.spec.faults ?? []).not.toHaveLength(0);
      // The label is rendered, so it carries no ticket code and no PRD section (COPY-GUIDE §2).
      expect(run.faultLabel).not.toMatch(/\b(?:AT|ADR|LOC|SURF)-\d+/);
      expect(run.faultLabel).not.toMatch(/PRD\s*§/);
    }
    expect(new Set(DEMO_RUNS.map((r) => r.faultLabel)).size).toBe(DEMO_RUNS.length);
  });

  it("starts every run on the same scenario clock, inside one traffic band", () => {
    // A shared start is what makes the four trucks comparable on one clock, and a single
    // band is what keeps an ETA explainable as "fixture duration × band".
    for (const run of DEMO_RUNS) expect(run.spec.startAtMs).toBe(SCENARIO_START_MS);
    expect(trafficBandAt(SCENARIO_START_MS).id).toBe("am-peak");
  });

  it("is deterministic: the same spec replays to the same points (AT-03)", () => {
    for (const run of DEMO_RUNS) {
      const a = runReplay(run.spec);
      const b = runReplay(run.spec);
      expect(a.accepted.map((p) => [p.recordedAtMs, p.lat, p.lon])).toEqual(
        b.accepted.map((p) => [p.recordedAtMs, p.lat, p.lon]),
      );
      expect(a.decisions).toEqual(b.decisions);
    }
  });
});

describe("DEMO_RUN_SECONDS is the live map's scenario-clock loop length", () => {
  it("covers every run from end to end", () => {
    // The live map's scenario clock wraps at DEMO_RUN_SECONDS. If any run were longer, its last stop
    // would never be reached on screen — the loop would cut the truck off mid-route.
    for (const run of DEMO_RUNS) {
      const result = runReplay(run.spec);
      expect(
        { route: run.spec.route.id, fits: result.run.durationSeconds <= DEMO_RUN_SECONDS },
        `${run.spec.route.id} runs ${result.run.durationSeconds} s`,
      ).toEqual({ route: run.spec.route.id, fits: true });
    }
  });

  it("is no longer than it needs to be: the longest run reaches most of the way through", () => {
    // Guards the other direction — a loop several times the longest run would leave the
    // live map sitting on four parked trucks for most of its cycle.
    const longest = Math.max(...DEMO_RUNS.map((r) => runReplay(r.spec).run.durationSeconds));
    expect(longest).toBeGreaterThan(DEMO_RUN_SECONDS / 2);
    expect(longest).toBeLessThanOrEqual(DEMO_RUN_SECONDS);
  });

  it("covers the last accepted point and the last decision too", () => {
    const endOfLoopMs = SCENARIO_START_MS + DEMO_RUN_SECONDS * 1000;
    for (const run of DEMO_RUNS) {
      const result = runReplay(run.spec);
      for (const point of result.accepted) expect(point.recordedAtMs).toBeLessThanOrEqual(endOfLoopMs);
      for (const decision of result.decisions) expect(decision.atMs).toBeLessThanOrEqual(endOfLoopMs);
    }
  });
});

describe("each run shows the fault its label claims", () => {
  it("the stall holds the vehicle still for the twelve minutes the label says", () => {
    expect(RUN_STALL.faults).toEqual([{ kind: "stall", atSimSeconds: 120, durationSec: 720 }]);
    const result = runReplay(RUN_STALL);
    const stopped = result.accepted.filter((p) => p.speedMps === 0);
    expect(stopped.length).toBeGreaterThan(0);
    const span = (stopped[stopped.length - 1].recordedAtMs - stopped[0].recordedAtMs) / 1000;
    expect(span).toBeGreaterThanOrEqual(600);
  });

  it("the GPS gap walks both LOC-03 bands and raises exactly one exception", () => {
    const result = runReplay(RUN_GPS_GAP);
    const gaps = result.accepted
      .slice(1)
      .map((p, i) => (p.recordedAtMs - result.accepted[i].recordedAtMs) / 1000);
    const longest = Math.max(...gaps);
    expect(longest).toBeGreaterThan(GPS_STALE_SECONDS);
    expect(longest).toBeGreaterThan(GPS_LOST_SECONDS);
    // One exception per loss, not one per sweep (LOC-03).
    expect(result.exceptions).toHaveLength(1);
    expect(result.exceptions[0]).toMatchObject({
      deviceId: RUN_GPS_GAP.route.deviceId,
      dispatcherPing: true,
    });
    expect(result.exceptions[0].recoveredAtMs).toBeDefined();
  });

  it("the GPS-gap run also carries the duplicate and out-of-order points (AT-11)", () => {
    const result = runReplay(RUN_GPS_GAP);
    const counts = result.ingest.devices[RUN_GPS_GAP.route.deviceId].counts;
    expect(counts.duplicate).toBeGreaterThan(0);
    expect(counts.outOfOrder).toBeGreaterThan(0);
    // Neither kind ever became a displayable position.
    expect(counts.accepted).toBe(result.accepted.length);
  });

  it("the jitter run moves the marker and never rewinds the stored position", () => {
    expect(RUN_JITTER.faults).toEqual([{ kind: "jitter", atSimSeconds: 0, meters: 40 }]);
    const result = runReplay(RUN_JITTER);
    const stamps = result.accepted.map((p) => p.recordedAtMs);
    expect([...stamps].sort((a, b) => a - b)).toEqual(stamps);
    // Jitter is a position wobble, so no two accepted points share a coordinate exactly.
    const coords = new Set(result.accepted.map((p) => `${p.lat},${p.lon}`));
    expect(coords.size).toBe(result.accepted.length);
  });

  it("the unbound device is ingested, stored and displayed nowhere (LOC-01, ADR-013)", () => {
    expect(RUN_UNBOUND.route).toBe(UNBOUND_ROUTE);
    const result = runReplay(RUN_UNBOUND);
    const device = result.ingest.devices[UNBOUND_ROUTE.deviceId];
    expect(device.counts.unbound).toBeGreaterThan(0);
    expect(device.counts.accepted).toBe(0);
    expect(result.accepted).toEqual([]);
    expect(displayablePosition(result.ingest, UNBOUND_ROUTE.deviceId)).toBeUndefined();
    // No position at all is a location loss, not a fresh reading.
    expect(result.exceptions).toHaveLength(1);
    expect(result.notifications).toEqual([]);
  });
});

describe("UNBOUND_ROUTE", () => {
  it("is R3's geometry under a device that is linked to nothing", () => {
    expect(UNBOUND_ROUTE.stops).toBe(ROUTE_1.stops);
    expect(UNBOUND_ROUTE.legs).toBe(ROUTE_1.legs);
    expect(UNBOUND_ROUTE.id).not.toBe(ROUTE_1.id);
    // A different device from the van that drives this road: one device per vehicle (ADR-013).
    expect(UNBOUND_ROUTE.deviceId).not.toBe(ROUTE_1.deviceId);
    expect(UNBOUND_ROUTE.vehicleId).not.toBe(ROUTE_1.vehicleId);
  });

  it("leaves Van 3 a road of its own, with its own device", () => {
    expect(VAN3_ROUTE.stops).toBe(ROUTE_2.stops);
    expect(VAN3_ROUTE.id).not.toBe(ROUTE_2.id);
    expect(VAN3_ROUTE.vehicleId).toBe("V3");
    expect(VAN3_ROUTE.deviceId).not.toBe(ROUTE_2.deviceId);
    // Van 3 is a van the scenario runs, not a reserve (Firia's 8:02 PM ET seed ruling).
    expect(RUNS.map((r) => r.vehicleKey)).toContain(VAN3_ROUTE.vehicleId);
  });

  it("belongs to no van in the fleet at all (LOC-01)", () => {
    // Three vans, three runs, and this device is on none of them: that is the whole of LOC-01
    // now that there is no reserve to hold back (Firia's 8:02 PM ET seed ruling).
    expect(RUNS.map((r) => r.vehicleKey)).not.toContain(UNBOUND_ROUTE.vehicleId);
    expect(VEHICLES.map((v) => v.key)).not.toContain(UNBOUND_ROUTE.vehicleId);
  });
});

/**
 * The tracks are the scenario's own runs now (src/fixtures/routes.ts), so a van on a demo run
 * reaches its own riders' kerbs and the §8 notification decisions name the families who ride from
 * them. These are the two consequences the board and the demo script depend on.
 */
describe("a demo run is the run the scenario planned", () => {
  it("texts the family that rides from the stop, and never another run's", () => {
    for (const run of DEMO_RUNS) {
      const result = runReplay(run.spec);
      for (const decision of result.decisions) {
        if (decision.stopId === "CENTER") {
          expect(decision.familyLabel, run.spec.route.id).toBeUndefined();
          continue;
        }
        const riders = CHILDREN.filter((c) => c.stopKey === decision.stopId);
        expect(riders.length, `${run.spec.route.id} ${decision.stopId}`).toBeGreaterThan(0);
        expect(decision.familyLabel).toBe(riders[0].familyKey);
      }
    }
  });

  it("damps the stall into a downstream family's window and leaves the served stop alone (AT-03)", () => {
    const result = runReplay(RUN_STALL);
    const stallAtMs = SCENARIO_START_MS + 120 * 1000;
    const notified = result.notifications.filter((d) => d.atMs > stallAtMs);
    expect(notified.length).toBeGreaterThan(0);
    for (const decision of notified) {
      // ASM-14: ten minutes of shift, about a stop that is still ahead and ≥10 min away.
      expect(Math.abs(decision.shiftSeconds)).toBeGreaterThanOrEqual(600);
      expect(decision.windowText).toBeDefined();
    }
    // Downstream only: the run's first pickup is its own origin, so it can never be notified.
    const origin = RUN_STALL.route.stops[0].id;
    expect(result.notifications.map((d) => d.stopId)).not.toContain(origin);
    expect(
      result.decisions
        .filter((d) => d.stopId === origin)
        .every((d) => d.outcome === "SUPPRESS" && d.reason === "arrived"),
    ).toBe(true);
  });
});
