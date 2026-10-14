/**
 * Seeded GPS simulator (B-10) — replays a committed fixture route as telemetry.
 *
 * SOURCE: ADR-013 (P1 source is "the simulator replaying fixture routes, 1 point / 5 s
 * simulated"), MOCKS-AND-DEMO §5 fault buttons (Stall, Traffic ×1.5, GPS gap, Jitter
 * ±40 m, Duplicate/out-of-order points, Unbound device), PRD §18.2 steps 7–8,
 * AT-03 (same seed ⇒ same ETA events), AT-11 (duplicate / out-of-order).
 *
 * Pure and deterministic: no `Date.now()`, no `Math.random()`, no I/O. Same
 * `SimSpec` ⇒ byte-identical point list, which is what makes replay reproducible.
 * The simulator is a *producer* only: it never dedupes and never decides anything —
 * that is `ingest.ts`, which sees exactly what a real device would send.
 */

import { headingAtDistance, offsetByMeters, pointAtDistance, type Coord } from "./geo";
import { measureRoute, stopHoldSeconds, type MeasuredRoute, type Route } from "./route";

/** ADR-013: one point every 5 simulated seconds per bound device. */
export const SIM_TICK_SECONDS = 5;

/** MOCKS §5: the jitter fault is ±40 m. */
export const JITTER_METERS = 40;

/** MOCKS §5: the traffic-band fault is ×1.5 travel time. */
export const TRAFFIC_FAULT_MULTIPLIER = 1.5;

// ---------------------------------------------------------------------------
// Faults (MOCKS-AND-DEMO §5 / §6.1 fault tiles)
// ---------------------------------------------------------------------------

/** Vehicle stops dead at its current point for `durationSec`. GPS keeps reporting. */
export interface StallFault {
  kind: "stall";
  atSimSeconds: number;
  durationSec: number;
}

/** Travel time ×`multiplier` (default 1.5) from `atSimSeconds` to the end of the run. */
export interface TrafficFault {
  kind: "traffic";
  atSimSeconds: number;
  multiplier?: number;
}

/** The device stops emitting; the vehicle keeps driving. Drives the 180/600 s bands. */
export interface GpsGapFault {
  kind: "gpsGap";
  atSimSeconds: number;
  durationSec: number;
}

/** ±`meters` of seeded noise on every reported position. Must not move ETA text. */
export interface JitterFault {
  kind: "jitter";
  atSimSeconds: number;
  meters?: number;
}

/** The device re-sends `count` points it already sent (same `recordedAt`). AT-11. */
export interface DuplicateFault {
  kind: "duplicate";
  atSimSeconds: number;
  count?: number;
}

/** Two adjacent points arrive swapped, so the later one lands first. AT-11. */
export interface OutOfOrderFault {
  kind: "outOfOrder";
  atSimSeconds: number;
}

/** Device has no active binding: points are stored `bound=false` and never displayed. */
export interface UnboundDeviceFault {
  kind: "unboundDevice";
}

export type SimFault =
  | StallFault
  | TrafficFault
  | GpsGapFault
  | JitterFault
  | DuplicateFault
  | OutOfOrderFault
  | UnboundDeviceFault;

/** What a device sends to LocationIngest (ADR-013 payload + the binding flag). */
export interface TelemetryPoint {
  deviceId: string;
  /** Carrier timestamp, epoch ms on the scenario clock. Never accelerated (PRD §8). */
  recordedAtMs: number;
  lat: number;
  lon: number;
  /** Ground speed, m/s. 0 while stalled — the geofence rule reads this. */
  speedMps: number;
  /** Degrees clockwise from north. */
  headingDeg: number;
  /**
   * Whether the device had an active `device_binding` at send time. Ingest stores
   * unbound points with `bound=false` and shows them nowhere (LOC-01, ADR-013).
   */
  bound: boolean;
}

/** A simulated point: telemetry plus the simulator's own truth, for the map tween. */
export interface SimPoint extends TelemetryPoint {
  /** Seconds since the run started, on the simulated clock. */
  simSeconds: number;
  /** True chainage along the route, metres — jitter-free (DESIGN-DIRECTION §5.1). */
  routeDistanceM: number;
  /** The jitter offset applied to this point, in metres [east, north]. */
  jitterOffsetM: [number, number];
  /** True while a stall fault holds the vehicle in place. */
  stalled: boolean;
}

