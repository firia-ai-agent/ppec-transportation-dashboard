/**
 * THE DAY ON THE MAP: the simulated fleet at one instant of the scenario clock, in the shapes
 * the Live map's own list, pins and feed read.
 *
 * Where the positions come from, and the only place they come from: the simulated/demo source
 * behind the domain location interface (src/domain/location/simulator.ts, replayed by
 * src/domain/eta/replay.ts over the deterministic runs in src/fixtures/replays.ts). There is no
 * real provider and no paid service on this screen — which is exactly what the one "Simulated"
 * chip in the DEMO bar says, on this screen as on every other (§7.1, NFR-09).
 *
 * Pure, and that is deliberate. Everything a browser cannot answer — which chip a van wears,
 * what order the list is in, how many kids are still aboard — is decided here from a clock
 * reading, so the whole simulated day can be walked in a unit test (day.test.ts,
 * van-state.test.ts) rather than sampled wherever Playwright happened to look.
 *
 * What is NOT here, in any shape: an ETA. Not a time, not a window, not "+12 min". The replay
 * computes them and this module reads one — the difference between promised and projected —
 * only to answer "is this leg behind?", and that difference never leaves src/modules/live-map/
 * van-state.ts. REDESIGN-SPEC §3 deletes the 13-field ETA line from this screen; Firia's goal-5
 * brief deletes the rest.
 */
import { plannedEta } from "@/domain/eta/eta";
import {
  frameAt,
  runReplay,
  type ReplayFrame,
  type ReplayResult,
} from "@/domain/eta/replay";
import type { NotificationDecision } from "@/domain/eta/notify-gate";
import { measurePath, pathUpTo, type Coord } from "@/domain/location/geo";
import { routeGeometry } from "@/domain/location/route";
import type { VanChip } from "@/domain/location/van-chip";
import { driverFor } from "@/domain/plan/day";
import { SCENARIO_START_MS } from "@/fixtures/replays";
import { LIVE_FLEET } from "./fleet";
import { DEMO_CENTER } from "@/fixtures/map";
import { FAMILIES } from "@/modules/demo/fixtures/standard";
import { shortName } from "@/ui/display-name";
import { bySeverity, countsOf, vanStateOf, type StopPoint, type VanCounts } from "./van-state";

/**
 * A FAMILY, IN WORDS — "Kim P.", never "F7".
 *
 * A route stop carries its family *key* (src/fixtures/run-routes.ts: `familyLabel:
 * riders[0].familyKey`), and a key is a note about the database. COPY-GUIDE §1–§2 and the test
 * contract's global check both ban an internal code from the screen — the Auto texts feed in
 * png/live-map.png reads "Kim P. · Van 2", a person — so the key is resolved to the guardian the
 * fixtures already name, first name and family initial, which is how every other person on every
 * other screen is written (src/ui/display-name.ts).
 *
 * A key the fixtures do not know comes back `undefined` rather than as itself: a row with the
 * van and no name is honest, and a row with "F7" on it is a code on a founder's screen.
 */
function familyName(key: string | undefined): string | undefined {
  if (!key) return undefined;
  const family = FAMILIES.find((candidate) => candidate.key === key);
  if (!family) return undefined;
  return shortName(`${family.guardian.firstName} ${family.guardian.lastInitial}`);
}

/** The centre every run starts and ends at, and the one stop no van is assigned to. */
export const CENTER_COORD: Coord = DEMO_CENTER;
/** The stop id the fixtures give the centre; it has its own pin, so it is never a van's stop. */
const CENTER_STOP_ID = "CENTER";

/** One van, as the list, the pin and the legend all read it. */
export type LiveVan = {
  /**
   * The vehicle's id in the data ("V1"). Internal: it is a key, never a label, and nothing on
   * screen may print it — the test contract lints the DOM for `/\bV\d\b/`.
   */
  id: string;
  /** 1, 2, 3 — the number painted on the door, and the index into the van palette. */
  number: number;
  /** "Marco D.", through the one name helper so this screen cannot spell a person twice. */
  driver: string;
  chip: VanChip;
  /** Where it is heading next, in words: a place, never a code. */
  nextStop: string;
  /** Children still to be dropped on this run. */
  kids: number;
  /** Stop progress: `done` of `total`, the centre excluded (nobody is dropped at the centre). */
  done: number;
  total: number;
  coord: Coord;
  headingDeg: number;
  /** `undefined` when the van has never reported at all. */
  gpsAgeSeconds: number | undefined;
  /** The whole planned line, and the part of it already driven. */
  planned: Coord[];
  driven: Coord[];
  /** The run's own stops, for the map's stop circles. */
  stops: StopPoint[];
};

/** A row of the Auto texts feed: when, which family, which van. Never an ETA. */
export type FeedRow = {
  key: string;
  atMs: number;
  /** `undefined` for a role that may not see family labels (src/domain/access/map-view.ts). */
  familyLabel: string | undefined;
  vanNumber: number;
};

export type LiveDay = {
  vans: LiveVan[];
  counts: VanCounts;
  feed: FeedRow[];
  center: Coord;
};

/**
 * One replay per van, computed once per process rather than once per clock tick: the runs are
 * deterministic (same seed, same run — AT-03), so the whole day is a constant and the clock only
 * reads frames out of it. A 4 Hz clock must never re-run a simulation.
 *
 * The source is `LIVE_FLEET` — the screen's own three vans — and never `DEMO_RUNS`, which is
 * #53's four-run fixture and still carries the unbound fourth device. Firia's ruling: the demo
 * has exactly 3 vans and this screen may not reference slot 4 (./fleet.ts says it in full).
 */
