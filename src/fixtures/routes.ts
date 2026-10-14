/**
 * Route fixtures for the M5 GPS simulator and ETA engine. **Simulated data only.**
 *
 * SOURCE: docs/adr/ADR-007-routing-fixtures.md (geometry *and* durations precomputed
 * once from the public OSRM demo server and committed; runtime never calls OSRM),
 * docs/MOCKS-AND-DEMO.md §1 / §5 (three routes, public landmarks, no homes),
 * docs/PRD-v1.0.txt §18.1 (synthetic dataset) and §8 (dwell / service time).
 *
 * Provenance, per leg:
 * - `OSRM_FIXTURE` — the committed OSRM demo response in
 *   docs/research/osrm-okeeheelee-to-center.json (`route1`: 2,739.8 m / 228.1 s,
 *   38 vertices; the probe recorded in docs/research/osrm-probe.txt). Its last vertex
 *   is OSRM's snap of the center onto Jog Road, 7.4 m from the geocode — that is the
 *   fixture, not a typo.
 * - `DERIVED` — **Unverified.** Hand-authored geometry that follows public roads
 *   (mostly S Jog Rd), with `distanceM` measured by `measurePath` and `durationSec`
 *   = distance ÷ 12.0114 m/s, the mean speed of the one committed OSRM response
 *   (2739.8 / 228.1). No traffic is baked in: the traffic model multiplies these.
 *   Replace these legs with real OSRM responses when the fixtures are regenerated.
 *
 * Nothing here touches the database. src/fixtures/map.ts stays the *static* map
 * fixture (the still-life preview); this module is the moving one.
 */

import type { Route, RouteLeg, RouteStop } from "@/domain/location/route";
import type { Coord } from "@/domain/location/geo";

/** PPEC center: 2216 Jog Rd, Greenacres FL 33415 (US Census geocode). */
export const CENTER_COORD: Coord = [-80.145541, 26.645352];

/** PRD §8 ASM-12: 8 min of service for a wheelchair stop. */
export const WHEELCHAIR_SERVICE_SECONDS = 480;

/** Mean speed of the committed OSRM response, m/s. Used only to derive `DERIVED` legs. */
export const PROBE_SPEED_MPS = 2739.8 / 228.1;

// ---------------------------------------------------------------------------
// Stops (MOCKS §1 landmarks only)
// ---------------------------------------------------------------------------

const CENTER_STOP: RouteStop = {
  id: "CENTER",
  name: "PPEC center",
  coord: CENTER_COORD,
  // No familyLabel: arriving at the center notifies no family.
  serviceSeconds: 0,
};

const S1_LIBRARY: RouteStop = {
  id: "S1",
  name: "Greenacres Branch Library",
  coord: [-80.145953, 26.622639],
  familyLabel: "F2",
  // F2/C2 is the wheelchair case and the AT-03 ETA-delay family (PRD §18.1).
  serviceSeconds: WHEELCHAIR_SERVICE_SECONDS,
};

const S2_OKEEHEELEE: RouteStop = {
  id: "S2",
  name: "Okeeheelee Park",
  coord: [-80.164767, 26.652165],
  familyLabel: "F5",
  serviceSeconds: 0,
};

const S3_CITY_HALL: RouteStop = {
  id: "S3",
  name: "Greenacres City Hall",
  coord: [-80.135511, 26.607061],
  familyLabel: "F1",
  serviceSeconds: 0,
};

const S4_JOHN_PRINCE: RouteStop = {
  id: "S4",
  name: "John Prince Park",
  coord: [-80.080532, 26.602482],
  familyLabel: "F8",
  serviceSeconds: 0,
};

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/** Okeeheelee Park → center, exactly as the committed OSRM demo response returned it. */
const G_OSRM_S2_TO_CENTER: Coord[] = [
  [-80.164767, 26.652165], [-80.164767, 26.652165], [-80.164764, 26.65201],
  [-80.164741, 26.651705], [-80.164738, 26.651205], [-80.164744, 26.651108],
  [-80.164743, 26.650952], [-80.164648, 26.650953], [-80.164547, 26.650957],
  [-80.164507, 26.650955], [-80.160783, 26.650973], [-80.15734, 26.651011],
  [-80.157207, 26.651013], [-80.157067, 26.651014], [-80.154295, 26.651035],
  [-80.153674, 26.65104], [-80.15129, 26.651061], [-80.151154, 26.651062],
  [-80.151013, 26.651064], [-80.150894, 26.651066], [-80.148186, 26.651108],
  [-80.148099, 26.651108], [-80.146302, 26.651112], [-80.146174, 26.651113],
  [-80.145634, 26.651114], [-80.14549, 26.651114], [-80.145492, 26.65097],
  [-80.145503, 26.650331], [-80.145504, 26.649645], [-80.145504, 26.649578],
  [-80.145543, 26.64809], [-80.145571, 26.647099], [-80.145621, 26.645354],
  [-80.145622, 26.645291], [-80.145627, 26.645182], [-80.145471, 26.64521],
  [-80.145467, 26.645345], [-80.145467, 26.64535],
];