export interface SimSpec {
  route: Route;
  /** Epoch ms of the run start on the scenario clock. */
  startAtMs: number;
  /** Any 32-bit integer. Same seed + same faults ⇒ same points (AT-03). */
  seed: number;
  faults?: SimFault[];
  /**
   * Travel-time multiplier the *simulated world* drives at — normally the traffic band
   * for `startAtMs` (src/domain/eta/traffic.ts), passed in rather than imported so this
   * module stays a pure producer. Giving the simulator and the ETA engine the same
   * multiplier is what makes a fault the only thing that can move an ETA: without it,
   * a truck driving free-flow against a ×1.25 prediction would drift all on its own.
   */
  travelTimeMultiplier?: number;
}

export interface SimRun {
  spec: SimSpec;
  measured: MeasuredRoute;
  /** Every point the device emitted, in **emission** order (which may be out of order). */
  points: SimPoint[];
  /** Simulated seconds from the first tick to the last, inclusive of faults. */
  durationSeconds: number;
}

// ---------------------------------------------------------------------------
// Seeded PRNG — mulberry32. Small, fast, and identical on every platform, which
// is what AT-03 ("same seed ⇒ same ETA events") actually requires.
// ---------------------------------------------------------------------------

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    // 2**32 rather than the decimal literal: ten consecutive digits trip the
    // synthetic-seed linter's phone-number scan (scripts/seed-lint.mjs).
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

function firstFault<T extends SimFault>(faults: SimFault[], kind: T["kind"]): T | undefined {
  return faults.find((f) => f.kind === kind) as T | undefined;
}

/**
 * The traffic fault slows the vehicle down: a ×1.5 travel time is ÷1.5 speed. The
 * *time-band* traffic model used for ETA text lives in src/domain/eta/traffic.ts; this
 * is only the injected fault moving the truck.
 */
function speedScaleAt(
  simSeconds: number,
  traffic: TrafficFault | undefined,
  travelTimeMultiplier: number,
): number {
  const fault =
    !traffic || simSeconds < traffic.atSimSeconds
      ? 1
      : traffic.multiplier ?? TRAFFIC_FAULT_MULTIPLIER;
  return 1 / (travelTimeMultiplier * fault);
}

/**
 * Generate one deterministic run.
 *
 * The vehicle advances along the route at the free-flow speed implied by the committed
 * fixture leg durations (ADR-007): per tick it covers the metres that leg covers in 5 s,
 * scaled by the traffic fault and zeroed while stalled or while serving a stop. At every
 * stop after the first it holds for `DWELL_SECONDS + serviceSeconds` (PRD §8 ASM-12) with
 * `speed = 0`, which is also what makes the ASM-18 geofence rule fire. The run ends once
 * the hold at the last stop is over.
 */