const RUNS = LIVE_FLEET.map((run) => {
  const result = runReplay(run.spec);
  return {
    result,
    planned: plannedEta({
      measured: result.run.measured,
      departureMs: run.spec.startAtMs,
      trafficMultiplier: result.trafficMultiplier,
    }),
  };
});

/** Every stop of a run except the centre, which has a pin of its own. */
function stopsOf(result: ReplayResult): StopPoint[] {
  return result.run.measured.route.stops
    .filter((stop) => stop.id !== CENTER_STOP_ID)
    .map((stop) => ({ id: stop.id, coord: stop.coord }));
}

/**
 * The van's number and its colour slot.
 *
 * It is the van's position in the fleet — Van 1 is `LIVE_FLEET[0]` — so the number on the list,
 * the number in the map pin and the colour all come from one place and cannot disagree.
 *
 * Every van of the fleet is shown. There is no filter here any more, and that is the point of
 * Firia's ruling: the fleet used to be four runs with the fourth dropped at render time because
 * its device was unbound, and "three vans because one is invisible" is not three vans. A van on
 * this screen is a van in ./fleet.ts.
 *
 * (LOC-01 / ADR-013 has not gone anywhere — a device with no active binding still has no
 * displayable position. It is simply not a case this screen's fleet contains.)
 */
function fleetRuns(nowMs: number, tween: boolean) {
  return RUNS.map((run) => ({ ...run, frame: frameAt(run.result, nowMs, tween) }));
}

function vanOf(
  index: number,
  result: ReplayResult,
  frame: ReplayFrame,
  planned: ReturnType<typeof plannedEta>,
  kidsByVan: Readonly<Record<string, number>>,
): LiveVan {
  const route = result.spec.route;
  const stops = stopsOf(result);
  const geometry = routeGeometry(route);
  const next = frame.stops.find((stop) => stop.status === "pending");
  /*
   * Kids still aboard.
   *
   * The SAVED PLAN first: a coordinator decided who rides in this van, and that decision is the
   * answer (`ops.plan_assignment`, read in ./plan-read.ts). The run's own remaining stops are the
   * fallback, for the one server that has no database to read — the browser check — where there
   * is no saved plan to disagree with.
   */
  const kids =
    kidsByVan[route.vehicleId] ??
    frame.stops.filter((stop) => stop.status === "pending" && stop.stopId !== CENTER_STOP_ID)
      .length;
  const done = frame.stops.filter(
    (stop) => stop.status !== "pending" && stop.stopId !== CENTER_STOP_ID,
  ).length;

  return {
    id: route.vehicleId,
    number: index + 1,
    driver: shortName(driverFor(route.vehicleId)),
    chip: vanStateOf({
      gpsAgeSeconds: frame.gpsAgeSeconds,
      coord: frame.coord,
      stops,
      current: frame.stops,
      planned,
    }),
    // The last leg of every run is the centre, which is where the day ends rather than a stop
    // with a family at it — so a van on its way home says so by name like any other stop.
    nextStop: next?.stopName ?? "",
    kids,
    done,
    total: stops.length,
    coord: frame.coord,
    headingDeg: frame.headingDeg,
    gpsAgeSeconds: frame.gpsAgeSeconds,
    planned: geometry,
    driven: pathUpTo(measurePath(geometry), frame.drivenM),
    stops,
  };
}

/**
 * What went out to families, newest first — the mockup's "Auto texts" feed.
 *
 * Only decisions that would actually produce a message (`NOTIFY`); the suppressed ones are the
 * M5 debug screen's business and are off this page with the rest of it. The time is 12-hour ET
 * and the row carries no ETA: a family was texted, and when.
 */
function feedOf(
  runs: ReadonlyArray<{ result: ReplayResult; frame: ReplayFrame; number: number }>,
  showFamilyLabels: boolean,
): FeedRow[] {
  const rows = runs.flatMap((run) =>
    run.frame.decisions
      .filter((decision: NotificationDecision) => decision.outcome === "NOTIFY")
      .map((decision) => ({
        key: `${run.result.spec.route.vehicleId}-${decision.stopId}-${decision.atMs}`,
        atMs: decision.atMs,
        // A role that may not see a family's name never receives it, so there is nothing in the
        // markup to hide: the label is absent, not styled away.
        familyLabel: showFamilyLabels ? familyName(decision.familyLabel) : undefined,
        vanNumber: run.number,
      })),
  );
  return rows.sort((a, b) => b.atMs - a.atMs);
}

/**
 * The whole screen's data at one instant.
 *
 * `seconds` is the shared demo clock's (src/ui/demo-clock.ts) — the same clock the DEMO bar
 * prints, so the vans move to the time the bar is showing. `tween` is §9's reduced-motion rule:
 * without it a marker sits on its last reported point instead of sliding between two.
 */
export function liveDayAt(
  seconds: number,
  options: {
    tween?: boolean;
    familyLabels?: boolean;
    /** The saved plan's own count of children per van, keyed by the fixture's van key. */
    kidsByVan?: Readonly<Record<string, number>>;
  } = {},
): LiveDay {
  const nowMs = SCENARIO_START_MS + seconds * 1000;
  const runs = fleetRuns(nowMs, options.tween ?? true);
  const kidsByVan = options.kidsByVan ?? {};
  const vans = runs.map((run, i) => vanOf(i, run.result, run.frame, run.planned, kidsByVan));
  const numbered = runs.map((run, i) => ({ ...run, number: i + 1 }));
  return {
    vans: bySeverity(vans),
    counts: countsOf(vans.map((van) => van.chip)),
    feed: feedOf(numbered, options.familyLabels ?? false),
    center: CENTER_COORD,
  };
}
