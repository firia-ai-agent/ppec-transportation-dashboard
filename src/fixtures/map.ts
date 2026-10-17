/**
 * Map fixtures for the M5 fleet map pane. **Simulated data only.**
 *
 * SOURCE: docs/MOCKS-AND-DEMO.md §1 (geography: the center plus public landmarks,
 * never a home) and §2 (vehicles V1–V4); docs/PRD-v1.0.txt §18.1.
 *
 * Nothing here touches the database: these are literals, read by the client map and
 * by /live-map. Coordinates for the center and the landmark stops are the
 * MOCKS §1 values (US Census / Photon geocodes). The route polylines are
 * hand-authored approximations that follow public roads (mostly S Jog Rd, the
 * north–south road the center sits on); they are **not** survey data and not an OSRM
 * response. Real route geometry arrives as committed OSRM fixtures under ADR-007.
 *
 * Every record carries `sourceMode: "SIMULATED"` so the UI can show the §7.1
 * "Source: Simulated" badge (NFR-09).
 */

import type { Coord } from "@/components/map/style";
import { PROVIDERS } from "./fleet";

/** Only `SIMULATED` exists in P1 (MOCKS-AND-DEMO summary; ADR-015 synthetic-only). */
export type MapSourceMode = "SIMULATED";

export interface MapStopFixture {
  id: string;
  /** Public landmark name, shown as the on-map stop label (MOCKS §1). */
  name: string;
  coord: Coord;
  sourceMode: MapSourceMode;
}

/**
 * A stop as the vehicle list shows it: the *published* ETA window (damped by the
 * notify gate), never a raw minute-precision ETA (PRD §8, COPY-GUIDE l.36).
 */
export interface MapVehicleStop {
  stopId: string;
  name: string;
  /** Family code ("F2"); absent for the center drop, which notifies nobody. */
  familyLabel?: string;
  status: "arrived" | "passed" | "pending";
  windowText?: string;
}

export interface MapVehicleFixture {
  /** The fixture's key for the vehicle, "V1" … "V4" (MOCKS §2). Never a marker label. */
  id: string;
  /** Plain words for the vehicle. The marker label and the vehicle list are built from this. */
  description: string;
  /** Who runs it: one of the scenario's providers, or the center's own fleet. */
  owner: string;
  /** Leg state label from DESIGN-DIRECTION §3 (icon + label, never colour alone). */
  stateLabel: string;
  coord: Coord;
  /** Degrees clockwise from north; for the heading-aware marker polish in §5.1. */
  headingDeg: number;
  /** Seconds since the last simulated GPS point; drives tone + freshness label. */
  gpsAgeSeconds: number;
  routeId: string;
  sourceMode: MapSourceMode;
  /**
   * Live fields, set by the simulated runs on /live-map and absent from the static
   * fixture below. They are what turns the still-life into a moving fleet.
   */
  stops?: MapVehicleStop[];
  /** Seconds the vehicle has been reporting speed 0 (§5.1 "Stopped 3 min"). */
  stoppedSeconds?: number;
  /** LOC-03: GPS ≥180 s old, so ETA texts are paused for this vehicle. */
  etaTextSuppressed?: boolean;
  /** LOC-03: GPS ≥600 s old — a location-loss exception is open. */
  exceptionRaised?: boolean;
}

export interface MapRouteFixture {
  id: string;
  vehicleId: string;
  /** Planned geometry in travel order, `[lng, lat]`. */
  planned: Coord[];
  /** How much of `planned` has been driven, in points. */
  drivenCount: number;
  sourceMode: MapSourceMode;
}

export interface MapFixture {
  /** 2216 Jog Rd, Greenacres FL 33415 (MOCKS §1, US Census geocoder). */
  center: Coord;
  centerLabel: string;
  initialZoom: number;
  stops: MapStopFixture[];
  vehicles: MapVehicleFixture[];
  routes: MapRouteFixture[];
  sourceMode: MapSourceMode;
  /** Label for the §7.1 source badge. */
  sourceLabel: "Simulated";
}

/** PPEC center: 2216 Jog Rd, Greenacres FL 33415. */
export const DEMO_CENTER: Coord = [-80.145541, 26.645352];

/** Public landmark stops (MOCKS §1). No homes, no addresses. */
export const DEMO_STOPS: MapStopFixture[] = [
  { id: "S1", name: "Greenacres Branch Library", coord: [-80.145953, 26.622639], sourceMode: "SIMULATED" },
  { id: "S2", name: "Okeeheelee Park", coord: [-80.164767, 26.652165], sourceMode: "SIMULATED" },
  { id: "S3", name: "Greenacres City Hall", coord: [-80.135511, 26.607061], sourceMode: "SIMULATED" },
  { id: "S4", name: "John Prince Park", coord: [-80.080532, 26.602482], sourceMode: "SIMULATED" },
];

