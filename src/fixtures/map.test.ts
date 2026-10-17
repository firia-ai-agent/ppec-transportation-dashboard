import { describe, expect, it } from "vitest";
import { truckTone, type Coord } from "@/components/map/style";
import { vanTitle } from "@/ui/copy";
import { PROVIDERS as DEMO_PROVIDERS, providerDisplayName } from "@/modules/demo/fixtures/standard";
import { DEMO_CENTER, DEMO_VEHICLES, MAP_FIXTURE } from "./map";
import { FLEET, PROVIDERS } from "./fleet";

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
 * van's name off the board and then looks for it on the map. The board's `description` comes
 * from src/fixtures/fleet.ts and the map's from here, and both are turned into words by the one
 * helper (`vanTitle`), so the two files must agree about it — or the screen called "Live map"
 * would show vans the board has never heard of. The `id` is the join between them, which is why
 * it is a key here and not words on a card (Vera's prod walk, 2026-10-17 2:48 PM ET).
 */
describe("the map's vans are the board's vans", () => {
  it("uses the board's keys, and the board's words for what each van is", () => {
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

  it("gives every van a name a person could say, which is what a card and a marker show", () => {
    for (const vehicle of MAP_FIXTURE.vehicles) {
      const name = vanTitle(vehicle.description);
      expect(name, vehicle.id).toMatch(/^[A-Z]/);
      expect(name, vehicle.id).not.toMatch(/\bV\d\b/);
    }
  });
});

/**
 * WHO RUNS EACH VAN ON THE MAP — pinned, because this field is the most-rendered name on the
 * pane and it has been wrong twice.
 *
 * `owner` is printed on every vehicle card (`fleetMap.vehicleMeta`, src/components/map/FleetMap.tsx)
 * and the live map hands the same field to its own cards (src/components/map/LiveFleetMap.tsx).
 * It was the literal "Provider P1" — the fixture's own key with a column heading in front of it
 * — and that string was still on prod at Vera's walk (2026-10-17 2:48 PM ET). It reads the
 * scenario's providers now, through `providerDisplayName`, which is the one boundary the
 * synthetic "SYN" marker comes off at.
 *
 * Veri's mutation check, 3:27 PM ET: putting either of those back has to fail a test, and these
 * are it. Both halves are asserted — that the name is the scenario's company, and that neither
 * of the two shapes that were wrong can come back.
 */
describe("a van's operator on the map is a company, not a fixture key", () => {
  it("names the scenario's own provider for every van the map draws", () => {
    expect(DEMO_VEHICLES.length).toBeGreaterThan(3);
    for (const vehicle of DEMO_VEHICLES) {
      const fleetVan = FLEET.find((v) => v.label === vehicle.id);
      expect(fleetVan, `${vehicle.id} is on the map and not in the fleet`).toBeDefined();
      // The same operator the board's own fixture gives this van, by name.
      expect(vehicle.owner, vehicle.id).toBe(fleetVan!.providerName);
      // ...which is a provider out of the demo scenario, with the marker taken off.
      const scenario = DEMO_PROVIDERS.find((pr) => providerDisplayName(pr.name) === vehicle.owner);
      expect(scenario, `${vehicle.id}: "${vehicle.owner}" is no provider in the scenario`).toBeDefined();
    }
  });

  it("and neither shape that was on the screen can come back", () => {
    for (const vehicle of DEMO_VEHICLES) {
      // The key with a column heading in front of it.
      expect(vehicle.owner, vehicle.id).not.toMatch(/^Provider P\d$/);
      expect(vehicle.owner, vehicle.id).not.toMatch(/Provider P\d/);
      // The fixture's synthetic marker, which belongs in the database and not on a card.
      expect(vehicle.owner, vehicle.id).not.toMatch(/\bSYN\b/);
    }
    // The three companies, verbatim, so a rename has to be deliberate.
    expect([...new Set(DEMO_VEHICLES.map((v) => v.owner))].sort()).toEqual([
      "Coastal Car Service",
      "Greenacres center fleet",
      "Palm Lift Transport",
    ]);
    // And the table the fixture reads them from says the same three.
    expect(Object.values(PROVIDERS).map((pr) => pr.name).sort()).toEqual([
      "Coastal Car Service",
      "Greenacres center fleet",
      "Palm Lift Transport",
    ]);
  });
});
