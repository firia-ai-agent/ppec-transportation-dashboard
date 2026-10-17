/**
 * The live board, as a snapshot and as a delta (B-12 slice 3 over B-10 / B-11).
 *
 * SOURCE: PRD §14 SURF-01 ("SSE with reconnect delta"), §8 (ETA, hysteresis, freshness),
 * LOC-01/02/03, AT-03 (live and replayed traffic delay: downstream only, hysteresis,
 * deterministic replay), AT-10 (a geofence is never a handoff), AT-11 (duplicate and
 * out-of-order points; location loss at 180 s and 600 s), ADR-002, ADR-013,
 * DESIGN-DIRECTION §4.1 (rows left, map right, row hover syncs the marker) and §5.1.
 *
 * What this module is: the board at a **tick** of the scenario clock, and the difference
 * between two ticks. Nothing more. It decides nothing the board does not already decide —
 * `buildBoard` is still the one place a ride's state, its van and its window come from, and
 * the replay engine is still the one place a position comes from — it reads them at an
 * instant the clock names and says what changed since the last one.
 *
 * Why a delta at all: SURF-01 asks for one (PRD l.1058 "SSE with reconnect delta"), and the
 * board is 56 rides. A tick usually moves three GPS ages and one window; sending 56 rides
 * five times a minute, and re-rendering them, would make a quiet morning look like a busy
 * one. A delta is also what makes a reconnect cheap and, more importantly, *correct*: the
 * client names the last tick it holds, and gets exactly what it missed.
 *
 * Pure and deterministic: no clock, no database, no network. Two calls at the same tick give
 * the same snapshot, which is what AT-03's "deterministic replay" means once a surface is
 * involved — a screenshot of a tick is evidence of that tick.
 */

import { canSeeMapData, type MapViewer } from "@/domain/access/map-view";
import { instantAt, scenarioSecondsAt } from "@/domain/eta/scenario-clock";
import { formatClock } from "@/domain/eta/eta";
import type { NotificationDecision } from "@/domain/eta/notify-gate";
import { frameAt, legStateLabel, type ReplayFrame } from "@/domain/eta/replay";
import type { GpsBand } from "@/domain/location/freshness";
import type { Coord } from "@/domain/location/geo";
import { routeGeometry, type Route } from "@/domain/location/route";
import { RUNS } from "@/modules/demo/fixtures/standard";
import type { GpsFreshness } from "@/ui/states";
import { buildBoard, type Board, type BoardGroup, type LegRow } from "./board";
import { demoDayAtTick } from "./day";
import { replayForVehicle, solverVehicle, vehicleOf } from "./scenario";

/* ───────────────────────────── one ride, live ───────────────────────────── */

/**
 * The part of a board row that a tick can change.
 *
 * Deliberately not the whole row: a child's name, their needs, the adult on file to receive
 * them and the van they are planned onto are facts about the day, not about the minute, and
 * streaming them would invite a client to believe a delta could change them. What moves is
 * what telemetry and the ETA engine move — and the ride's own state, because a geofence
 * arrival moves it (and may never move it further than an arrival: AT-10).
 */
export interface LiveRide {
  /** `childKey/AM` — the board's own row key. */
  key: string;
  group: BoardGroup;
  state: LegRow["ride"]["state"];
  needsActionReasons: readonly LegRow["needsActionReasons"][number][];
  nextStep: LegRow["nextStep"];
  /** The window the family holds (hysteresis), never the raw ETA. */
  windowText: string | null;
  deltaSeconds: number | null;
  /** LOC-03: GPS is stale, so ETA texts are paused for this ride. */
  etaPaused: boolean;
  gpsAgeSeconds: number | null;
  gpsFreshness: GpsFreshness | null;
  stoppedSeconds: number;
}

/* ───────────────────────────── one van, live ───────────────────────────── */

