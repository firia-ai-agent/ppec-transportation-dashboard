/**
 * Geofence → ARRIVED_* **only** (AT-10).
 *
 * SOURCE: PRD §4.4 l.265–266 and l.420–421 ("Vehicle at geofence → ARRIVED_*, never
 * COMPLETED_HANDOFF"; "geofence never completes handoff"), ASM-18 (100 m and speed
 * <2 m/s for ≥20 s), §6.3 l.750 (COMPLETED_HANDOFF needs a custody event naming a
 * receiving adult with `can_receive_child`), SURF-01 acceptance l.1058 ("geofence
 * shows 'Arrived (vehicle)' never 'Handed off'").
 *
 * This module's return type makes the acceptance test structural rather than a matter
 * of discipline: {@link GeofenceArrival.state} is `"ARRIVED_PICKUP" | "ARRIVED_DROPOFF"`,
 * so there is no value this module can produce that means handoff. Pure, no clock.
 */

import { arrival } from "@/ui/copy";
import { distanceM } from "./geo";
import type { RouteStop } from "./route";
import type { StoredPoint } from "./ingest";

/** ASM-18: inside 100 m of the stop. */
export const GEOFENCE_RADIUS_M = 100;
/** ASM-18: moving slower than 2 m/s. */
export const GEOFENCE_MAX_SPEED_MPS = 2;
/** ASM-18: both conditions held for at least 20 s. */
export const GEOFENCE_DWELL_SECONDS = 20;

/**
 * The only two states a geofence may set. `COMPLETED_HANDOFF` is deliberately absent
 * and is not reachable from this module (AT-10).
 */
export type ArrivalState = "ARRIVED_PICKUP" | "ARRIVED_DROPOFF";

export interface GeofenceArrival {
  stopId: string;
  state: ArrivalState;
  /** Clock instant the 20 s condition completed, epoch ms. */
  atMs: number;
  /** Distance from the stop when the condition completed, metres. */
  distanceM: number;
}

/**
 * Why this is never a handoff. Surfaced in the UI next to an arrival so the demo
 * cannot be misread (SURF-01 l.1058 wording). The sentence itself lives in
 * src/ui/copy.ts with the rest of the rendered words; the rule lives here.
 */
export const ARRIVAL_IS_NOT_HANDOFF = arrival.notHandoff;

/** Per-stop candidate progress, carried across points. */
export interface GeofenceState {
  /** Stop id → clock instant the current in-geofence, slow-enough streak began. */
  candidateSinceMs: Readonly<Record<string, number>>;
  /** Stop ids already arrived; an arrival fires once per stop. */
  arrived: readonly string[];
}

export function emptyGeofenceState(): GeofenceState {
  return { candidateSinceMs: {}, arrived: [] };
}

/**
 * `ARRIVED_DROPOFF` at the last stop of the run (the center), `ARRIVED_PICKUP`
 * everywhere else — matching the leg machine's pickup-then-dropoff order (PRD §6.3).
 */
export function arrivalStateFor(stopIndex: number, stopCount: number): ArrivalState {
  return stopIndex === stopCount - 1 ? "ARRIVED_DROPOFF" : "ARRIVED_PICKUP";
}

/**
 * Feed one accepted position. Returns the arrival it completed, if any.
 *
 * Only *accepted, bound* points should reach this function: an unbound device may not
 * move a leg's state any more than it may appear on the map (LOC-01).
 */
export function geofenceStep(
  state: GeofenceState,
  stops: readonly RouteStop[],
  point: StoredPoint,
): { state: GeofenceState; arrival?: GeofenceArrival } {
  const candidateSinceMs = { ...state.candidateSinceMs };
  let arrival: GeofenceArrival | undefined;
  const arrived = [...state.arrived];

  for (let i = 0; i < stops.length; i += 1) {
    const stop = stops[i];
    if (arrived.includes(stop.id)) continue;

    const d = distanceM([point.lon, point.lat], stop.coord);
    const inside = d <= GEOFENCE_RADIUS_M && point.speedMps < GEOFENCE_MAX_SPEED_MPS;

    if (!inside) {
      delete candidateSinceMs[stop.id];
      continue;
    }

    const since = candidateSinceMs[stop.id] ?? point.recordedAtMs;
    candidateSinceMs[stop.id] = since;
    const heldSeconds = (point.recordedAtMs - since) / 1000;
    if (heldSeconds >= GEOFENCE_DWELL_SECONDS && !arrival) {
      arrival = {
        stopId: stop.id,
        state: arrivalStateFor(i, stops.length),
        atMs: point.recordedAtMs,
        distanceM: d,
      };
      arrived.push(stop.id);
      delete candidateSinceMs[stop.id];
    }
  }

  return { state: { candidateSinceMs, arrived }, arrival };
}
