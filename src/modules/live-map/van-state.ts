/**
 * ONE STATE PER VAN, out of GPS fixes and the saved plan — and never an ETA.
 *
 * The Live map shows a van exactly one chip: On route, At stop, Late, No GPS
 * (mockups/live-map.html, png/live-map.png). Which one is decided here, as three plain facts
 * fed to the one chip function (src/domain/location/van-chip.ts `vanChipOf`, which owns the
 * order of precedence and the LOC-03 bands). This module is the *measuring*: how old the fix
 * is, whether the van is standing at a stop, and whether the leg is behind.
 *
 * Pure. No clock of its own, no MapLibre, no database: a frame goes in and three booleans come
 * out, which is what lets the derivation be tested over the whole simulated day
 * (van-state.test.ts) rather than only where a browser happened to look.
 *
 * ETAs are deliberately absent from everything below. The number is computable — the replay
 * carries one for every stop — and it is not on this screen at all (REDESIGN-SPEC §3 removes
 * "the 13-field ETA line"; Firia's goal-5 brief: no ETAs anywhere). What *is* used is the
 * difference between the planned arrival and the current one, because that is the only way to
 * say "Late" honestly — and the difference stays inside this file: nothing returns it.
 */
import { notifyGateConfig } from "@/config/live";
import type { StopEta } from "@/domain/eta/eta";
import type { FrameStop } from "@/domain/eta/replay";
import { distanceM, type Coord } from "@/domain/location/geo";
import { GEOFENCE_RADIUS_M } from "@/domain/location/geofence";
import { vanChipOf, type VanChip } from "@/domain/location/van-chip";

/**
 * How far behind a leg has to run before the van reads "Late": 10 minutes, which is
 * `notifyGateConfig.shiftSeconds` — the same threshold that decides a family is owed a text
 * (PRD §8). One threshold, so a van cannot be late on the map while the outbox thinks it is on
 * time, or the other way round.
 */
export const LATE_SECONDS = notifyGateConfig.shiftSeconds;

/** A planned stop, as the geofence check needs it: somewhere a van can be standing. */
export type StopPoint = { id: string; coord: Coord };

/**
 * Standing at a stop: inside the ASM-18 geofence of one of the run's own stops.
 *
 * The same 100 m radius the arrival detector uses (src/domain/location/geofence.ts), so "At
 * stop" on the map and "arrived" in the ingest are the same event seen twice, rather than two
 * ideas of what being at a stop means.
 */
export function atStopOf(coord: Coord, stops: readonly StopPoint[]): boolean {
  return stops.some((stop) => distanceM(coord, stop.coord) <= GEOFENCE_RADIUS_M);
}

/**
 * Seconds the next stop still owed is running behind what the plan promised.
 *
 * The *next* stop and not the worst one: a leg is behind from the moment its next arrival slips,
 * and a stop three hops away carries the same slip plus everything that has not happened yet.
 * Stops already arrived at or passed cannot be late — a delay only moves what is still ahead
 * (PRD §8, "downstream families") — so they are skipped.
 *
 * Returns 0 when there is nothing left to arrive at, and 0 when either side has no time on it:
 * a van we cannot compute is not a van we call late.
 */
export function behindSecondsOf(
  current: readonly FrameStop[],
  planned: readonly StopEta[],
): number {
  const next = current.find((stop) => stop.status === "pending");
  if (!next?.etaMs) return 0;
  const promise = planned.find((stop) => stop.stopId === next.stopId)?.etaMs;
  if (!promise) return 0;
  return Math.max(0, (next.etaMs - promise) / 1000);
}

export type VanStateInput = {
  /** Seconds since the last accepted fix. `undefined` when the van has never reported. */
  gpsAgeSeconds: number | undefined;
  coord: Coord;
  /** The run's own stops, for the geofence check. */
  stops: readonly StopPoint[];
  /** Where the run is now, stop by stop. */
  current: readonly FrameStop[];
  /** Where the run was promised to be, stop by stop (`plannedEta`). */
  planned: readonly StopEta[];
};

/**
 * The van's one chip.
 *
 * A van that has never reported is `Infinity` seconds old rather than zero, which is the whole
 * point of the precedence in `vanChipOf`: silence reads as No GPS, never as On route.
 */
export function vanStateOf(input: VanStateInput): VanChip {
  return vanChipOf({
    gpsAgeSeconds: input.gpsAgeSeconds ?? Number.POSITIVE_INFINITY,
    atStop: atStopOf(input.coord, input.stops),
    behind: behindSecondsOf(input.current, input.planned) >= LATE_SECONDS,
  });
}

/* ───────────────────────────── the header's counts ───────────────────────────── */

export type VanCounts = { all: number; onRoute: number; late: number; noGps: number };

/**
 * "1 on route · 1 late · 1 no GPS" (mockups/live-map.html, the three chips in the top bar).
 *
 * There is no At-stop count, and that is the mockup rather than an oversight: the header counts
 * the two states a coordinator has to do something about and the one that means the day is
 * running. A van at a stop is counted in `all` and in no other cell.
 */
export function countsOf(chips: readonly VanChip[]): VanCounts {
  return {
    all: chips.length,
    onRoute: chips.filter((chip) => chip === "onRoute").length,
    late: chips.filter((chip) => chip === "late").length,
    noGps: chips.filter((chip) => chip === "noGps").length,
  };
}

/* ───────────────────────────── the list's order and filters ───────────────────────────── */

export const VAN_FILTERS = ["all", "late", "noGps"] as const;
export type VanFilter = (typeof VAN_FILTERS)[number];

/** Worst first (REDESIGN-SPEC §3: "Sorted with the worst first"). */
const SEVERITY: Record<VanChip, number> = { late: 0, noGps: 1, atStop: 2, onRoute: 3 };

/**
 * The list order: the van that needs a person, then the van we have lost, then the rest.
 *
 * Ties keep the day's own order (the van numbers), so the list is stable while the clock runs
 * and a row does not swap places with its neighbour between two ticks.
 */
export function bySeverity<T extends { chip: VanChip; number: number }>(vans: readonly T[]): T[] {
  return [...vans].sort((a, b) => SEVERITY[a.chip] - SEVERITY[b.chip] || a.number - b.number);
}

/** The filter row's answer. "All" is every van, including the ones at a stop. */
export function matchesFilter(chip: VanChip, filter: VanFilter): boolean {
  if (filter === "all") return true;
  if (filter === "late") return chip === "late";
  return chip === "noGps";
}
