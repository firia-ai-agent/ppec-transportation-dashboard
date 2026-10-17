/**
 * The geometry of the runs the standard scenario actually plans. **Simulated data only.**
 *
 * SOURCE: docs/MOCKS-AND-DEMO.md §1 / §5 (public landmarks, no homes), PRD §18.1 (the
 * synthetic dataset and its three runs), PRD §8 (dwell / service time),
 * docs/adr/ADR-007-routing-fixtures.md (geometry *and* durations committed; runtime never calls
 * OSRM), docs/ui/B12-SLICE1-DEFERRED.md §3.1–§3.2 (the gap this file closes).
 *
 * ## The one survey
 *
 * This is the whole of the demo's committed geometry. src/fixtures/routes.ts used to hold a
 * second, older set — three routes authored before the standard scenario, naming stops that in
 * the scenario belong to another run's children — and it now names three *tracks* over the routes
 * below rather than surveying its own (docs/ui/B12-SLICE1-DEFERRED.md §3.1). So the plan a
 * coordinator reads and the morning the simulator drives are one geometry, and the question
 * "which of the two is this row about" has stopped existing.
 *
 * This file is that geometry, taken from the scenario rather than from beside it: every stop,
 * every family label, every service time and the order of the stops are **read out of
 * src/modules/demo/fixtures/standard.ts**, so a route here cannot disagree with the run it is
 * for. Changing a child's stop or window in the scenario moves this route with it, and
 * run-routes.test.ts holds the two together stop by stop and window by window.
 *
 * The afternoon is the morning reversed (`reverseRoute`), which is what the scenario says a
 * run's afternoon is: everyone boards at the centre and is set down in the reverse of the pickup
 * order. One survey, two directions, and no way for them to drift.
 *
 * Every leg is `DERIVED` — hand-authored along public roads (mostly S Jog Rd, Lake Worth Rd,
 * Lantana Rd, Congress Ave and SR-7), `distanceM` measured by `measurePath` and `durationSec` =
 * distance ÷ `PROBE_SPEED_MPS`, the mean speed of the one committed OSRM response
 * (src/fixtures/survey.ts). Unverified, and replaceable by real OSRM responses when the fixtures
 * are regenerated at dev time — which is now the only way a survey-grade leg gets in here, since
 * the one probe that was run measures a road no run drives. What they are *not* is invented: the
 * test re-measures every polyline and re-derives every duration, and then checks that the arrival
 * each one implies is the arrival the scenario's own plan promises the family.
 *
 * Nothing here touches the database, the network or a clock.
 */

import { reverseRoute, type Route, type RouteLeg, type RouteStop } from "@/domain/location/route";
import type { Coord } from "@/domain/location/geo";
import { places } from "@/ui/copy";
import {
  CHILDREN,
  RUNS,
  stopByKey,
  type Run,
  type Child,
} from "@/modules/demo/fixtures/standard";
import { CENTER_COORD, PROBE_SPEED_MPS, WHEELCHAIR_SERVICE_SECONDS } from "./survey";

/** The stop id the committed routes give the centre, shared with src/fixtures/routes.ts. */
export const CENTER_STOP_ID = "CENTER";

/**
 * The centre as a route stop. Named, never addressed: the scenario's own label carries the
 * street and no screen may print one (COPY-GUIDE §7), so the name comes from the copy module.
 * No `familyLabel`, because no family is notified about a van reaching the centre.
 */
const CENTER_ROUTE_STOP: RouteStop = {
  id: CENTER_STOP_ID,
  name: places.center,
  coord: CENTER_COORD,
  serviceSeconds: 0,
};

/**
 * One of the scenario's landmark stops, as a route stop.
 *
 * The family label and the service time are read off the children who ride from there: PRD §8
 * ASM-12 gives a wheelchair stop 8 minutes of service and an ambulatory stop none, and the
 * notification decisions are made per family (ASM-14), so a stop two families shared would make
 * "which family does this window belong to" unanswerable. The scenario has none; this refuses
 * one rather than picking.
 */
