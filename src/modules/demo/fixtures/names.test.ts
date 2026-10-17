/**
 * One scenario, one set of names (MOCKS-AND-DEMO §1–§2, COPY-GUIDE §3).
 *
 * The Today board, the ramp check and the map preview are walked in one sitting, and until the
 * names moved into ./names.ts each of them carried its own list: the board's "Noah O." was the
 * ramp's "Noah B.", and the board's "V1 · SYN Palm Lift Transport" was the map's "V1 · Provider
 * P1". A reviewer could not tell whether they were looking at one day or three.
 *
 * So this test reads each preview's own fixture — the ones the screens actually render — and
 * holds every name in them against the board's own projection of the scenario
 * (src/domain/board/scenario.ts). It is the names only: what a van can carry and what a chair
 * measures belong to the fixtures that own them, and src/fixtures/fleet.test.ts and
 * src/domain/solver/solver.test.ts hold those.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { solverChild, solverVehicle } from "@/domain/board/scenario";
import { ARRIVING_VEHICLES, CHILDREN as RAMP_RIDERS, FLEET } from "@/fixtures/fleet";
import { DEMO_STOPS, DEMO_VEHICLES } from "@/fixtures/map";
import { CHILDREN, STOPS, VEHICLES, childByKey } from "./standard";
import { childName, vanName } from "./names";

const SRC = path.resolve(__dirname, "..", "..", "..");

/** What the board calls this child, computed the way the board computes it. */
function boardChildName(token: string): string {
  return solverChild(childByKey(token)).displayName;
}

/** What the board calls this van, computed the way the board computes it. */
function boardVan(key: string) {
  const vehicle = VEHICLES.find((v) => v.key === key);
  if (!vehicle) throw new Error(`unknown vehicle ${key}`);
  const { label, description, providerName } = solverVehicle(vehicle);
  return { label, description, providerName };
}

describe("the names come from the scenario, not from a surface", () => {
  it("names a child the way the scenario does", () => {
    expect(childName("C2")).toBe("Noah O.");
    expect(childName("C6")).toBe("Zoe B.");
    for (const child of CHILDREN) expect(childName(child.key)).toBe(child.label);
  });

  it("splits a van's one fixture string into the pieces a screen shows", () => {
    expect(vanName("V1")).toEqual({
      label: "V1",
      description: "convertible van",
      providerId: "P1",
      providerName: "SYN Palm Lift Transport",
    });
  });

  it("refuses a key the scenario does not have, rather than inventing a name", () => {
    expect(() => childName("C999")).toThrow();
    expect(() => vanName("V9")).toThrow();
  });
});

describe("the ramp check (SURF-04) names what the Today board names", () => {
  it("gives every rider the board's name for that child", () => {
    expect(RAMP_RIDERS.length).toBeGreaterThan(4);
    for (const rider of RAMP_RIDERS) {
      expect(rider.displayName, rider.token).toBe(boardChildName(rider.token));
    }
  });

  it("names the riders on every arriving van the same way, tile by tile", () => {
    expect(ARRIVING_VEHICLES.length).toBeGreaterThan(0);
    for (const arrival of ARRIVING_VEHICLES) {
      for (const child of arrival.leg.children) {
        expect(child.displayName, `${arrival.vehicle.id}/${child.token}`).toBe(
          boardChildName(child.token),
        );
      }
    }
  });

  it("gives every van the board's label, words and provider", () => {
    for (const vehicle of FLEET) {
      const { label, description, providerName } = vehicle;
      expect({ label, description, providerName }, vehicle.id).toEqual(boardVan(vehicle.id));
    }
  });

  it("puts the same vans on the arrival tiles", () => {
    for (const arrival of ARRIVING_VEHICLES) {
      expect(arrival.vehicle.label, arrival.vehicle.id).toBe(boardVan(arrival.vehicle.id).label);
      expect(arrival.vehicle.providerName, arrival.vehicle.id).toBe(
        boardVan(arrival.vehicle.id).providerName,
      );
    }
  });
});

describe("the live map preview names what the Today board names", () => {
  it("gives every van the board's words and owner", () => {
    expect(DEMO_VEHICLES.length).toBeGreaterThan(0);
    for (const vehicle of DEMO_VEHICLES) {
      const board = boardVan(vehicle.id);
      expect(vehicle.description, vehicle.id).toBe(board.description);
      expect(vehicle.owner, vehicle.id).toBe(board.providerName);
    }
  });

  it("names its stops the way the scenario names them", () => {
    const labels = new Set(STOPS.map((s) => s.label));
    for (const stop of DEMO_STOPS) {
      expect(labels.has(stop.name), stop.name).toBe(true);
      expect(stop.name).toBe(STOPS.find((s) => s.key === stop.id)?.label);
    }
  });

  it("reads the moving fleet's names off that same list, not a second one", () => {
    // The live preview builds its markers from the replay frames and takes the van's words from
    // `DEMO_VEHICLES` (`VEHICLE_META`). A list of its own here is how the two surfaces drifted
    // the first time, so the screen is held to reading this one.
    const live = readFileSync(path.join(SRC, "components", "map", "LiveFleetMap.tsx"), "utf8");
    expect(live).toMatch(/VEHICLE_META = new Map\(DEMO_VEHICLES\.map/);
    expect(live).toMatch(/description: meta\?\.description/);
    expect(live).toMatch(/owner: meta\?\.owner/);
  });
});

describe("neither preview fixture may hold a name of its own", () => {
  const fleet = readFileSync(path.join(SRC, "fixtures", "fleet.ts"), "utf8");
  const map = readFileSync(path.join(SRC, "fixtures", "map.ts"), "utf8");

  it("spells no rider's name out at the ramp", () => {
    expect(fleet).not.toMatch(/displayName: "/);
    expect(fleet).toMatch(/from "@\/modules\/demo\/fixtures\/names"/);
  });

  it("spells no van's name out on either preview", () => {
    for (const [file, source] of [["fleet.ts", fleet], ["map.ts", map]] as const) {
      expect(source, file).not.toMatch(/^\s*description: "/m);
      expect(source, file).not.toMatch(/^\s*(?:owner|providerName): "/m);
    }
    expect(map).toMatch(/from "@\/modules\/demo\/fixtures\/names"/);
  });
});
