/**
 * Who sees what on /map-preview.
 *
 * The matrix is written out in full below rather than derived, so changing a cell in
 * src/domain/access/map-view.ts has to be a deliberate edit here too — a privilege ladder
 * that computes its own expectations tests nothing.
 */
import { describe, expect, it } from "vitest";
import type { StaffRole } from "@/auth/core";
import {
  canOpenMapPreview,
  canSeeMapData,
  demoSessionRole,
  MAP_DATA_BY_ROLE,
  MAP_DATA_KEYS,
  mapViewerFor,
  type MapDataKey,
  type MapViewer,
} from "./map-view";

/** The whole table, as a reader of the page should expect to find it. */
const EXPECTED: Record<MapViewer, Record<MapDataKey, boolean>> = {
  ANONYMOUS: {
    map: false,
    vehiclePositions: false,
    stopWindows: false,
    familyLabels: false,
    notificationDecisions: false,
    injectedFaults: false,
    clockControls: false,
  },
  FRONT_DESK: {
    map: true,
    vehiclePositions: true,
    stopWindows: true,
    familyLabels: false,
    notificationDecisions: false,
    injectedFaults: false,
    clockControls: false,
  },
  COORDINATOR: {
    map: true,
    vehiclePositions: true,
    stopWindows: true,
    familyLabels: true,
    notificationDecisions: true,
    injectedFaults: false,
    clockControls: false,
  },
  DIRECTOR: {
    map: true,
    vehiclePositions: true,
    stopWindows: true,
    familyLabels: true,
    notificationDecisions: true,
    injectedFaults: true,
    clockControls: true,
  },
};

const VIEWERS = Object.keys(EXPECTED) as MapViewer[];

describe("role × map data", () => {
  it("covers every role and every kind of data, with nothing left over", () => {
    expect(Object.keys(MAP_DATA_BY_ROLE).sort()).toEqual([...VIEWERS].sort());
    expect([...MAP_DATA_KEYS].sort()).toEqual(Object.keys(EXPECTED.DIRECTOR).sort());
  });

  it.each(VIEWERS)("%s sees exactly the cells the matrix says", (viewer) => {
    const actual = Object.fromEntries(
      MAP_DATA_KEYS.map((key) => [key, canSeeMapData(viewer, key)]),
    );
    expect(actual).toEqual(EXPECTED[viewer]);
  });

  it("shows nobody a key that is not in their row", () => {
    for (const viewer of VIEWERS) {
      for (const key of MAP_DATA_BY_ROLE[viewer]) expect(EXPECTED[viewer][key]).toBe(true);
    }
  });

  it("gives an anonymous visitor nothing, so the sign-in guard is not decorative", () => {
    expect(MAP_DATA_BY_ROLE.ANONYMOUS).toEqual([]);
    expect(canOpenMapPreview("ANONYMOUS")).toBe(false);
    for (const key of MAP_DATA_KEYS) expect(canSeeMapData("ANONYMOUS", key)).toBe(false);
  });

  it("lets all three staff roles open the page", () => {
    for (const role of ["DIRECTOR", "COORDINATOR", "FRONT_DESK"] as const) {
      expect(canOpenMapPreview(role)).toBe(true);
    }
  });

  it("keeps the family list and the notification queue off the door iPad", () => {
    // FRONT_DESK handles arrivals and handoffs; it has no business holding either.
    expect(canSeeMapData("FRONT_DESK", "familyLabels")).toBe(false);
    expect(canSeeMapData("FRONT_DESK", "notificationDecisions")).toBe(false);
  });

  it("keeps the demo controls to the one role that holds them", () => {
    for (const key of ["clockControls", "injectedFaults"] as const) {
      expect(canSeeMapData("DIRECTOR", key)).toBe(true);
      expect(canSeeMapData("COORDINATOR", key)).toBe(false);
      expect(canSeeMapData("FRONT_DESK", key)).toBe(false);
    }
  });
});

describe("mapViewerFor", () => {
  it("takes the most capable role a person holds across their sites", () => {
    expect(mapViewerFor(["FRONT_DESK", "DIRECTOR"])).toBe("DIRECTOR");
    expect(mapViewerFor(["FRONT_DESK", "COORDINATOR"])).toBe("COORDINATOR");
    expect(mapViewerFor(["FRONT_DESK"])).toBe("FRONT_DESK");
  });

  it("is ANONYMOUS for an active user with no membership anywhere", () => {
    expect(mapViewerFor([])).toBe("ANONYMOUS");
    expect(canOpenMapPreview(mapViewerFor([]))).toBe(false);
  });
});

describe("the browser-test session grants a role and nothing else", () => {
  const on = { APP_DATA_CLASS: "SYNTHETIC", DEMO_MODE: "1", E2E_DEMO_ROLE: "DIRECTOR" };

  it("needs all four gates", () => {
    expect(demoSessionRole(on)).toBe("DIRECTOR");
    expect(demoSessionRole({ ...on, E2E_DEMO_ROLE: undefined })).toBeNull();
    expect(demoSessionRole({ ...on, DEMO_MODE: "0" })).toBeNull();
    expect(demoSessionRole({ ...on, APP_DATA_CLASS: "REAL" })).toBeNull();
    expect(demoSessionRole({})).toBeNull();
  });

  it("is unreachable on anything Vercel runs, preview and production alike", () => {
    // This is the gate that matters: `VERCEL_ENV` is always set by the platform, so no
    // deployment of ours can be opened with a role and no credentials.
    for (const vercelEnv of ["preview", "production", "development", ""]) {
      expect({ vercelEnv, role: demoSessionRole({ ...on, VERCEL_ENV: vercelEnv }) }).toEqual({
        vercelEnv,
        role: null,
      });
    }
  });

  it("accepts only the three real roles, never an invented one", () => {
    for (const role of ["DIRECTOR", "COORDINATOR", "FRONT_DESK"] satisfies StaffRole[]) {
      expect(demoSessionRole({ ...on, E2E_DEMO_ROLE: role })).toBe(role);
    }
    for (const role of ["ADMIN", "director", "ANONYMOUS", "", "1"]) {
      expect(demoSessionRole({ ...on, E2E_DEMO_ROLE: role })).toBeNull();
    }
  });
});
