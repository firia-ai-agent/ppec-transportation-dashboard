/**
 * Replay engine — simulator → LocationIngest → geofence → ETA → notify gate.
 *
 * SOURCE: PRD §8 (recompute policy ASM-11, freshness ASM-15, downstream families),
 * §18.2 steps 7–8, ARCHITECTURE §6 (the same sequence as a diagram), AT-03 (one damped
 * 10-min window, downstream only, deterministic replay), AT-10 (geofence ≠ handoff),
 * AT-11 (duplicate / out-of-order / location loss), MOCKS-AND-DEMO §5.
 *
 * Deterministic and pure: given a {@link ReplaySpec} this returns the whole run —
 * points, arrivals, recalculations, notification **decisions** and location-loss
 * exceptions — with no clock, no network, no database and no sending. The /live-map
 * clock then reads frames out of the result; it does not drive the engine.
 */

import {
  ageSecondsAt,
  gpsBand,
  raisesLocationLossException,
  suppressesEtaText,
  GPS_LOST_SECONDS,
  type GpsBand,
} from "@/domain/location/freshness";
import { offsetByMeters, pointAtDistance, projectToPath, type Coord } from "@/domain/location/geo";
import {
  emptyGeofenceState,
  type GeofenceArrival,
  geofenceStep,
} from "@/domain/location/geofence";
import {
  emptyIngestState,
  ingestPoint,
  type IngestState,
  type StoredPoint,
} from "@/domain/location/ingest";
import type { Route } from "@/domain/location/route";
import { runSimulation, type SimFault, type SimPoint, type SimRun } from "@/domain/location/simulator";
import { computeEta, type EtaSnapshot, type StopEta } from "./eta";
import {
  emptyGateState,
  evaluateStop,
  type GateState,
  type NotificationDecision,
} from "./notify-gate";
import { trafficMultiplierAt } from "./traffic";

/** ASM-11: recompute on a new position after ≥60 s… */
export const RECOMPUTE_MIN_SECONDS = 60;
/** …or ≥300 m… */
export const RECOMPUTE_MIN_METERS = 300;
/** …and at least every 5 minutes. */
export const RECOMPUTE_PERIOD_SECONDS = 300;
/** ASM-11: with a 30 s debounce. */
export const RECOMPUTE_DEBOUNCE_SECONDS = 30;
/** ARCHITECTURE §6: the freshness sweeper runs every minute. */
export const FRESHNESS_SWEEP_SECONDS = 60;

export interface ReplaySpec {
  route: Route;
  /** Epoch ms the run starts, on the scenario clock. */
  startAtMs: number;
  /** Same seed ⇒ same run (AT-03). */
  seed: number;
  faults?: SimFault[];
  /**
   * Multiplier injected by the demo panel's traffic-band fault (MOCKS §5 ×1.5). It is
   * applied on top of the time-band multiplier, in the ETA and in the simulated world.
   */
  injectedTrafficMultiplier?: number;
}

/** One recalculation (ASM-11 trigger) with its decisions. */
export interface ReplayCalc {
  atMs: number;
  simSeconds: number;
  alongM: number;
  /** Why this recalculation happened. */
  trigger: "position" | "period" | "stop-completion" | "initial";
  snapshot: EtaSnapshot;
  decisions: NotificationDecision[];
  /** Window text each stop's family holds after this calculation (hysteresis). */
  publishedWindows: Readonly<Record<string, string | undefined>>;
  /** GPS age at this instant, seconds. */
  gpsAgeSeconds: number;
}

/** LOC-03: a 600 s location loss. One per loss, not one per sweep. */
export interface LocationLossException {
  deviceId: string;
  /** When the age first crossed 600 s. */
  raisedAtMs: number;
  /** When a position arrived again, if it did. */
  recoveredAtMs?: number;
  /** PRD l.457 / ASM-15: the dispatcher is pinged when this is raised. */
  dispatcherPing: true;
}

