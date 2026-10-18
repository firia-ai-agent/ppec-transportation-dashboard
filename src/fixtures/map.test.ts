import { describe, expect, it } from "vitest";
import { truckTone, type Coord } from "@/components/map/style";
import { DEMO_CENTER, MAP_FIXTURE } from "./map";
import { VEHICLES } from "@/modules/demo/fixtures/standard";
import { VANS, vanNameOf } from "@/config/vans";

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

  it("has the centre's three vans, each on its own route", () => {
    // Firia's 8:02 PM ET seed ruling: three vans, no reserve and no fourth vehicle anywhere.
    expect(MAP_FIXTURE.vehicles.map((v) => v.id)).toEqual(["V1", "V2", "V3"]);
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
  /**
   * The map draws the **seeded** fleet, which is the one the board plans with: the three vans of
   * src/modules/demo/fixtures/standard.ts, named by the one shared config (Firia's 8:02 PM ET
   * seed ruling; Vera/Athena 12:13 AM ET — one generic van, no sedan and no substitute).
   */
  it("draws the seeded vans, and says nothing about what kind of vehicle they are", () => {
    const seeded = new Set(VEHICLES.map((v) => v.key));
    expect(seeded.size).toBe(3);
    for (const vehicle of MAP_FIXTURE.vehicles) {
      expect(seeded.has(vehicle.id), `${vehicle.id} is on the map and not in the seed`).toBe(true);
      // Every van is the same generic kind, so no description names a type of vehicle…
      expect(vehicle.description).not.toMatch(/sedan|convertible|cent(?:er|re)|substitute/i);
      // …and the row a person reads is the van's name, never its key (§1.5).
      expect(vehicle.description).not.toMatch(/\bV\d\b/);
    }
    // Not vacuous: the map draws every van the config knows, by the name it gives them.
    expect(MAP_FIXTURE.vehicles).toHaveLength(VANS.length);
    expect(VANS.map((van) => vanNameOf(van.slot))).toEqual(["Van 1", "Van 2", "Van 3"]);
  });
});