/** R1 — Greenacres Branch Library → center, northbound on Jog Rd. */
const R1_PLANNED: Coord[] = [
  [-80.145953, 26.622639],
  [-80.1457, 26.6229],
  [-80.14566, 26.6265],
  [-80.14562, 26.6302],
  [-80.1456, 26.6338],
  [-80.14558, 26.6374],
  [-80.14556, 26.641],
  [-80.145549, 26.6436],
  [-80.145541, 26.645352],
];

/** R2 — Greenacres City Hall → west to Jog Rd, then north to the center. */
const R2_PLANNED: Coord[] = [
  [-80.135511, 26.607061],
  [-80.1389, 26.607],
  [-80.1428, 26.60695],
  [-80.1458, 26.6069],
  [-80.14576, 26.612],
  [-80.1457, 26.618],
  [-80.14568, 26.6227],
  [-80.14564, 26.629],
  [-80.1456, 26.6355],
  [-80.14556, 26.6415],
  [-80.145541, 26.645352],
];

/** R3 — Okeeheelee Park → east on Forest Hill Blvd, then south on Jog Rd. */
const R3_PLANNED: Coord[] = [
  [-80.164767, 26.652165],
  [-80.16, 26.6519],
  [-80.154, 26.6518],
  [-80.148, 26.6517],
  [-80.1457, 26.65165],
  [-80.14562, 26.649],
  [-80.14557, 26.647],
  [-80.145541, 26.645352],
];

/** R4 — John Prince Park → west on Lake Worth Rd, then north on Jog Rd. */
const R4_PLANNED: Coord[] = [
  [-80.080532, 26.602482],
  [-80.09, 26.6168],
  [-80.11, 26.617],
  [-80.13, 26.6171],
  [-80.1457, 26.6172],
  [-80.14566, 26.624],
  [-80.14562, 26.632],
  [-80.14558, 26.639],
  [-80.145541, 26.645352],
];

export const DEMO_ROUTES: MapRouteFixture[] = [
  { id: "R1", vehicleId: "V1", planned: R1_PLANNED, drivenCount: 6, sourceMode: "SIMULATED" },
  { id: "R2", vehicleId: "V3", planned: R2_PLANNED, drivenCount: 5, sourceMode: "SIMULATED" },
  { id: "R3", vehicleId: "V2", planned: R3_PLANNED, drivenCount: 5, sourceMode: "SIMULATED" },
  { id: "R4", vehicleId: "V4", planned: R4_PLANNED, drivenCount: 3, sourceMode: "SIMULATED" },
];

/**
 * V1–V4 (MOCKS §2), each parked on the last driven point of its route. The GPS ages
 * walk the four §3 freshness bands so the map shows all three truck tones at once.
 */
export const DEMO_VEHICLES: MapVehicleFixture[] = [
  {
    id: "V1",
    description: "Convertible van",
    owner: PROVIDERS.P1.name,
    stateLabel: "On the way to pickup",
    coord: R1_PLANNED[5],
    headingDeg: 2,
    gpsAgeSeconds: 12,
    routeId: "R1",
    sourceMode: "SIMULATED",
  },
  {
    id: "V2",
    description: "Center van",
    owner: PROVIDERS.CENTER.name,
    stateLabel: "In transit",
    coord: R3_PLANNED[4],
    headingDeg: 178,
    gpsAgeSeconds: 95,
    routeId: "R3",
    sourceMode: "SIMULATED",
  },
  {
    id: "V3",
    description: "Substitute van",
    owner: PROVIDERS.P1.name,
    stateLabel: "In transit",
    coord: R2_PLANNED[4],
    headingDeg: 1,
    gpsAgeSeconds: 245,
    routeId: "R2",
    sourceMode: "SIMULATED",
  },
  {
    id: "V4",
    description: "Sedan",
    owner: PROVIDERS.P2.name,
    stateLabel: "On the way to pickup",
    coord: R4_PLANNED[2],
    headingDeg: 272,
    gpsAgeSeconds: 720,
    routeId: "R4",
    sourceMode: "SIMULATED",
  },
];

export const MAP_FIXTURE: MapFixture = {
  center: DEMO_CENTER,
  centerLabel: "PPEC center",
  initialZoom: 11.5,
  stops: DEMO_STOPS,
  vehicles: DEMO_VEHICLES,
  routes: DEMO_ROUTES,
  sourceMode: "SIMULATED",
  sourceLabel: "Simulated",
};