/** A stop as the map pane reads it: the published window, never a minute-precision ETA. */
export interface LiveStop {
  stopId: string;
  name: string;
  /** The landmark's own coordinate, so the pane can draw it without a second fixture. */
  coord: Coord;
  familyLabel?: string;
  status: "arrived" | "passed" | "pending";
  windowText?: string;
}

/**
 * What ingest has done with this device's points, in counts (ADR-013, AT-11).
 *
 * On the surface on purpose: "duplicates and out-of-order points are dropped at ingest" is a
 * claim about a seam nobody can see, and a demo that cannot show it has to be believed. These
 * are the numbers the seam actually produced.
 */
export interface LiveIngestCounts {
  accepted: number;
  duplicate: number;
  outOfOrder: number;
  /** LOC-01: stored with `bound=false`, displayed nowhere. */
  unbound: number;
}

export interface LiveVehicle {
  /** "V1" — the label every surface uses. */
  id: string;
  description: string;
  owner: string;
  /** §3 vocabulary, from what the frame can see. Never "Handed off" (AT-10). */
  stateLabel: string;
  coord: Coord;
  headingDeg: number;
  gpsAgeSeconds: number;
  band: GpsBand;
  /** Chainage driven so far, metres — the driven line's length, not its geometry. */
  drivenM: number;
  stoppedSeconds: number;
  /** LOC-03: ≥180 s, ETA texts paused. */
  etaTextSuppressed: boolean;
  /** LOC-03: ≥600 s, a location-loss exception is open and the dispatcher was pinged. */
  exceptionRaised: boolean;
  routeId: string;
  stops: readonly LiveStop[];
  /**
   * Absent for a role the map-view matrix does not give the fault internals to
   * (src/domain/access/map-view.ts `injectedFaults`). Absent, not blanked: a role that may not
   * see a number never receives it, so there is nothing in the payload to hide.
   */
  counts?: LiveIngestCounts;
}

/** A van with no displayable position at all — an unlinked device (LOC-01). */
export interface LiveSilentVehicle {
  id: string;
  description: string;
  owner: string;
  counts: LiveIngestCounts;
}

/** The planned geometry of one run. Static, so it rides in a snapshot and never in a delta. */
export interface LiveRoute {
  id: string;
  vehicleId: string;
  planned: Coord[];
}

/** A notification the gate opened for (AT-03). A decision, never a send. */
export interface LiveNotification {
  atMs: number;
  vehicleId: string;
  stopId: string;
  /**
   * The place, in words. The screen says this; the family code below is a key between
   * engineers and never reaches a row (COPY-GUIDE §1–§2, src/ui/no-codes.test.ts).
   */
  stopName: string;
  /** Which family's window moved — the gate's own label, for the send that is not built yet. */
  familyLabel?: string;
  shiftText: string;
  windowText?: string;
}

/* ───────────────────────────── the snapshot ───────────────────────────── */

export interface LiveSnapshot {
  /** The tick this snapshot is of — the SSE event id a reconnect resumes from. */
  tick: number;
  scenarioSeconds: number;
  nowMs: number;
  /** "7:42 AM" — the scenario clock in words. */
  clockText: string;
  rides: readonly LiveRide[];
  vehicles: readonly LiveVehicle[];
  silent: readonly LiveSilentVehicle[];
  routes: readonly LiveRoute[];
  notifications: readonly LiveNotification[];
  /** §2 header pill: the age of the freshest displayable position in the fleet. */
  gpsAgeSeconds: number | null;
  needsActionCount: number;
}

/**
 * What changed between two ticks.
 *
 * `rides` and `vehicles` carry only the ones that moved; `notifications` only the ones the
 * gate opened in between. The static halves — the routes, and a van that has never had a
 * position — are absent, because a client that is applying a delta already has them.
 */
export interface LiveDelta {
  tick: number;
  /** The tick this delta is measured from, so a client can refuse one that does not fit. */
  fromTick: number;
  scenarioSeconds: number;
  nowMs: number;
  clockText: string;
  rides: readonly LiveRide[];
  vehicles: readonly LiveVehicle[];
  notifications: readonly LiveNotification[];
  gpsAgeSeconds: number | null;
  needsActionCount: number;
}