export interface ReplayResult {
  spec: ReplaySpec;
  run: SimRun;
  /** Accepted, bound positions in stored order — the only displayable ones. */
  accepted: StoredPoint[];
  ingest: IngestState;
  arrivals: GeofenceArrival[];
  calcs: ReplayCalc[];
  /** Every decision, suppressed ones included (the demo timeline shows both). */
  decisions: NotificationDecision[];
  /** Decisions that would produce a message. M5 sends nothing. */
  notifications: NotificationDecision[];
  exceptions: LocationLossException[];
  /** Traffic multiplier used for the whole run (time band × injected fault). */
  trafficMultiplier: number;
  endAtMs: number;
}

/** ASM-11 recompute policy for a newly accepted position (debounce applied first). */
function positionTrigger(
  nowMs: number,
  alongM: number,
  lastCalcAtMs: number,
  lastCalcAlongM: number,
  stopCompleted: boolean,
): ReplayCalc["trigger"] | null {
  const sinceSec = (nowMs - lastCalcAtMs) / 1000;
  if (sinceSec < RECOMPUTE_DEBOUNCE_SECONDS) return null;
  if (stopCompleted) return "stop-completion";
  if (sinceSec >= RECOMPUTE_PERIOD_SECONDS) return "period";
  if (sinceSec >= RECOMPUTE_MIN_SECONDS) return "position";
  if (Math.abs(alongM - lastCalcAlongM) >= RECOMPUTE_MIN_METERS) return "position";
  return null;
}

/**
 * Run a whole replay.
 *
 * Every point the simulator emits is offered to LocationIngest exactly as a device
 * would send it — duplicates, out-of-order arrivals and unbound points included — so
 * the engine only ever sees what ingest accepted. Recalculations happen on two kinds
 * of event (ASM-11): a newly accepted position, and the scenario clock itself every
 * 5 minutes. The second kind is what makes a GPS gap visible: the clock keeps
 * recomputing while no position arrives, so the gate suppresses on stale GPS (LOC-03)
 * instead of the run simply going quiet.
 */
