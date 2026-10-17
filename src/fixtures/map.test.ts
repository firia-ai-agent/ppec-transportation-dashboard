import { describe, expect, it } from "vitest";
import { truckTone, type Coord } from "@/components/map/style";
import { DEMO_CENTER, MAP_FIXTURE } from "./map";
import { FLEET } from "./fleet";

/**
 * MOCKS-AND-DEMO.md §1: the center plus public landmarks only, no homes. The seed
 * linter enforces this rule for seeded data; this test enforces it for the map
 * fixtures, which never go near the database.
 */
const MOCKS_GEOGRAPHY: Record<string, Coord> = {
  "PPEC center": [-80.145541, 26.645352],
  "Greenacres Branch Library": [-80.145953, 26.622639],
  "Okeeheelee Park": [-80.164767, 26.652165],
  "Greenacres City Hall": [-80.135511, 26.607061],
  "John Prince Park": [-80.080532, 26.602482],
  "Palm Beach State College, Lake Worth": [-80.085865, 26.613772],
  "Lantana Public Library": [-80.052871, 26.584699],
  "Boynton Beach Mall": [-80.095675, 26.535418],
  "Mall at Wellington Green": [-80.208099, 26.646683],
  "Palm Beach Zoo": [-80.069543, 26.667739],
};

describe("map fixtures", () => {
  it("centers on 2216 Jog Rd, Greenacres FL (MOCKS §1)", () => {
    expect(DEMO_CENTER).toEqual(MOCKS_GEOGRAPHY["PPEC center"]);
    expect(MAP_FIXTURE.center).toEqual(DEMO_CENTER);
    expect(MAP_FIXTURE.centerLabel).toBe("PPEC center");
  });

  it("uses only public landmarks from the MOCKS §1 table as stops", () => {
    for (const stop of MAP_FIXTURE.stops) {
      expect(Object.keys(MOCKS_GEOGRAPHY)).toContain(stop.name);
      expect(stop.coord).toEqual(MOCKS_GEOGRAPHY[stop.name]);
    }
  });

  it("marks every record Simulated (NFR-09)", () => {
    expect(MAP_FIXTURE.sourceMode).toBe("SIMULATED");
    expect(MAP_FIXTURE.sourceLabel).toBe("Simulated");
    for (const record of [...MAP_FIXTURE.stops, ...MAP_FIXTURE.vehicles, ...MAP_FIXTURE.routes]) {
      expect(record.sourceMode).toBe("SIMULATED");
    }
  });

  it("has V1–V4 (MOCKS §2), each on its own route", () => {
    expect(MAP_FIXTURE.vehicles.map((v) => v.id)).toEqual(["V1", "V2", "V3", "V4"]);
    const routeIds = new Set(MAP_FIXTURE.routes.map((r) => r.id));
    for (const vehicle of MAP_FIXTURE.vehicles) {
      expect(routeIds.has(vehicle.routeId)).toBe(true);
      const route = MAP_FIXTURE.routes.find((r) => r.id === vehicle.routeId);
      expect(route?.vehicleId).toBe(vehicle.id);
      // Every vehicle sits on its own driven geometry.
      expect(route?.planned).toContainEqual(vehicle.coord);
    }
  });

  it("shows all three truck tones at once, so the demo map exercises §8", () => {
    const tones = new Set(MAP_FIXTURE.vehicles.map((v) => truckTone(v.gpsAgeSeconds)));
    expect([...tones].sort()).toEqual(["crit", "ok", "stale"]);
  });

  it("keeps routes drawable: at least two planned points, driven within range", () => {
    for (const route of MAP_FIXTURE.routes) {
      expect(route.planned.length).toBeGreaterThanOrEqual(2);
      expect(route.drivenCount).toBeGreaterThanOrEqual(2);
      expect(route.drivenCount).toBeLessThanOrEqual(route.planned.length);
    }
  });

  it("stays inside the Palm Beach County demo area", () => {
    const coords: Coord[] = [
      MAP_FIXTURE.center,
      ...MAP_FIXTURE.stops.map((s) => s.coord),
      ...MAP_FIXTURE.vehicles.map((v) => v.coord),
      ...MAP_FIXTURE.routes.flatMap((r) => r.planned),
    ];
    for (const [lng, lat] of coords) {
      expect(lng).toBeGreaterThan(-80.25);
      expect(lng).toBeLessThan(-80.0);
      expect(lat).toBeGreaterThan(26.5);
      expect(lat).toBeLessThan(26.7);
    }
  });
});

/**
 * The live map and the Today board are two screens showing one fleet, and a coordinator reads a
 * van's name off the board and then looks for it on the map. The board's name is
 * `vehicle.label` from src/fixtures/fleet.ts; the map's is `vehicle.id` here, printed through
 * `fleetMap.vehicleRow` as "V1 · Convertible van". So the two files must agree about both parts,
 * or the screen called "Live map" would show vans the board has never heard of.
 */
describe("the map's vans are the board's vans", () => {
  it("uses the board's labels, and the board's words for what each van is", () => {
    const board = new Map(FLEET.map((v) => [v.label, v.description]));
    for (const vehicle of MAP_FIXTURE.vehicles) {
      expect(board.has(vehicle.id), `${vehicle.id} is on the map and not in the fleet`).toBe(true);
      expect({ id: vehicle.id, description: vehicle.description }).toEqual({
        id: vehicle.id,
        description: board.get(vehicle.id),
      });
    }
    // Not vacuous: the fleet is four vans and the map draws them.
    expect(MAP_FIXTURE.vehicles.length).toBeGreaterThanOrEqual(3);
  });
});
