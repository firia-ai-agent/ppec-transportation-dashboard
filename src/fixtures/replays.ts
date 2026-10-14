/**
 * The four M5 demo runs. **Simulated data only.**
 *
 * SOURCE: PRD §18.2 steps 7–8 (replayed stall → one damped window to downstream
 * families; injected GPS gap → 180 s STALE, 600 s exception), AT-03, AT-10, AT-11,
 * LOC-01/02/03, MOCKS-AND-DEMO §5 (fault buttons) and §6.2 (the scenario clock).
 *
 * Each run is a {@link ReplaySpec}: a committed fixture route, a seed and a fault list.
 * `runReplay` turns one into a whole deterministic run, so the preview page and the
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
 * V4's device, on route1's geometry but with no active binding. Its points are stored
 * `bound=false` and displayed nowhere (LOC-01, ADR-013) — the preview proves that by
 * counting them in words instead of drawing a truck.
 */
export const ROUTE_1_UNBOUND: Route = {
  ...ROUTE_1,
  id: "route1-unbound",
  vehicleId: "V4",
  deviceId: "DEV-V4",
};

/** PRD §18.2 step 7: the replayed stall on route2 (`--track=route2`). */
export const RUN_STALL: ReplaySpec = {
  route: ROUTE_2,
  startAtMs: SCENARIO_START_MS,
  seed: 7,
  // PRD's own demo invocation is `delay:720s@00:09`; the stall lands at 00:02 here so
  // the shift matures while S1 is still more than 10 minutes away (ASM-14).
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
  route: ROUTE_1,
  startAtMs: SCENARIO_START_MS,
  seed: 42,
  faults: [{ kind: "jitter", atSimSeconds: 0, meters: 40 }],
};

/** LOC-01: an unbound device. Ingested, stored `bound=false`, displayed nowhere. */
export const RUN_UNBOUND: ReplaySpec = {
  route: ROUTE_1_UNBOUND,
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
 * The runs the preview draws. `faultLabel` is the only one of these fields that reaches a
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

/** Longest run in the set, in simulated seconds — the preview clock's loop length. */
export const DEMO_RUN_SECONDS = 2700;