export function runReplay(spec: ReplaySpec): ReplayResult {
  const trafficMultiplier = trafficMultiplierAt(
    spec.startAtMs,
    spec.injectedTrafficMultiplier ?? 1,
  );
  const run = runSimulation({
    route: spec.route,
    startAtMs: spec.startAtMs,
    seed: spec.seed,
    faults: spec.faults,
    travelTimeMultiplier: trafficMultiplier,
  });
  const endAtMs = spec.startAtMs + run.durationSeconds * 1000;

  let ingest = emptyIngestState();
  let geofence = emptyGeofenceState();
  let gate: GateState = emptyGateState();

  const accepted: StoredPoint[] = [];
  const arrivals: GeofenceArrival[] = [];
  const arrivalsMs: Record<string, number> = {};
  const calcs: ReplayCalc[] = [];
  const decisions: NotificationDecision[] = [];

  let lastCalcAtMs = Number.NEGATIVE_INFINITY;
  let lastCalcAlongM = 0;
  let latestAccepted: StoredPoint | undefined;
  let latestAlongM = 0;

  const recompute = (nowMs: number, trigger: ReplayCalc["trigger"]): void => {
    const snapshot = computeEta({
      measured: run.measured,
      alongM: latestAlongM,
      nowMs,
      trafficMultiplier,
      arrivalsMs,
      runStartMs: spec.startAtMs,
    });
    const gpsAgeSeconds = latestAccepted
      ? ageSecondsAt(latestAccepted.recordedAtMs, nowMs)
      : Number.POSITIVE_INFINITY;
    const etaTextSuppressed = suppressesEtaText(gpsAgeSeconds);

    const calcDecisions: NotificationDecision[] = [];
    for (const stop of snapshot.stops) {
      const evaluated = evaluateStop(gate, { stop, nowMs, etaTextSuppressed });
      gate = evaluated.state;
      calcDecisions.push(evaluated.decision);
    }
    decisions.push(...calcDecisions);
    calcs.push({
      atMs: nowMs,
      simSeconds: (nowMs - spec.startAtMs) / 1000,
      alongM: latestAlongM,
      trigger,
      snapshot,
      decisions: calcDecisions,
      publishedWindows: publishedWindowsOf(gate, snapshot.stops),
      gpsAgeSeconds,
    });
    lastCalcAtMs = nowMs;
    lastCalcAlongM = latestAlongM;
  };

  // Scenario-clock ticks, every minute from the run start (ARCHITECTURE §6 sweeper).
  const ticks: number[] = [];
  for (let t = spec.startAtMs; t <= endAtMs; t += FRESHNESS_SWEEP_SECONDS * 1000) ticks.push(t);

  let pointIndex = 0;
  let tickIndex = 0;
  while (pointIndex < run.points.length || tickIndex < ticks.length) {
    const nextPointMs =
      pointIndex < run.points.length ? run.points[pointIndex].recordedAtMs : Number.POSITIVE_INFINITY;
    const nextTickMs = tickIndex < ticks.length ? ticks[tickIndex] : Number.POSITIVE_INFINITY;

    if (nextPointMs <= nextTickMs) {
      const point = run.points[pointIndex];
      pointIndex += 1;
      const step = ingestPoint(ingest, point);
      ingest = step.state;
      if (step.outcome.status !== "accepted") continue;

      const stored = step.outcome.point;
      accepted.push(stored);
      latestAccepted = stored;
      // The ETA engine sees the *projected* position, so ±40 m of jitter becomes a few metres
      // of chainage and never a different road (DESIGN-DIRECTION §5.1) — and never a second
      // pass of the same road, which is what `nearM` is for: a run that leaves a stop the way
      // it came drives one stretch twice, and "how far along" has to be the pass the van is on.
      latestAlongM = projectToPath(run.measured.path, [stored.lon, stored.lat], {
        nearM: latestAlongM,
      }).alongM;

      const geo = geofenceStep(geofence, spec.route.stops, stored);
      geofence = geo.state;
      if (geo.arrival) {
        arrivals.push(geo.arrival);
        arrivalsMs[geo.arrival.stopId] = geo.arrival.atMs;
      }

      const trigger =
        lastCalcAtMs === Number.NEGATIVE_INFINITY
          ? "initial"
          : positionTrigger(
              stored.recordedAtMs,
              latestAlongM,
              lastCalcAtMs,
              lastCalcAlongM,
              geo.arrival !== undefined,
            );
      if (trigger) recompute(stored.recordedAtMs, trigger);
      continue;
    }

    const tickMs = nextTickMs;
    tickIndex += 1;
    if (lastCalcAtMs === Number.NEGATIVE_INFINITY) continue; // nothing to recompute yet
    if ((tickMs - lastCalcAtMs) / 1000 >= RECOMPUTE_PERIOD_SECONDS) recompute(tickMs, "period");
  }

  return {
    spec,
    run,
    accepted,
    ingest,
    arrivals,
    calcs,
    decisions,
    notifications: decisions.filter((d) => d.outcome === "NOTIFY"),
    exceptions: sweepFreshness(spec, accepted, endAtMs),
    trafficMultiplier,
    endAtMs,
  };
}

function publishedWindowsOf(
  gate: GateState,
  stops: readonly StopEta[],
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const stop of stops) out[stop.stopId] = gate.stops[stop.stopId]?.publishedWindowText;
  return out;
}

/**
 * The ARCHITECTURE §6 freshness sweeper: once a minute, is the newest displayable
 * position older than 600 s? One exception per loss (LOC-03), closed when a position
 * arrives again. The 180 s STALE band needs no event — it is read off the clock by
 * {@link gpsBand} wherever it is displayed.
 */