/** Greenacres City Hall → west to Jog Rd → north to the library. */
const G_S3_TO_S1: Coord[] = [
  [-80.135511, 26.607061],
  [-80.1389, 26.60702],
  [-80.1428, 26.60697],
  [-80.14575, 26.60692],
  [-80.145725, 26.6105],
  [-80.1457, 26.6145],
  [-80.145685, 26.6185],
  [-80.14568, 26.6212],
  [-80.145953, 26.622639],
];

/** John Prince Park → north to Lake Worth Rd → west to Jog Rd → north to the library. */
const G_S4_TO_S1: Coord[] = [
  [-80.080532, 26.602482],
  [-80.0805, 26.6068],
  [-80.0892, 26.6162],
  [-80.11, 26.6168],
  [-80.13, 26.617],
  [-80.1457, 26.6172],
  [-80.14572, 26.6185],
  [-80.14568, 26.6212],
  [-80.145953, 26.622639],
];

/** Greenacres Branch Library → center, northbound on Jog Rd. */
const G_S1_TO_CENTER: Coord[] = [
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

// ---------------------------------------------------------------------------
// Legs. Numbers are committed, not computed at runtime (ADR-007).
// routes.test.ts re-measures every geometry and re-derives every DERIVED duration,
// so a hand edit to a polyline cannot silently drift from these values.
// ---------------------------------------------------------------------------

const LEG_S2_TO_CENTER: RouteLeg = {
  fromStopId: "S2",
  toStopId: "CENTER",
  geometry: G_OSRM_S2_TO_CENTER,
  distanceM: 2739.8,
  durationSec: 228.1,
  source: "OSRM_FIXTURE",
};

const LEG_S3_TO_S1: RouteLeg = {
  fromStopId: "S3",
  toStopId: "S1",
  geometry: G_S3_TO_S1,
  distanceM: 2768.3,
  durationSec: 230.5,
  source: "DERIVED",
};

const LEG_S4_TO_S1: RouteLeg = {
  fromStopId: "S4",
  toStopId: "S1",
  geometry: G_S4_TO_S1,
  distanceM: 8062,
  durationSec: 671.2,
  source: "DERIVED",
};

const LEG_S1_TO_CENTER: RouteLeg = {
  fromStopId: "S1",
  toStopId: "CENTER",
  geometry: G_S1_TO_CENTER,
  distanceM: 2535,
  durationSec: 211.1,
  source: "DERIVED",
};

// ---------------------------------------------------------------------------
// The three routes (PRD §18.1 "tracks/*.gpx|jsonl (3 routes)"). The demo script
// names route2 for the stall (PRD §18.2 step 7, `--track=route2`).
// ---------------------------------------------------------------------------

/** route1 — one leg, straight off the committed OSRM response. V3's run. */
export const ROUTE_1: Route = {
  id: "route1",
  vehicleId: "V3",
  deviceId: "DEV-V3",
  stops: [S2_OKEEHEELEE, CENTER_STOP],
  legs: [LEG_S2_TO_CENTER],
  sourceMode: "SIMULATED",
};

/**
 * route2 — the long eastern run: John Prince Park, then the library, then the center.
 * Two pickups then the center, so "downstream only" is provable — a delay on the first
 * leg moves F2's window at S1 and never F8's at S4, which has already been passed.
 * It is deliberately the *long* run: ASM-14 only notifies about a stop still ≥10 min
 * away, so the PRD §18.2 step 7 stall (`--track=route2`) needs more than 10 minutes of
 * driving left when it hits. V1's run.
 */
export const ROUTE_2: Route = {
  id: "route2",
  vehicleId: "V1",
  deviceId: "DEV-V1",
  stops: [S4_JOHN_PRINCE, S1_LIBRARY, CENTER_STOP],
  legs: [LEG_S4_TO_S1, LEG_S1_TO_CENTER],
  sourceMode: "SIMULATED",
};

/** route3 — City Hall, library, center; used for the GPS-gap fault (AT-11). V2's run. */
export const ROUTE_3: Route = {
  id: "route3",
  vehicleId: "V2",
  deviceId: "DEV-V2",
  stops: [S3_CITY_HALL, S1_LIBRARY, CENTER_STOP],
  legs: [LEG_S3_TO_S1, LEG_S1_TO_CENTER],
  sourceMode: "SIMULATED",
};

export const FIXTURE_ROUTES: Route[] = [ROUTE_1, ROUTE_2, ROUTE_3];

export function routeById(id: string): Route {
  const route = FIXTURE_ROUTES.find((r) => r.id === id);
  if (!route) throw new Error(`unknown fixture route: ${id}`);
  return route;
}
