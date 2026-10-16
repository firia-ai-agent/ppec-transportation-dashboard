/**
 * ETA engine (B-11) — PRD §8, from committed fixture durations only.
 *
 * Formula (PRD §8 l.804):
 *   ETA(s_k) = now + Σ_{i≤k} route_time(s_{i−1}→s_i, traffic)
 *                  + Σ_{i<k} (dwell_i + service(child_i))
 *                  + Σ hold_i,   hold_i = max(0, window_start_i − arrival_i)
 *
 * with two run-shaped readings of the dwell term: the origin stop carries no dwell (a
 * run starts at its departure, loaded), and the dwell still owed at a stop the vehicle
 * is standing in shrinks as the clock runs, so a vehicle serving a stop does not look
 * like it is falling behind.
 *
 * Parameters are the §8 table's decided values: dwell 3 min / wheelchair service 8 min
 * (ASM-12), uncertainty u = max(5 min, 15% remaining) (ASM-13), window text a
 * 10-minute window, never minute precision (§8 last row; COPY-GUIDE l.36/l.83).
 *
 * Pure: route_time comes from the ADR-007 fixtures, traffic from
 * ./traffic.ts, and nothing here reads a clock, the network or the database. No LLM
 * ever sees a raw position (PRD §8 "Raw points never invoke an LLM").
 */

import {
  freeFlowSecondsBetween,
  stopHoldSeconds,
  type MeasuredRoute,
  type RouteStop,
} from "@/domain/location/route";
import { etaText, fill } from "@/ui/copy";
import { PROJECT_TIME_ZONE } from "./traffic";

/** ASM-13: u is at least 5 minutes. */
export const UNCERTAINTY_FLOOR_SECONDS = 300;
/** ASM-13: …and at least 15% of the remaining time. */
export const UNCERTAINTY_FRACTION = 0.15;
/** PRD §8: the notified window is a 10-minute window, never minute precision. */
export const WINDOW_MINUTES = 10;

export interface EtaInput {
  measured: MeasuredRoute;
  /** Chainage of the vehicle along the route, metres (projected, so jitter-free). */
  alongM: number;
  /** Clock instant of this calculation, epoch ms. */
  nowMs: number;
  /** Time band × injected fault, from {@link trafficMultiplierAt}. */
  trafficMultiplier: number;
  /**
   * Observed geofence arrivals: stop id → epoch ms (ASM-18 ARRIVED_*). Used for two
   * things: a stop that has been arrived at gets no further ETA, and the dwell still
   * owed at the stop the vehicle is serving shrinks as the clock runs, so a vehicle
   * standing at a stop does not look like it is falling behind.
   */
  arrivalsMs?: Readonly<Record<string, number>>;
  /**
   * Epoch ms the run started. Only needed by stops that carry
   * `windowStartOffsetSeconds` (none in the P1 fixtures); defaults to `nowMs`.
   */
  runStartMs?: number;
}

/**
 * `arrived` — a geofence ARRIVED_* was observed (ASM-18).
 * `passed`  — the vehicle is beyond the stop but no arrival was observed (the run's
 *             origin, or a stop served during a GPS gap). No ETA, and no notification:
 *             an ETA text about a stop the truck has already left would be noise.
 * `pending` — still ahead of the vehicle. These are the "downstream" stops.
 */
export type StopEtaStatus = "arrived" | "passed" | "pending";

export interface StopEta {
  stopIndex: number;
  stopId: string;
  stopName: string;
  familyLabel?: string;
  status: StopEtaStatus;
  /** Epoch ms of the predicted arrival. Absent once the stop has been arrived at. */
  etaMs?: number;
  /** ASM-13 uncertainty u, seconds. */
  uncertaintySeconds?: number;
  /** The 10-minute window the ETA falls in (PRD §8), epoch ms. */
  windowStartMs?: number;
  windowEndMs?: number;
  /** "8:20–8:30 AM" (COPY-GUIDE l.36). */
  windowText?: string;
  /** Driving seconds still owed to this stop, after traffic. */
  driveSeconds?: number;
  /** Dwell + service still owed at earlier stops, seconds. */
  dwellSeconds?: number;
  /** Σ hold, seconds (0 in the P1 fixtures: no pickup windows). */
  holdSeconds?: number;
}

export interface EtaSnapshot {
  nowMs: number;
  alongM: number;
  trafficMultiplier: number;
  stops: StopEta[];
}

/** ASM-13: u = max(5 min, 15% of the remaining time). */
export function uncertaintySeconds(remainingSeconds: number): number {
  return Math.max(UNCERTAINTY_FLOOR_SECONDS, remainingSeconds * UNCERTAINTY_FRACTION);
}