function sweepFreshness(
  spec: ReplaySpec,
  accepted: readonly StoredPoint[],
  endAtMs: number,
): LocationLossException[] {
  if (accepted.length === 0) {
    return [
      {
        deviceId: spec.route.deviceId,
        raisedAtMs: spec.startAtMs,
        dispatcherPing: true,
      },
    ];
  }
  const exceptions: LocationLossException[] = [];
  let open: LocationLossException | undefined;
  let index = 0;
  let latest: StoredPoint | undefined;

  for (let t = spec.startAtMs; t <= endAtMs; t += FRESHNESS_SWEEP_SECONDS * 1000) {
    while (index < accepted.length && accepted[index].recordedAtMs <= t) {
      latest = accepted[index];
      index += 1;
    }
    if (!latest) continue;
    const age = ageSecondsAt(latest.recordedAtMs, t);
    if (!open && raisesLocationLossException(age)) {
      open = { deviceId: spec.route.deviceId, raisedAtMs: t, dispatcherPing: true };
      exceptions.push(open);
    } else if (open && age < GPS_LOST_SECONDS) {
      open.recoveredAtMs = latest.recordedAtMs;
      open = undefined;
    }
  }
  return exceptions;
}

// ---------------------------------------------------------------------------
// Frames — what the map pane reads at an arbitrary clock instant
// ---------------------------------------------------------------------------

export interface FrameStop {
  stopId: string;
  stopName: string;
  familyLabel?: string;
  status: StopEta["status"];
  /** The window the family holds (hysteresis), not the raw ETA. */
  windowText?: string;
  /** Raw ETA for the board's own "delta" column, epoch ms. */
  etaMs?: number;
}

export interface ReplayFrame {
  /** Clock instant of the frame, epoch ms. */
  nowMs: number;
  /** Position to draw: the reported (jittered) position, tweened along the geometry. */
  coord: Coord;
  headingDeg: number;
  /** `undefined` before the first displayable point (or for an unbound device). */
  gpsAgeSeconds?: number;
  band: GpsBand;
  etaTextSuppressed: boolean;
  exceptionRaised: boolean;
  /** Seconds the vehicle has been stopped, for the §5.1 "Stopped 3 min" label. */
  stoppedSeconds: number;
  /** Chainage driven so far, for the driven-route line. */
  drivenM: number;
  stops: FrameStop[];
  /** Decisions made at or before `nowMs` (the demo timeline). */
  decisions: NotificationDecision[];
  /** True when the device has no displayable position at all (unbound, LOC-01). */
  hidden: boolean;
}

/**
 * The frame at an arbitrary clock instant.
 *
 * `tween` controls the §5.1 motion rule: with it, the marker interpolates between the
 * two surrounding 5 s points *along the route geometry*; without it (reduced motion)
 * the marker sits on the last reported point and never animates.
 */
