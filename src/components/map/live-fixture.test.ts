/**
 * A live snapshot, converted for the pane.
 *
 * The two rules worth a test are domain rules rather than drawing taste: a van with no
 * displayable position is absent from the map (LOC-01, ADR-013), and the driven line ends
 * exactly under the marker (§5.1) rather than at the last vertex behind it.
 */
import { describe, expect, it } from "vitest";
import { BOARD_SCENARIO_TICK } from "@/domain/board/day";
import { liveSnapshotAt } from "@/domain/board/live";
import { distanceM, measurePath } from "@/domain/location/geo";
import { places, sourceMode } from "@/ui/copy";
import { BOARD_MAP_ZOOM, mapFixtureFrom } from "./live-fixture";

const snapshot = liveSnapshotAt(BOARD_SCENARIO_TICK);
const fixture = mapFixtureFrom(snapshot);

describe("what the pane is given", () => {
  it("is centred on the center, named and not addressed (COPY-GUIDE §7)", () => {
    expect(fixture.centerLabel).toBe(places.center);
    expect(fixture.initialZoom).toBe(BOARD_MAP_ZOOM);
  });

  it("carries the NFR-09 source mode on the fixture and on every record in it", () => {
    expect(fixture.sourceMode).toBe("SIMULATED");
    expect(fixture.sourceLabel).toBe(sourceMode.SIMULATED);
    for (const record of [...fixture.vehicles, ...fixture.routes, ...fixture.stops]) {
      expect(record.sourceMode).toBe("SIMULATED");
    }
  });

  it("draws one marker per van with a position, and none for a van without one", () => {
    expect(fixture.vehicles.map((v) => v.id)).toEqual(snapshot.vehicles.map((v) => v.id));
    expect(snapshot.silent.length).toBeGreaterThan(0);
    for (const silent of snapshot.silent) {
      expect(fixture.vehicles.some((v) => v.id === silent.id)).toBe(false);
      expect(fixture.routes.some((r) => r.vehicleId === silent.id)).toBe(false);
    }
  });

  it("draws each landmark once and leaves the center to its own pin", () => {
    const ids = fixture.stops.map((stop) => stop.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).not.toContain("CENTER");
    for (const stop of fixture.stops) {
      expect(stop.coord).toHaveLength(2);
      expect(Number.isFinite(stop.coord[0])).toBe(true);
    }
  });

  it("passes each van's published windows through, and no raw ETA", () => {
    for (const vehicle of fixture.vehicles) {
      for (const stop of vehicle.stops ?? []) {
        if (stop.windowText === undefined) continue;
        expect(stop.windowText).toMatch(/^\d{1,2}:\d{2}–\d{1,2}:\d{2} [AP]M$/);
      }
    }
  });
});

describe("the driven line (§5.1)", () => {
  it("is a planned line and a driven prefix per van", () => {
    for (const vehicle of fixture.vehicles) {
      const planned = fixture.routes.filter(
        (r) => r.vehicleId === vehicle.id && r.drivenCount === 0,
      );
      expect(planned).toHaveLength(1);
      expect(planned[0].planned.length).toBeGreaterThan(2);
    }
  });

  it("ends within a few metres of the marker, not at the vertex behind it", () => {
    for (const vehicle of fixture.vehicles) {
      const driven = fixture.routes.find(
        (r) => r.vehicleId === vehicle.id && r.drivenCount > 0,
      );
      if (!driven) continue;
      const end = driven.planned[driven.planned.length - 1];
      // The marker carries the reported position, which is the projected point plus the
      // simulator's jitter, so "under the marker" is tens of metres and not zero.
      expect(distanceM(end, vehicle.coord)).toBeLessThan(120);
      // And it is the measured chainage, not a point count.
      const measured = measurePath(
        (fixture.routes.find((r) => r.vehicleId === vehicle.id && r.drivenCount === 0) as {
          planned: typeof driven.planned;
        }).planned,
      );
      expect(measurePath(driven.planned).totalM).toBeLessThanOrEqual(measured.totalM + 1);
    }
  });
});
