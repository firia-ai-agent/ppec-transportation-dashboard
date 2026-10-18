/**
 * The four M5 demo runs. **Simulated data only.**
 *
 * SOURCE: PRD §18.2 steps 7–8 (replayed stall → one damped window to downstream
 * families; injected GPS gap → 180 s STALE, 600 s exception), AT-03, AT-10, AT-11,
 * LOC-01/02/03, MOCKS-AND-DEMO §5 (fault buttons) and §6.2 (the scenario clock).
 *
 * Each run is a {@link ReplaySpec}: a committed fixture route, a seed and a fault list.
 * `runReplay` turns one into a whole deterministic run, so the live map and the
 * tests watch exactly the same trucks. Nothing here is sent anywhere and nothing is
 * written to a database.
 */

import type { ReplaySpec } from "@/domain/eta/replay";
import type { Route } from "@/domain/location/route";
import { ROUTE_1, ROUTE_2, ROUTE_3 } from "./routes";

/**
 * Scenario-clock start: 2026-10-14 07:30 ET, inside the morning peak band so the whole
 * run shares one traffic multiplier. Fixed rather than "today", because a replay that
 * moves with the wall clock is not a replay (PRD §8: clock acceleration applies to the
 * scenario clock only, never to carrier timestamps).
 */
export const SCENARIO_START_MS = Date.UTC(2026, 9, 14, 11, 30, 0);

/**
 * The road a device drives when it is linked to no van at all (LOC-01).
 *
 * The centre runs three vans and holds none of them back (Firia's 8:02 PM ET seed ruling), so
 * there is no reserve for a fourth run to belong to. What there still is — and what LOC-01 is
 * about — is a device sending points that no van owns: ingested, stored `bound=false`, drawn
 * nowhere. It is R3's own road under a device that is linked to nothing, so the geometry is a
 * committed one and the thing being demonstrated is the *link*, not the route.
 *
 * `vehicleId` is deliberately not one of the fleet's three: a van that owned these points would
 * be a van with two devices, which is the one thing ADR-013 says cannot happen.
 */
export const UNLINKED_VEHICLE = "UNLINKED";

export const UNBOUND_ROUTE: Route = {
  ...ROUTE_1,
  id: "route1-unbound",
  vehicleId: UNLINKED_VEHICLE,
  deviceId: "DEV-UNLINKED",
};

/**
 * Van 3's road in the replay set: route2's geometry — R1's morning — under Van 3's own device.
 *
 * A fourth *route* rather than a fourth run, so the geometry cannot drift from the committed
 * one, and route2's is the road the AT-03 jitter check was measured on (its stop spacing is what
 * makes "the marker moves and the ETA text does not" a real claim). Van 3 is a van like the
 * other two now — there is no reserve and no substitute (Firia's 8:02 PM ET seed ruling) — so
 * what this fixture is, is the third truck on the live map.
 */
export const VAN3_ROUTE: Route = {
  ...ROUTE_2,
  id: "route2-van3",
  vehicleId: "V3",
  deviceId: "DEV-V3",
};

/** PRD §18.2 step 7: the replayed stall on route2 (`--track=route2`). */
export const RUN_STALL: ReplaySpec = {
  route: ROUTE_2,
  startAtMs: SCENARIO_START_MS,
  seed: 7,
  // PRD's own demo invocation is `delay:720s@00:09`; the stall lands at 00:02 here so
  // the shift matures while a family stop ahead — Boynton Beach Mall, R1's third pickup — is
  // still more than ten minutes away (ASM-14), and the one already served is not touched.
  faults: [{ kind: "stall", atSimSeconds: 120, durationSec: 720 }],
};

/**
 * PRD §18.2 step 8 plus AT-11's duplicate and out-of-order points: one 660 s gap walks
 * the 180 s STALE band and the 600 s exception in a single run.
 */
export const RUN_GPS_GAP: ReplaySpec = {
  route: ROUTE_3,
  startAtMs: SCENARIO_START_MS,
  seed: 11,
  faults: [
    { kind: "duplicate", atSimSeconds: 30, count: 2 },
    { kind: "outOfOrder", atSimSeconds: 60 },
    { kind: "gpsGap", atSimSeconds: 180, durationSec: 660 },
  ],
};

/** AT-03's other half: ±40 m of jitter must move the marker and not the ETA text. */
export const RUN_JITTER: ReplaySpec = {
  route: VAN3_ROUTE,
  startAtMs: SCENARIO_START_MS,
  seed: 42,
  faults: [{ kind: "jitter", atSimSeconds: 0, meters: 40 }],
};

/**
 * LOC-01: an unbound device. Ingested, stored `bound=false`, displayed nowhere.
 *
 * A device nobody linked, on R3's road (`UNBOUND_ROUTE` above), because that is what the board
 * is reading when it says a van has no position: not a van that is somewhere else, points whose
 * device is not linked to a van (ADR-013). The live map proves it by counting the points in
 * words instead of drawing a truck.
 */
export const RUN_UNBOUND: ReplaySpec = {
  route: UNBOUND_ROUTE,
  startAtMs: SCENARIO_START_MS,
  seed: 99,
  faults: [{ kind: "unboundDevice" }],
};

export interface DemoRun {
  spec: ReplaySpec;
  /** One line for the demo rail: which fault this run is here to show. */
  faultLabel: string;
}

/**
 * The runs the live map draws. `faultLabel` is the only one of these fields that reaches a
 * screen, so it is written the way the rest of the UI is written (COPY-GUIDE §1-§2): what was
 * injected, in plain words. The PRD step and acceptance test each run exists for stay in the
 * comments above their specs, where they are a note to the next engineer rather than something
 * a reviewer standing at the board has to decode.
 */
export const DEMO_RUNS: DemoRun[] = [
  { spec: RUN_STALL, faultLabel: "Stall 12 min" },
  { spec: RUN_GPS_GAP, faultLabel: "GPS gap 11 min · duplicate + out-of-order points" },
  { spec: RUN_JITTER, faultLabel: "Jitter ±40 m" },
  { spec: RUN_UNBOUND, faultLabel: "Device not linked to a van" },
];

/**
 * Longest run in the set, in simulated seconds — the live map's scenario-clock loop length.
 *
 * It grew with the geometry: the tracks are the scenario's own runs now, and R1's morning
 * (route2, the stall) is a ≈32 km run across half the county rather than the 10 km the older
 * fixture drove. replays.test.ts holds the loop from both sides — long enough that every run
 * reaches its last stop on screen, and not so long that the live map sits on parked trucks.
 */
export const DEMO_RUN_SECONDS = 4620;