function routeStopFor(stopKey: string): RouteStop {
  const stop = stopByKey(stopKey);
  const riders = CHILDREN.filter((c) => c.stopKey === stopKey);
  if (riders.length === 0) throw new Error(`run-routes: nobody rides from ${stopKey}`);
  const families = new Set(riders.map((c) => c.familyKey));
  if (families.size > 1) {
    throw new Error(`run-routes: ${stopKey} is shared by ${[...families].join(", ")}`);
  }
  return {
    id: stopKey,
    name: stop.label,
    coord: [stop.lng, stop.lat],
    familyLabel: riders[0].familyKey,
    serviceSeconds: riders.some((c) => c.mobility === "WC") ? WHEELCHAIR_SERVICE_SECONDS : 0,
  };
}

// ---------------------------------------------------------------------------
// Geometry. Travel order is the morning's: a child's own stop towards the centre.
// ---------------------------------------------------------------------------

/** Palm Beach State College → south on Congress Ave → east on Lantana Rd → Lantana library. */
const G_S5_TO_S6: Coord[] = [
  [-80.085865, 26.613772],
  [-80.0858, 26.6075],
  [-80.0855, 26.5925],
  [-80.0718, 26.5885],
  [-80.0565, 26.5862],
  [-80.052871, 26.584699],
];

/** Lantana library → west on Lantana Rd → south on Congress Ave → Boynton Beach Mall. */
const G_S6_TO_S7: Coord[] = [
  [-80.052871, 26.584699],
  [-80.0565, 26.5862],
  [-80.0718, 26.5885],
  [-80.0855, 26.5862],
  [-80.0912, 26.5725],
  [-80.0952, 26.5497],
  [-80.095675, 26.535418],
];

/** Boynton Beach Mall → west on Boynton Beach Blvd → north on S Jog Rd → the centre. */
const G_S7_TO_CENTER: Coord[] = [
  [-80.095675, 26.535418],
  [-80.0958, 26.5455],
  [-80.1255, 26.5465],
  [-80.1455, 26.5468],
  [-80.14565, 26.5905],
  [-80.14558, 26.6374],
  [-80.145541, 26.645352],
];

/** Okeeheelee Park → east on Forest Hill Blvd → south on S Jog Rd → Greenacres City Hall. */
const G_S2_TO_S3: Coord[] = [
  [-80.164767, 26.652165],
  [-80.1645, 26.651],
  [-80.1455, 26.6508],
  [-80.14568, 26.6212],
  [-80.1457, 26.6072],
  [-80.135511, 26.607061],
];

/** City Hall → west on Lake Worth Rd → north on SR-7 → Mall at Wellington Green. */
const G_S3_TO_S8: Coord[] = [
  [-80.135511, 26.607061],
  [-80.1455, 26.6072],
  [-80.1655, 26.6075],
  [-80.2055, 26.6078],
  [-80.2078, 26.6265],
  [-80.208099, 26.646683],
];

/** Wellington Green → east on Forest Hill Blvd → S Jog Rd → the centre. */
const G_S8_TO_CENTER: Coord[] = [
  [-80.208099, 26.646683],
  [-80.2078, 26.6508],
  [-80.1655, 26.6512],
  [-80.1455, 26.6508],
  [-80.145541, 26.645352],
];

/** Greenacres library → east on Lake Worth Rd → Congress Ave → John Prince Park. */
const G_S1_TO_S4: Coord[] = [
  [-80.145953, 26.622639],
  [-80.1457, 26.6172],
  [-80.13, 26.617],
  [-80.11, 26.6168],
  [-80.0892, 26.6162],
  [-80.0805, 26.6068],
  [-80.080532, 26.602482],
];

/** John Prince Park → west on Lake Worth Rd → north on S Jog Rd → the centre. */
const G_S4_TO_CENTER: Coord[] = [
  [-80.080532, 26.602482],
  [-80.0805, 26.6068],
  [-80.0892, 26.6162],
  [-80.11, 26.6168],
  [-80.13, 26.617],
  [-80.1457, 26.6172],
  [-80.14566, 26.6265],
  [-80.145541, 26.645352],
];

