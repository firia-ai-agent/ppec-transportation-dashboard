/**
 * Route model for the M5 location/ETA engine — the shape ADR-007 fixtures take.
 *
 * SOURCE: docs/adr/ADR-007-routing-fixtures.md (geometry **and** durations are
 * precomputed once from the public OSRM demo server and committed; runtime never calls
 * OSRM), PRD §8 (per-stop dwell and service time), MOCKS-AND-DEMO §5.
 *
 * Types live here, data lives in src/fixtures/routes.ts: the domain never imports
 * fixtures. Pure — no clock, no network, no database.
 */

import { measurePath, type Coord, type MeasuredPath } from "./geo";

/**
 * PRD §8 ASM-12: 3 min of dwell per stop, on top of the child's service time. The
 * simulator holds the vehicle for `DWELL_SECONDS + stop.serviceSeconds` at each stop
 * and the ETA engine adds exactly the same amount, so simulated truth and predicted
 * ETA are the same model.
 */
export const DWELL_SECONDS = 180;

/** Dwell + service time the vehicle spends at a stop, in seconds. */
export function stopHoldSeconds(stop: RouteStop): number {
  return DWELL_SECONDS + stop.serviceSeconds;
}

/** A stop on a route. The first stop is where the run starts. */
export interface RouteStop {
  id: string;
  /** Public landmark name (MOCKS §1) or "PPEC center". Never a home address. */
  name: string;
  coord: Coord;
  /**
   * Family label ("F2") for notification *decisions*. The center drop has none: no
   * family is notified about the vehicle reaching the center.
   */
  familyLabel?: string;
  /**
   * Service time for this stop's child, in seconds (PRD §8 ASM-12: 8 min for a
   * wheelchair, 0 for an ambulatory child). Dwell is a separate per-stop constant.
   */
  serviceSeconds: number;
  /**
   * Earliest this stop may be served, as seconds from the run start; produces the
   * `hold_i = max(0, window_start_i − arrival_i)` term in the §8 formula. Unset in the
   * P1 fixtures (no pickup windows in the synthetic dataset).
   */
  windowStartOffsetSeconds?: number;
}

/** Where a leg's numbers came from. Only `OSRM_FIXTURE` is survey-grade. */
export type LegSource = "OSRM_FIXTURE" | "DERIVED";

export interface RouteLeg {
  fromStopId: string;
  toStopId: string;
  /** Geometry in travel order, from the origin stop to the destination stop. */
  geometry: Coord[];
  /** Committed distance, metres (ADR-007). Informational: progress uses the geometry. */
  distanceM: number;
  /** Committed free-flow duration, seconds (ADR-007). Traffic multiplies this. */
  durationSec: number;
  source: LegSource;
}

export interface Route {
  id: string;
  /** Vehicle label (MOCKS §2): "V1"…"V4". */
  vehicleId: string;
  /** Device feeding LocationIngest for this vehicle (ADR-013). */
  deviceId: string;
  stops: RouteStop[];
  legs: RouteLeg[];
  /** P1 is synthetic only (ADR-015); NFR-09 badge reads "Simulated". */
  sourceMode: "SIMULATED";
}

/** One leg placed on the whole-route chainage and free-flow timeline. */
export interface MeasuredLeg {
  leg: RouteLeg;
  /** Chainage of the leg's first vertex, metres from the route start. */
  startM: number;
  /** Chainage of the leg's last vertex. */
  endM: number;
  /** Measured geometry length (may differ from `leg.distanceM` by a metre or two). */
  geometryM: number;
}

export interface MeasuredRoute {
  route: Route;
  /** Every leg's geometry concatenated, with the shared vertex not repeated. */
  path: MeasuredPath;
  legs: MeasuredLeg[];
  /** Chainage of each stop, metres from the route start; same order as `route.stops`. */
  stopDistanceM: number[];
  /** Σ free-flow leg durations, seconds — driving time only, no dwell or service. */
  freeFlowSec: number;
}

/** Concatenate leg geometries, dropping the vertex each leg shares with the previous. */
export function routeGeometry(route: Route): Coord[] {
  const coords: Coord[] = [];
  for (const leg of route.legs) {
    const start = coords.length === 0 ? 0 : 1;
    for (let i = start; i < leg.geometry.length; i += 1) coords.push(leg.geometry[i]);
  }
  return coords;
}

/**
 * Measure a route once: chainage for the whole path, per-leg spans and per-stop
 * chainage. Everything downstream (simulator, ETA, map tween) works off this.
 */
export function measureRoute(route: Route): MeasuredRoute {
  if (route.legs.length === 0) throw new Error(`measureRoute: ${route.id} has no legs`);
  const path = measurePath(routeGeometry(route));

  const legs: MeasuredLeg[] = [];
  let cursorVertex = 0;
  for (const leg of route.legs) {
    const startM = path.cumulativeM[cursorVertex];
    cursorVertex += leg.geometry.length - 1;
    const endM = path.cumulativeM[cursorVertex];
    legs.push({ leg, startM, endM, geometryM: endM - startM });
  }

  const stopDistanceM = route.stops.map((_, i) => (i === 0 ? 0 : legs[i - 1].endM));
  const freeFlowSec = route.legs.reduce((sum, l) => sum + l.durationSec, 0);
  return { route, path, legs, stopDistanceM, freeFlowSec };
}

/** The leg containing this chainage (the last leg once the route is finished). */
export function legAtDistance(measured: MeasuredRoute, alongM: number): MeasuredLeg {
  for (const leg of measured.legs) {
    if (alongM <= leg.endM) return leg;
  }
  return measured.legs[measured.legs.length - 1];
}

/**
 * Index of the next stop at this chainage: the first stop whose chainage is ahead of
 * the vehicle. `route.stops.length` once every stop has been passed.
 */
export function nextStopIndex(measured: MeasuredRoute, alongM: number): number {
  for (let i = 0; i < measured.stopDistanceM.length; i += 1) {
    if (measured.stopDistanceM[i] > alongM + 1e-6) return i;
  }
  return measured.stopDistanceM.length;
}

/**
 * Free-flow seconds still to drive from this chainage to the given stop, from the
 * committed per-leg durations only (ADR-007): within the current leg the remaining
 * share is distance-proportional, later legs count in full. Traffic is applied by the
 * ETA engine, never here.
 */
export function freeFlowSecondsBetween(
  measured: MeasuredRoute,
  alongM: number,
  stopIndex: number,
): number {
  const targetM = measured.stopDistanceM[stopIndex];
  if (targetM === undefined) throw new Error(`freeFlowSecondsBetween: no stop ${stopIndex}`);
  if (targetM <= alongM) return 0;

  let seconds = 0;
  for (const measuredLeg of measured.legs) {
    if (measuredLeg.endM <= alongM) continue;
    if (measuredLeg.startM >= targetM) break;
    const from = Math.max(alongM, measuredLeg.startM);
    const to = Math.min(targetM, measuredLeg.endM);
    const share = measuredLeg.geometryM === 0 ? 0 : (to - from) / measuredLeg.geometryM;
    seconds += measuredLeg.leg.durationSec * share;
  }
  return seconds;
}