function liveRideOf(leg: LegRow): LiveRide {
  const { ride } = leg;
  return {
    key: leg.key,
    group: leg.group,
    state: ride.state,
    needsActionReasons: leg.needsActionReasons,
    nextStep: leg.nextStep,
    windowText: ride.windowText,
    deltaSeconds: ride.deltaSeconds,
    etaPaused: ride.etaPaused,
    gpsAgeSeconds: ride.gpsAgeSeconds,
    gpsFreshness: ride.gpsFreshness,
    stoppedSeconds: ride.stoppedSeconds,
  };
}

/** The vans the scenario runs today, in fixture order, each with its committed replay. */
function scenarioVehicles(): Array<{ vehicleKey: string; runKey: string }> {
  return RUNS.map((run) => ({ vehicleKey: run.vehicleKey, runKey: run.key }));
}

function countsOf(replay: ReturnType<typeof replayForVehicle>, deviceId: string): LiveIngestCounts {
  const device = replay?.ingest.devices[deviceId];
  return {
    accepted: device?.counts.accepted ?? 0,
    duplicate: device?.counts.duplicate ?? 0,
    outOfOrder: device?.counts.outOfOrder ?? 0,
    unbound: device?.counts.unbound ?? 0,
  };
}

function stopsOf(frame: ReplayFrame, route: Route): LiveStop[] {
  const coords = new Map(route.stops.map((stop) => [stop.id, stop.coord]));
  return frame.stops.map((stop) => ({
    stopId: stop.stopId,
    name: stop.stopName,
    // The committed route is where a stop's place comes from, so the pane needs no fixture of
    // its own and cannot draw a landmark the run does not actually call at.
    coord: coords.get(stop.stopId) ?? route.stops[0].coord,
    familyLabel: stop.familyLabel,
    status: stop.status,
    windowText: stop.windowText,
  }));
}

/**
 * The fleet at an instant: the vans with a position, and the ones with none.
 *
 * `tween: false`. The live board shows where a van has actually been seen, which on the
 * console is the honest answer: an interpolated position is a drawing convenience, and this
 * snapshot is also what the row's GPS age and the published window are read from. (The §5.1
 * tween still happens where it belongs — on /map-preview's own clock, which asks the same
 * engine for a tweened frame.)
 */
function fleetAt(nowMs: number): {
  vehicles: LiveVehicle[];
  silent: LiveSilentVehicle[];
  routes: LiveRoute[];
  gpsAgeSeconds: number | null;
  notifications: LiveNotification[];
} {
  const vehicles: LiveVehicle[] = [];
  const silent: LiveSilentVehicle[] = [];
  const routes: LiveRoute[] = [];
  const notifications: LiveNotification[] = [];
  let freshest: number | null = null;

  for (const { vehicleKey } of scenarioVehicles()) {
    const replay = replayForVehicle(vehicleKey);
    if (!replay) continue;
    const route = replay.spec.route;
    const run = RUNS.find((r) => r.vehicleKey === vehicleKey);
    const demoVehicle = run ? vehicleOf(run) : undefined;
    const solver = demoVehicle ? solverVehicle(demoVehicle) : undefined;
    const description = solver?.description ?? "";
    const owner = solver?.providerName ?? "";
    const counts = countsOf(replay, route.deviceId);
    const frame = frameAt(replay, nowMs, false);

    if (frame.hidden) {
      // LOC-01 / ADR-013: no marker, no row on the map, and the counts say why.
      silent.push({ id: vehicleKey, description, owner, counts });
      continue;
    }

    routes.push({ id: route.id, vehicleId: vehicleKey, planned: routeGeometry(route) });
    const age = frame.gpsAgeSeconds ?? Number.POSITIVE_INFINITY;
    if (Number.isFinite(age) && (freshest === null || age < freshest)) freshest = age;

    vehicles.push({
      id: vehicleKey,
      description,
      owner,
      stateLabel: legStateLabel(frame),
      coord: frame.coord,
      headingDeg: frame.headingDeg,
      gpsAgeSeconds: age,
      band: frame.band,
      drivenM: frame.drivenM,
      stoppedSeconds: frame.stoppedSeconds,
      etaTextSuppressed: frame.etaTextSuppressed,
      exceptionRaised: frame.exceptionRaised,
      routeId: route.id,
      stops: stopsOf(frame, route),
      counts,
    });

    for (const decision of frame.decisions) {
      if (decision.outcome !== "NOTIFY") continue;
      const stop = route.stops.find((candidate) => candidate.id === decision.stopId);
      notifications.push(liveNotificationOf(vehicleKey, decision, stop?.name ?? ""));
    }
  }

  notifications.sort((a, b) => a.atMs - b.atMs);
  return { vehicles, silent, routes, gpsAgeSeconds: freshest, notifications };
}

