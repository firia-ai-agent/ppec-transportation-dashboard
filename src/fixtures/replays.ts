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
import { liveMap } from "@/ui/copy";
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
 * The reserve van's road: route2's geometry — R1's morning — under V3's own device.
 *
 * V3 is on no run in the scenario (`RUNS` in src/modules/demo/fixtures/standard.ts): it is the
 * substitute the day holds back, and R1 is the run it is held back *for* — the §7 step 6 ramp
 * report of {1WC, 1AMB} is V3's own layout, and ARCHITECTURE §'s substitution writes V3's
 * capability for the date. So the one road a V3 replay can drive without contradicting a run is
 * the run it would take over, and the jitter fault rides on it.
 *
 * A fourth *route* rather than a fourth run: the geometry is route2's, so the two cannot drift.
 */
export const SUBSTITUTE_ROUTE: Route = {
  ...ROUTE_2,
  id: "route2-substitute",
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
  route: SUBSTITUTE_ROUTE,
  startAtMs: SCENARIO_START_MS,
  seed: 42,
  faults: [{ kind: "jitter", atSimSeconds: 0, meters: 40 }],
};

/**
 * LOC-01: an unbound device. Ingested, stored `bound=false`, displayed nowhere.
 *
 * V4's own device on V4's own run (route1 is R3's morning), because that is what the board is
 * reading when it says this van has no position: not a van that is somewhere else, a van whose
 * device is not linked to it (ADR-013). The live map proves it by counting the points in words
 * instead of drawing a truck.
 */
export const RUN_UNBOUND: ReplaySpec = {
  route: ROUTE_1,
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
 * screen, which is why the four labels are no longer written here: they live with every other
 * user-facing string, in src/ui/copy.ts (`liveMap.fault` — Vera, 2026-10-17), and this file
 * says which run shows which fault. The PRD step and acceptance test each run exists for stay
 * in the comments above their specs, where they are a note to the next engineer rather than
 * something a reviewer standing at the board has to decode.
 */
export const DEMO_RUNS: DemoRun[] = [
  { spec: RUN_STALL, faultLabel: liveMap.fault.stall },
  { spec: RUN_GPS_GAP, faultLabel: liveMap.fault.gpsGap },
  { spec: RUN_JITTER, faultLabel: liveMap.fault.jitter },
  { spec: RUN_UNBOUND, faultLabel: liveMap.fault.unboundDevice },
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