/**
 * The legs, committed rather than computed at runtime (ADR-007). run-routes.test.ts re-measures
 * every polyline and re-derives every duration from `PROBE_SPEED_MPS`, so a hand edit to a
 * geometry cannot drift from these numbers.
 */
const LEGS: RouteLeg[] = [
  leg("S5", "S6", G_S5_TO_S6, 5739, 477.8),
  leg("S6", "S7", G_S6_TO_S7, 9106.9, 758.2),
  leg("S7", CENTER_STOP_ID, G_S7_TO_CENTER, 17025.8, 1417.5),
  leg("S2", "S3", G_S2_TO_S3, 7881.9, 656.2),
  leg("S3", "S8", G_S3_TO_S8, 11295.1, 940.4),
  leg("S8", CENTER_STOP_ID, G_S8_TO_CENTER, 7256.7, 604.2),
  leg("S1", "S4", G_S1_TO_S4, 8060.2, 671),
  leg("S4", CENTER_STOP_ID, G_S4_TO_CENTER, 10585.3, 881.3),
];

function leg(
  fromStopId: string,
  toStopId: string,
  geometry: Coord[],
  distanceM: number,
  durationSec: number,
): RouteLeg {
  return { fromStopId, toStopId, geometry, distanceM, durationSec, source: "DERIVED" };
}

function legBetween(fromStopId: string, toStopId: string): RouteLeg {
  const found = LEGS.find((l) => l.fromStopId === fromStopId && l.toStopId === toStopId);
  if (!found) throw new Error(`run-routes: no committed leg ${fromStopId} → ${toStopId}`);
  return found;
}

// ---------------------------------------------------------------------------
// The runs, in the scenario's own order
// ---------------------------------------------------------------------------

/** The run's riders, earliest morning window first — the order `manifestFor` plans them in. */
function pickupOrder(run: Run): Child[] {
  return run.childKeys
    .map((key) => {
      const child = CHILDREN.find((c) => c.key === key);
      if (!child) throw new Error(`run-routes: unknown child ${key}`);
      return child;
    })
    .sort((a, b) => a.amWindow.localeCompare(b.amWindow));
}

/**
 * The morning route of one run: each rider's own stop in pickup order, then the centre.
 *
 * A rider with no stop of their own is refused rather than sent to the centre to be collected:
 * the census children arrive with their family and are on no run at all (standard.ts), so a run
 * that contained one would be a fixture mistake and not a route to draw.
 */
function morningRoute(run: Run): Route {
  const riders = pickupOrder(run);
  const stopKeys = riders.map((child) => {
    if (child.stopKey === null) {
      throw new Error(`run-routes: ${run.key} carries ${child.key}, who has no stop`);
    }
    return child.stopKey;
  });
  // Two children of one family share a stop (F4's siblings), and a run stops there once.
  const unique = [...new Set(stopKeys)];
  const stops = [...unique.map(routeStopFor), CENTER_ROUTE_STOP];
  const legs = stops.slice(0, -1).map((stop, i) => legBetween(stop.id, stops[i + 1].id));
  return {
    id: `${run.key.toLowerCase()}-am`,
    vehicleId: run.vehicleKey,
    deviceId: `DEV-${run.vehicleKey}`,
    stops,
    legs,
    sourceMode: "SIMULATED",
  };
}

export type Direction = "AM" | "PM";

/** Morning and afternoon geometry for every run the scenario plans, keyed "R1/PM". */
export const RUN_ROUTES: Readonly<Record<string, Route>> = Object.fromEntries(
  RUNS.flatMap((run) => {
    const am = morningRoute(run);
    return [
      [`${run.key}/AM`, am],
      [`${run.key}/PM`, reverseRoute(am, { id: `${run.key.toLowerCase()}-pm` })],
    ];
  }),
);

export function runRoute(runKey: string, direction: Direction): Route {
  const route = RUN_ROUTES[`${runKey}/${direction}`];
  if (!route) throw new Error(`run-routes: no ${direction} route for run ${runKey}`);
  return route;
}