function liveNotificationOf(
  vehicleId: string,
  decision: NotificationDecision,
  stopName: string,
): LiveNotification {
  return {
    atMs: decision.atMs,
    vehicleId,
    stopId: decision.stopId,
    stopName,
    familyLabel: decision.familyLabel,
    shiftText: decision.shiftText,
    windowText: decision.windowText,
  };
}

/**
 * The same board, as one role may see it (src/domain/access/map-view.ts).
 *
 * The matrix was written for the map preview and it is the same question here: a front-desk
 * iPad has no business holding the family list, and the fault internals — the dropped-point
 * counts and the van with no binding — belong to whoever runs the demo. So the filtering
 * happens **before the payload is built**, not in the component: a role that may not see
 * something never receives it, which is the only version of that rule a browser cannot undo.
 *
 * `/today` is open to the two console roles, so in practice this strips the fault counts for a
 * coordinator and nothing else. It is written against the matrix rather than against those two
 * roles so that the day another role is given the board, the answer is already decided.
 */
export function forViewer(snapshot: LiveSnapshot, viewer: MapViewer): LiveSnapshot {
  const can = (key: Parameters<typeof canSeeMapData>[1]) => canSeeMapData(viewer, key);
  const positions = can("vehiclePositions");
  const windows = can("stopWindows");
  const families = can("familyLabels");
  const faults = can("injectedFaults");

  return {
    ...snapshot,
    vehicles: positions
      ? snapshot.vehicles.map((vehicle) => ({
          ...vehicle,
          counts: faults ? vehicle.counts : undefined,
          stops: vehicle.stops.map((stop) => ({
            ...stop,
            windowText: windows ? stop.windowText : undefined,
            familyLabel: families ? stop.familyLabel : undefined,
          })),
        }))
      : [],
    routes: positions ? snapshot.routes : [],
    silent: faults ? snapshot.silent : [],
    notifications: can("notificationDecisions")
      ? snapshot.notifications.map((notification) => ({
          ...notification,
          familyLabel: families ? notification.familyLabel : undefined,
        }))
      : [],
    gpsAgeSeconds: positions ? snapshot.gpsAgeSeconds : null,
  };
}

/** The board at a tick, as this role may see it. What the stream actually sends. */
export function snapshotFor(viewer: MapViewer, tick: number): LiveSnapshot {
  return forViewer(liveSnapshotAt(tick), viewer);
}

/**
 * The delta between two ticks, as this role may see it.
 *
 * Filtered on both ends before the difference is taken, so a delta can never carry a field the
 * snapshot it is applied to was not allowed to have.
 */
export function deltaFor(viewer: MapViewer, fromTick: number, toTick: number): LiveDelta {
  return liveDelta(snapshotFor(viewer, fromTick), snapshotFor(viewer, toTick));
}