export function frameAt(result: ReplayResult, nowMs: number, tween = true): ReplayFrame {
  const points = result.accepted;
  const emptyFrame: ReplayFrame = {
    nowMs,
    coord: pointAtDistance(result.run.measured.path, 0),
    headingDeg: 0,
    band: "lost",
    etaTextSuppressed: true,
    exceptionRaised: true,
    stoppedSeconds: 0,
    drivenM: 0,
    stops: [],
    decisions: [],
    hidden: true,
  };
  if (points.length === 0) return emptyFrame;

  let prevIndex = -1;
  for (let i = 0; i < points.length; i += 1) {
    if (points[i].recordedAtMs <= nowMs) prevIndex = i;
    else break;
  }
  if (prevIndex < 0) return { ...emptyFrame, hidden: false };

  const prev = points[prevIndex];
  const next = points[prevIndex + 1];
  const simPrev = simPointFor(result, prev);

  let coord: Coord = [prev.lon, prev.lat];
  let drivenM = simPrev?.routeDistanceM ?? 0;
  let headingDeg = prev.headingDeg;

  if (tween && next) {
    const span = next.recordedAtMs - prev.recordedAtMs;
    const t = span <= 0 ? 0 : Math.max(0, Math.min(1, (nowMs - prev.recordedAtMs) / span));
    const simNext = simPointFor(result, next);
    if (simPrev && simNext) {
      // Tween the chainage, not the straight line between points, then re-apply the
      // interpolated jitter offset so the ±40 m wobble still reads on the map.
      drivenM = simPrev.routeDistanceM + (simNext.routeDistanceM - simPrev.routeDistanceM) * t;
      const base = pointAtDistance(result.run.measured.path, drivenM);
      const jx = simPrev.jitterOffsetM[0] + (simNext.jitterOffsetM[0] - simPrev.jitterOffsetM[0]) * t;
      const jy = simPrev.jitterOffsetM[1] + (simNext.jitterOffsetM[1] - simPrev.jitterOffsetM[1]) * t;
      coord = offsetByMeters(base, jx, jy);
    } else {
      coord = [prev.lon + (next.lon - prev.lon) * t, prev.lat + (next.lat - prev.lat) * t];
    }
    headingDeg = prev.headingDeg + shortestTurn(prev.headingDeg, next.headingDeg) * t;
  }

  const ageSeconds = ageSecondsAt(prev.recordedAtMs, nowMs);
  const calc = lastCalcAt(result, nowMs);
  const stops: FrameStop[] = (calc?.snapshot.stops ?? []).map((stop) => ({
    stopId: stop.stopId,
    stopName: stop.stopName,
    familyLabel: stop.familyLabel,
    status: stop.status,
    windowText: calc?.publishedWindows[stop.stopId],
    etaMs: stop.etaMs,
  }));

  return {
    nowMs,
    coord,
    headingDeg,
    gpsAgeSeconds: ageSeconds,
    band: gpsBand(ageSeconds),
    etaTextSuppressed: suppressesEtaText(ageSeconds),
    exceptionRaised: raisesLocationLossException(ageSeconds),
    stoppedSeconds: stoppedSecondsAt(result, prevIndex, nowMs),
    drivenM,
    stops,
    decisions: result.decisions.filter((d) => d.atMs <= nowMs),
    hidden: false,
  };
}

/**
 * Leg state in the DESIGN-DIRECTION §3 vocabulary, from what the frame can actually
 * see. Deliberately short of the leg machine: a geofence may say ARRIVED_* and never
 * "Handed off" (AT-10), so neither may this label.
 */
export function legStateLabel(frame: Pick<ReplayFrame, "stops" | "hidden">): string {
  if (frame.hidden || frame.stops.length === 0) return "No position";
  const pending = frame.stops.filter((s) => s.status === "pending");
  if (pending.length === 0) return "Arrived (vehicle)";
  const arrived = frame.stops.filter((s) => s.status === "arrived");
  return arrived.length > 0 ? "In transit" : "On the way to pickup";
}

/** Degrees to turn from `a` to `b`, in (−180, 180]; keeps the §5.1 heading smooth. */
export function shortestTurn(a: number, b: number): number {
  return ((((b - a) % 360) + 540) % 360) - 180;
}

function simPointFor(result: ReplayResult, stored: StoredPoint): SimPoint | undefined {
  return result.run.points.find(
    (p) => p.recordedAtMs === stored.recordedAtMs && p.deviceId === stored.deviceId,
  );
}

/** How long the vehicle has been reporting speed 0 at `nowMs` (§5.1 stall label). */
function stoppedSecondsAt(result: ReplayResult, prevIndex: number, nowMs: number): number {
  const points = result.accepted;
  if (points[prevIndex].speedMps > 0) return 0;
  let i = prevIndex;
  while (i > 0 && points[i - 1].speedMps === 0) i -= 1;
  return Math.max(0, (nowMs - points[i].recordedAtMs) / 1000);
}

/** The newest recalculation at or before `nowMs`. */
export function lastCalcAt(result: ReplayResult, nowMs: number): ReplayCalc | undefined {
  let found: ReplayCalc | undefined;
  for (const calc of result.calcs) {
    if (calc.atMs <= nowMs) found = calc;
    else break;
  }
  return found;
}