export function runSimulation(spec: SimSpec): SimRun {
  const faults = spec.faults ?? [];
  const measured = measureRoute(spec.route);
  const rng = mulberry32(spec.seed);

  const stall = firstFault<StallFault>(faults, "stall");
  const traffic = firstFault<TrafficFault>(faults, "traffic");
  const gap = firstFault<GpsGapFault>(faults, "gpsGap");
  const jitter = firstFault<JitterFault>(faults, "jitter");
  const duplicate = firstFault<DuplicateFault>(faults, "duplicate");
  const outOfOrder = firstFault<OutOfOrderFault>(faults, "outOfOrder");
  const unbound = firstFault<UnboundDeviceFault>(faults, "unboundDevice") !== undefined;
  const jitterMeters = jitter?.meters ?? JITTER_METERS;
  const travelTimeMultiplier = spec.travelTimeMultiplier ?? 1;

  const points: SimPoint[] = [];
  const stops = spec.route.stops;
  // Hold at every stop except the origin (the run starts there, already loaded).
  const holdSeconds = stops.map((stop, i) => (i === 0 ? 0 : stopHoldSeconds(stop)));
  const totalHoldSeconds = holdSeconds.reduce((a, b) => a + b, 0);

  let alongM = 0;
  let simSeconds = 0;
  let holdUntilSec = -1;
  const held = new Set<number>();

  // Hard stop: free-flow driving, every stop hold, the stall, all slowed by the traffic
  // fault, plus slack. Guards a fixture whose geometry can never be finished.
  const maxSeconds =
    (measured.freeFlowSec *
      travelTimeMultiplier *
      (traffic?.multiplier ?? TRAFFIC_FAULT_MULTIPLIER) +
      totalHoldSeconds +
      (stall?.durationSec ?? 0)) +
    SIM_TICK_SECONDS * 4;

  for (;;) {
    const stalled =
      stall !== undefined &&
      simSeconds >= stall.atSimSeconds &&
      simSeconds < stall.atSimSeconds + stall.durationSec;
    const serving = simSeconds < holdUntilSec;

    const trueCoord = pointAtDistance(measured.path, alongM);
    const heading = headingAtDistance(measured.path, alongM);

    // Jitter is drawn every tick once the fault is armed, so the ±40 m wobble is
    // visible on the map while the projected chainage — and the ETA — is not moved.
    let jitterOffsetM: [number, number] = [0, 0];
    if (jitter && simSeconds >= jitter.atSimSeconds) {
      jitterOffsetM = [(rng() * 2 - 1) * jitterMeters, (rng() * 2 - 1) * jitterMeters];
    }
    const reported: Coord = offsetByMeters(trueCoord, jitterOffsetM[0], jitterOffsetM[1]);

    const inGap =
      gap !== undefined &&
      simSeconds >= gap.atSimSeconds &&
      simSeconds < gap.atSimSeconds + gap.durationSec;

    const legSpeed = legFreeFlowSpeed(measured, alongM);
    const moving = !stalled && !serving;
    if (!inGap) {
      points.push({
        deviceId: spec.route.deviceId,
        recordedAtMs: spec.startAtMs + simSeconds * 1000,
        lat: reported[1],
        lon: reported[0],
        speedMps: moving ? legSpeed * speedScaleAt(simSeconds, traffic, travelTimeMultiplier) : 0,
        headingDeg: heading,
        bound: !unbound,
        simSeconds,
        routeDistanceM: alongM,
        jitterOffsetM,
        stalled,
      });
    }

    const atEnd = alongM >= measured.path.totalM - 1e-6;
    if (atEnd && !serving && !stalled) break;
    if (simSeconds >= maxSeconds) break;

    if (moving) {
      const step =
        legSpeed * speedScaleAt(simSeconds, traffic, travelTimeMultiplier) * SIM_TICK_SECONDS;
      // Never drive past a stop inside one tick: stop arrival is an event the ETA
      // engine recomputes on (ASM-11 "stop completion").
      const nextStop = measured.stopDistanceM.findIndex(
        (d, i) => i > 0 && !held.has(i) && d > alongM + 1e-6,
      );
      const ceiling = nextStop < 0 ? measured.path.totalM : measured.stopDistanceM[nextStop];
      alongM = Math.min(ceiling, measured.path.totalM, alongM + step);

      if (nextStop >= 0 && alongM >= measured.stopDistanceM[nextStop] - 1e-6) {
        held.add(nextStop);
        holdUntilSec = simSeconds + SIM_TICK_SECONDS + holdSeconds[nextStop];
      }
    }
    simSeconds += SIM_TICK_SECONDS;
  }

  let emitted = points;
  if (duplicate) emitted = withDuplicates(emitted, duplicate);
  if (outOfOrder) emitted = withSwap(emitted, outOfOrder);

  return { spec, measured, points: emitted, durationSeconds: simSeconds };
}

/**
 * Free-flow speed on the leg containing this chainage, m/s, from the committed
 * fixture numbers only (geometry length ÷ leg duration).
 */
function legFreeFlowSpeed(measured: MeasuredRoute, alongM: number): number {
  for (const leg of measured.legs) {
    if (alongM < leg.endM || leg === measured.legs[measured.legs.length - 1]) {
      return leg.leg.durationSec === 0 ? 0 : leg.geometryM / leg.leg.durationSec;
    }
  }
  return 0;
}

/** Re-send points the device already sent: same `recordedAt`, so ingest must dedupe. */
function withDuplicates(points: SimPoint[], fault: DuplicateFault): SimPoint[] {
  const count = fault.count ?? 2;
  const startIndex = points.findIndex((p) => p.simSeconds >= fault.atSimSeconds);
  if (startIndex < 0) return points;
  const copies = points.slice(startIndex, startIndex + count);
  return [...points.slice(0, startIndex + count), ...copies, ...points.slice(startIndex + count)];
}

/** Swap one adjacent pair, so a later `recordedAt` is delivered first. */
function withSwap(points: SimPoint[], fault: OutOfOrderFault): SimPoint[] {
  const i = points.findIndex((p) => p.simSeconds >= fault.atSimSeconds);
  if (i < 0 || i + 1 >= points.length) return points;
  const next = [...points];
  [next[i], next[i + 1]] = [next[i + 1], next[i]];
  return next;
}
