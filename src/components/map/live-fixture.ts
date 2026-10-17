/**
 * A live snapshot, in the shape the map pane draws (DESIGN-DIRECTION §5, §5.1).
 *
 * Pure, and deliberately separate from the component: "which vans are on the map, where their
 * driven line ends, which stops are drawn" is answerable without a browser, and the pane is
 * then only MapLibre. The same conversion serves the board's pane and anything else that holds
 * a snapshot.
 *
 * Two rules it keeps, both from the domain rather than from taste:
 *  - a van with no displayable position is **absent**, not faint: an unlinked device has no
 *    position anybody may draw (LOC-01, ADR-013), and the snapshot already keeps those vans in
 *    its own `silent` list, which the pane names in words underneath;
 *  - the driven line ends exactly where the marker is, measured along the planned geometry, so
 *    the solid line never lags a vertex behind the truck (§5.1).
 */

import type { LiveSnapshot } from "@/domain/board/live";
import { measurePath, pathUpTo } from "@/domain/location/geo";
import {
  DEMO_CENTER,
  type MapFixture,
  type MapRouteFixture,
  type MapStopFixture,
  type MapVehicleFixture,
  type MapVehicleMarker,
} from "@/fixtures/map";
import { places, sourceMode } from "@/ui/copy";
import { vanMarkerStateOf, vanMarkerWords } from "@/ui/van-state";

/** The whole fleet is a few miles across; 11 shows the centre and every landmark at once. */
export const BOARD_MAP_ZOOM = 11;

/** Stops as circles with labels. The centre has its own pin layer, so it is not one of them. */
function stopsOf(snapshot: LiveSnapshot): MapStopFixture[] {
  const byId = new Map<string, MapStopFixture>();
  for (const vehicle of snapshot.vehicles) {
    for (const stop of vehicle.stops) {
      if (stop.stopId === CENTER_STOP_ID || byId.has(stop.stopId)) continue;
      byId.set(stop.stopId, {
        id: stop.stopId,
        name: stop.name,
        coord: stop.coord,
        sourceMode: "SIMULATED",
      });
    }
  }
  return [...byId.values()];
}

/** The committed routes give the centre this id; it is drawn as the centre pin instead. */
const CENTER_STOP_ID = "CENTER";

/** Planned line per run, plus the driven prefix that ends under the marker (§5.1). */
function routesOf(snapshot: LiveSnapshot): MapRouteFixture[] {
  const out: MapRouteFixture[] = [];
  for (const route of snapshot.routes) {
    out.push({
      id: `${route.id}-planned`,
      vehicleId: route.vehicleId,
      planned: route.planned,
      drivenCount: 0,
      sourceMode: "SIMULATED",
    });
    const vehicle = snapshot.vehicles.find((v) => v.id === route.vehicleId);
    if (!vehicle) continue;
    const driven = pathUpTo(measurePath(route.planned), vehicle.drivenM);
    if (driven.length < 2) continue;
    out.push({
      id: `${route.id}-driven`,
      vehicleId: route.vehicleId,
      planned: driven,
      drivenCount: driven.length,
      sourceMode: "SIMULATED",
    });
  }
  return out;
}

/**
 * What this van's marker says (Vera's bar), from the tick's own facts: the freshness band, the
 * stall, how late the rides on it are, and when it was last seen.
 *
 * Every one of those is on the snapshot, decided by src/domain/board at the tick — this only
 * chooses which of them the marker leads with (src/ui/van-state.ts).
 */
function markerOf(vehicle: LiveSnapshot["vehicles"][number]): MapVehicleMarker {
  const motion = {
    band: vehicle.band,
    gpsAgeSeconds: vehicle.gpsAgeSeconds,
    stoppedSeconds: vehicle.stoppedSeconds,
    lateSeconds: vehicle.lateSeconds,
    lastFixMs: vehicle.lastFixMs,
  };
  return { state: vanMarkerStateOf(motion), label: vanMarkerWords(motion) };
}

function vehiclesOf(snapshot: LiveSnapshot): MapVehicleFixture[] {
  return snapshot.vehicles.map((vehicle) => ({
    id: vehicle.id,
    marker: markerOf(vehicle),
    description: vehicle.description,
    owner: vehicle.owner,
    stateLabel: vehicle.stateLabel,
    coord: vehicle.coord,
    headingDeg: vehicle.headingDeg,
    gpsAgeSeconds: vehicle.gpsAgeSeconds,
    routeId: vehicle.routeId,
    sourceMode: "SIMULATED",
    stops: vehicle.stops.map((stop) => ({
      stopId: stop.stopId,
      name: stop.name,
      familyLabel: stop.familyLabel,
      status: stop.status,
      windowText: stop.windowText,
    })),
    stoppedSeconds: vehicle.stoppedSeconds,
    etaTextSuppressed: vehicle.etaTextSuppressed,
    exceptionRaised: vehicle.exceptionRaised,
  }));
}

/** The snapshot as a map fixture. NFR-09: every record says where its data came from. */
export function mapFixtureFrom(snapshot: LiveSnapshot): MapFixture {
  return {
    center: DEMO_CENTER,
    centerLabel: places.center,
    initialZoom: BOARD_MAP_ZOOM,
    stops: stopsOf(snapshot),
    vehicles: vehiclesOf(snapshot),
    routes: routesOf(snapshot),
    sourceMode: "SIMULATED",
    sourceLabel: sourceMode.SIMULATED,
  };
}