/** The whole live board at a tick of the scenario clock. */
export function liveSnapshotAt(tick: number): LiveSnapshot {
  const day = demoDayAtTick(tick);
  const board: Board = buildBoard(day);
  const fleet = fleetAt(day.instantMs);
  return {
    tick,
    scenarioSeconds: scenarioSecondsAt(tick),
    nowMs: day.instantMs,
    clockText: formatClock(day.instantMs),
    rides: board.legs.map(liveRideOf),
    vehicles: fleet.vehicles,
    silent: fleet.silent,
    routes: fleet.routes,
    notifications: fleet.notifications,
    gpsAgeSeconds: fleet.gpsAgeSeconds,
    needsActionCount: board.needsActionCount,
  };
}

/** Same value, same JSON: the comparison a delta is built on. */
function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** The delta from one snapshot to another. Only what moved. */
export function liveDelta(from: LiveSnapshot, to: LiveSnapshot): LiveDelta {
  const before = new Map(from.rides.map((ride) => [ride.key, ride]));
  const beforeVehicles = new Map(from.vehicles.map((vehicle) => [vehicle.id, vehicle]));
  const since = from.notifications.length;
  return {
    tick: to.tick,
    fromTick: from.tick,
    scenarioSeconds: to.scenarioSeconds,
    nowMs: to.nowMs,
    clockText: to.clockText,
    rides: to.rides.filter((ride) => !same(before.get(ride.key), ride)),
    vehicles: to.vehicles.filter((vehicle) => !same(beforeVehicles.get(vehicle.id), vehicle)),
    // Decisions are append-only on a deterministic replay, so "new" is "past the ones they had".
    notifications: to.notifications.slice(since),
    gpsAgeSeconds: to.gpsAgeSeconds,
    needsActionCount: to.needsActionCount,
  };
}

/** The delta between two ticks, without building either snapshot by hand. */
export function liveDeltaBetween(fromTick: number, toTick: number): LiveDelta {
  return liveDelta(liveSnapshotAt(fromTick), liveSnapshotAt(toTick));
}

/**
 * Apply a delta to the snapshot a client holds.
 *
 * The client side of the same rule, so the merge is tested rather than written twice in a
 * component: a delta replaces the rides and vans it names and leaves every other one alone.
 * A delta measured from a tick the client does not hold is **refused** — it comes back
 * unchanged — because applying it would leave the board a mixture of two instants, which is
 * worse than a board that waits for the next full snapshot.
 */
export function applyLiveDelta(snapshot: LiveSnapshot, delta: LiveDelta): LiveSnapshot {
  if (delta.fromTick !== snapshot.tick) return snapshot;
  const rides = new Map(snapshot.rides.map((ride) => [ride.key, ride]));
  for (const ride of delta.rides) rides.set(ride.key, ride);
  const vehicles = new Map(snapshot.vehicles.map((vehicle) => [vehicle.id, vehicle]));
  for (const vehicle of delta.vehicles) vehicles.set(vehicle.id, vehicle);
  return {
    ...snapshot,
    tick: delta.tick,
    scenarioSeconds: delta.scenarioSeconds,
    nowMs: delta.nowMs,
    clockText: delta.clockText,
    // Order is the board's own (fixture order, morning before afternoon), so it is read off
    // the snapshot rather than off the delta.
    rides: snapshot.rides.map((ride) => rides.get(ride.key) ?? ride),
    vehicles: snapshot.vehicles.map((vehicle) => vehicles.get(vehicle.id) ?? vehicle),
    notifications: [...snapshot.notifications, ...delta.notifications],
    gpsAgeSeconds: delta.gpsAgeSeconds,
    needsActionCount: delta.needsActionCount,
  };
}

/** The window each family currently holds for a van's stops — the hysteresis, in one object. */
export function publishedWindowsOf(vehicle: LiveVehicle): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const stop of vehicle.stops) out[stop.stopId] = stop.windowText;
  return out;
}