/** The 10-minute wall-clock bucket an instant falls in (PRD §8 window text). */
export function windowFor(etaMs: number): { startMs: number; endMs: number } {
  const bucket = WINDOW_MINUTES * 60 * 1000;
  const startMs = Math.floor(etaMs / bucket) * bucket;
  return { startMs, endMs: startMs + bucket };
}

// `timeZoneName` is read only to tell the two halves of a repeated DST hour apart; the
// abbreviation is appended to the window text, never to a plain clock.
const TIME_FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: PROJECT_TIME_ZONE,
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
  timeZoneName: "short",
});

function parts(ms: number): { clock: string; meridiem: string; zone: string } {
  const p = TIME_FMT.formatToParts(new Date(ms));
  const hour = p.find((x) => x.type === "hour")?.value ?? "";
  const minute = p.find((x) => x.type === "minute")?.value ?? "";
  const meridiem = (p.find((x) => x.type === "dayPeriod")?.value ?? "").toUpperCase();
  const zone = p.find((x) => x.type === "timeZoneName")?.value ?? "";
  return { clock: `${hour}:${minute}`, meridiem, zone };
}

const HOUR_MS = 60 * 60 * 1000;

/**
 * Is this instant inside a local hour that happens twice?
 *
 * True exactly on the autumn fall-back: the hour before or the hour after reads the same on
 * the clock but in the other offset. Spring-forward is false — the skipped hour makes
 * readings rarer, not ambiguous — and a zone without DST is false all year.
 */
function inRepeatedLocalHour(ms: number): boolean {
  const here = parts(ms);
  return [parts(ms - HOUR_MS), parts(ms + HOUR_MS)].some(
    (other) =>
      other.clock === here.clock && other.meridiem === here.meridiem && other.zone !== here.zone,
  );
}

/**
 * "8:20–8:30 AM" (COPY-GUIDE l.36 / l.83): en dash, meridiem once at the end, and on
 * both ends when the window straddles noon or midnight. ET, the project clock.
 *
 * On the autumn fall-back the local clock repeats an hour, and two things went wrong. A
 * window across the fold read "1:50–1:00 AM" — backwards, telling a family to expect the van
 * an hour before it leaves. And every window *inside* the repeated hour rendered twice,
 * identically, an hour apart. So whenever either end is in a repeated hour, or the two ends
 * sit in different offsets, the zone abbreviation goes on both ends
 * ("1:50 AM EDT–1:00 AM EST"): the window reads forwards again and no two windows that day
 * share a rendering. Outside that hour nothing changes — there is nothing to disambiguate,
 * and a zone on every window would be noise.
 */
export function formatWindow(startMs: number, endMs: number): string {
  const a = parts(startMs);
  const b = parts(endMs);
  if (a.zone !== b.zone || inRepeatedLocalHour(startMs) || inRepeatedLocalHour(endMs)) {
    return `${a.clock} ${a.meridiem} ${a.zone}–${b.clock} ${b.meridiem} ${b.zone}`;
  }
  if (a.meridiem !== b.meridiem) return `${a.clock} ${a.meridiem}–${b.clock} ${b.meridiem}`;
  return `${a.clock}–${b.clock} ${b.meridiem}`;
}

/** A single ET time, "7:42 AM" (COPY-GUIDE l.36). For clocks, never for an ETA. */
export function formatClock(ms: number): string {
  const { clock, meridiem } = parts(ms);
  return `${clock} ${meridiem}`;
}

/**
 * "+6 min" / "−3 min" / "On time" (COPY-GUIDE l.36; U+2212 for the minus).
 *
 * A non-finite shift is not a shift. It used to print "−NaN min", which is both nonsense and
 * a claim; "On time" would be a different, worse claim. It says the shift is not known, which
 * is the honest answer and the §1 rule about certainty.
 */
export function formatDelta(seconds: number): string {
  if (!Number.isFinite(seconds)) return etaText.unknown;
  const minutes = Math.round(seconds / 60);
  if (minutes === 0) return etaText.onTime;
  return minutes > 0
    ? fill(etaText.ahead, { n: minutes })
    : fill(etaText.behind, { n: Math.abs(minutes) });
}

/**
 * The window each family holds *from the plan*, before the van has moved (PRD §8).
 *
 * The same formula as {@link computeEta} with the vehicle at its first stop and nothing observed
 * yet: Σ route_time from the committed durations × traffic, plus dwell and service at every stop
 * in between, and no hold term because the synthetic fixtures set no pickup windows. The origin
 * is served at the departure itself, so it gets a window too — which is what the morning's first
 * family is given, and `computeEta` cannot say because a vehicle standing at chainage 0 has
 * already "passed" that stop.
 *
 * This is how an afternoon ride has an arrival window at nine in the morning: the committed
 * geometry of the run the van will drive, from the time it is planned to leave. It is a plan and
 * never an observation — there is no position in it, so nothing here may move a window the way a
 * live recalculation does (ASM-11, hysteresis). The row that shows one says so by having no
 * shift beside it.
 */
export function plannedEta(input: {
  measured: MeasuredRoute;
  /** Epoch ms the run is planned to leave its first stop. */
  departureMs: number;
  trafficMultiplier: number;
}): StopEta[] {
  const { measured, departureMs, trafficMultiplier } = input;
  const stops = measured.route.stops;
  return stops.map((stop, k) => {
    const driveSeconds = freeFlowSecondsBetween(measured, 0, k) * trafficMultiplier;
    // i from 1: the origin carries no dwell — the run begins at its departure, loaded.
    let dwellSeconds = 0;
    for (let i = 1; i < k; i += 1) dwellSeconds += stopHoldSeconds(stops[i]);
    const etaMs = departureMs + (driveSeconds + dwellSeconds) * 1000;
    const window = windowFor(etaMs);
    return {
      stopIndex: k,
      stopId: stop.id,
      stopName: stop.name,
      familyLabel: stop.familyLabel,
      status: "pending" as const,
      etaMs,
      uncertaintySeconds: uncertaintySeconds(driveSeconds + dwellSeconds),
      windowStartMs: window.startMs,
      windowEndMs: window.endMs,
      windowText: formatWindow(window.startMs, window.endMs),
      driveSeconds,
      dwellSeconds,
      holdSeconds: 0,
    };
  });
}

/** Dwell + service still owed at `stop`, given any observed arrival. */
function dwellStillOwed(stop: RouteStop, nowMs: number, arrivalMs?: number): number {
  const total = stopHoldSeconds(stop);
  if (arrivalMs === undefined) return total;
  return Math.max(0, total - Math.max(0, (nowMs - arrivalMs) / 1000));
}

/**
 * ETA for every stop on the route at this instant.
 *
 * Stops already arrived at (ASM-18 geofence) are reported `arrived` with no ETA, which
 * is what makes "downstream only" structural: a delay can only move stops the vehicle
 * has not reached yet (PRD §8 "Downstream families = stops after the delayed point on
 * the same manifest").
 */
export function computeEta(input: EtaInput): EtaSnapshot {
  const { measured, alongM, nowMs, trafficMultiplier } = input;
  const arrivals = input.arrivalsMs ?? {};
  const stops = measured.route.stops;
  const runStartMs = input.runStartMs ?? nowMs;

  const results: StopEta[] = stops.map((stop, k) => {
    // `<=`, so the run's origin (chainage 0) is passed from the first calculation: the
    // vehicle starts there already loaded, which is also what the simulator does.
    if (arrivals[stop.id] !== undefined || measured.stopDistanceM[k] <= alongM + 1e-6) {
      return {
        stopIndex: k,
        stopId: stop.id,
        stopName: stop.name,
        familyLabel: stop.familyLabel,
        status: arrivals[stop.id] !== undefined ? ("arrived" as const) : ("passed" as const),
      };
    }

    // Σ_{i≤k} route_time, from the committed fixture durations × traffic.
    const driveSeconds = freeFlowSecondsBetween(measured, alongM, k) * trafficMultiplier;

    // Σ_{i<k} (dwell_i + service_i), for stops the vehicle has not left yet.
    let dwellSeconds = 0;
    for (let i = 1; i < k; i += 1) {
      // i starts at 1: the origin carries no dwell (the run begins at its departure).
      const earlier = stops[i];
      if (measured.stopDistanceM[i] < alongM - 1e-6) continue; // already departed
      dwellSeconds += dwellStillOwed(earlier, nowMs, arrivals[earlier.id]);
    }

    // Σ hold_i = max(0, window_start_i − arrival_i). The P1 fixtures set no pickup
    // windows, so this is 0; the term is implemented so a fixture can exercise it.
    let holdSeconds = 0;
    if (stop.windowStartOffsetSeconds !== undefined) {
      const arrivalMs = nowMs + (driveSeconds + dwellSeconds) * 1000;
      const windowStartMs = runStartMs + stop.windowStartOffsetSeconds * 1000;
      holdSeconds = Math.max(0, (windowStartMs - arrivalMs) / 1000);
    }

    const remainingSeconds = driveSeconds + dwellSeconds + holdSeconds;
    const etaMs = nowMs + remainingSeconds * 1000;
    const window = windowFor(etaMs);
    return {
      stopIndex: k,
      stopId: stop.id,
      stopName: stop.name,
      familyLabel: stop.familyLabel,
      status: "pending" as const,
      etaMs,
      uncertaintySeconds: uncertaintySeconds(remainingSeconds),
      windowStartMs: window.startMs,
      windowEndMs: window.endMs,
      windowText: formatWindow(window.startMs, window.endMs),
      driveSeconds,
      dwellSeconds,
      holdSeconds,
    };
  });

  return { nowMs, alongM, trafficMultiplier, stops: results };
}
