/**
 * What a van's marker says about the van (Vera's bar for the live map screen; PRD §14 SURF-01,
 * DESIGN-DIRECTION §3, §5.1).
 *
 * The map used to label a marker with its GPS freshness alone — "V1 · Live 12 s" — which answers
 * "is this position worth believing" and not "what is this van doing". A coordinator reading the
 * pane is asking the second question, so the marker now carries the van's **state in words**: on
 * the way, late by so many minutes, stopped, or last seen at a time. Freshness is still on the
 * label beside it, because the disc's colour is the freshness band and §5.1's rule is that a
 * tone is never the only thing carrying a fact.
 *
 * Pure, and deliberately free of React and of lucide: the canvas needs the words (a MapLibre
 * `text-field` is a string) and the DOM needs the same words with an icon beside them
 * (`vanMarkerStates` in ./states.ts, which reads the very same copy templates). One rule, two
 * renderings, and van-state.test.ts holds the two outputs identical.
 *
 * Nothing here decides anything about a van. Every field it reads was decided by
 * src/domain/board/live.ts at the tick it names — the freshness band by
 * src/domain/location/freshness.ts, the stall by the replay, the lateness by the board's own
 * rows — and this chooses which of them the marker leads with.
 */

import { formatClock } from "@/domain/eta/eta";
import type { GpsBand } from "@/domain/location/freshness";
import { fill, fleetMap as stops, vanMarker as copy } from "./copy";

/**
 * The four things a marker can be saying, in the order they are read.
 *
 * `NO_FIX` is not one of the §3 freshness bands under another name: the bands describe how old a
 * position is, and this says the van has no current one at all, which is why its words are a
 * *clock time* rather than an age (Vera: "Last seen 7:31 AM").
 */
export const VAN_MARKER_STATES = ["ON_THE_WAY", "LATE", "STOPPED", "NO_FIX"] as const;

export type VanMarkerState = (typeof VAN_MARKER_STATES)[number];

/**
 * DESIGN-DIRECTION §5.1: a van reporting speed 0 for a minute is a stall worth saying out loud.
 *
 * One minute, in one place. It was written as `>= 60` in the board's location cell and again in
 * the pane's van list, which is two chances to disagree about when a van has stopped.
 */
export const VAN_STALL_SECONDS = 60;

/** The facts a marker's state is read from. Every one of them is on the live snapshot. */
export interface VanMotion {
  /** The §3 freshness band of the van's last displayable position. */
  band: GpsBand;
  /** Age of that position, seconds — the freshness the label carries beside the state. */
  gpsAgeSeconds: number;
  /** Seconds the van has been reporting speed 0 (§5.1 "Stopped 3 min"). */
  stoppedSeconds: number;
  /**
   * The worst shift on this van's rides at this tick, seconds (+ late). `null` when no ride on
   * it publishes one — a run nobody has moved yet, or a surface with no board rows to read.
   */
  lateSeconds: number | null;
  /** When the last displayable position was reported, epoch ms. `null` when there is none. */
  lastFixMs: number | null;
}

/**
 * Which of the four a marker is in.
 *
 * The order is the order a coordinator needs them in, and each step is a reason:
 *
 *  1. **No fix** first. Past the 600 s band there is no current position, so everything below —
 *     a stall, a lateness — would be a statement about a van nobody has heard from. The marker
 *     stays at the last place it *was* seen (never an invented one) and says when that was.
 *  2. **Stopped** before late. The §18.2 step 7 stall is the *cause* of the lateness beside it,
 *     and "Stopped 3 min" is the more specific and more actionable of the two. §5.1 asks for
 *     exactly those words and a clock.
 *  3. **Late** when the board's own rows say the van's window has moved against the plan by a
 *     minute or more. Under a minute is not a lateness worth a word; it is a van on its way.
 *  4. **On the way** otherwise.
 */
export function vanMarkerStateOf(motion: VanMotion): VanMarkerState {
  if (motion.band === "lost" || motion.lastFixMs === null) return "NO_FIX";
  if (motion.stoppedSeconds >= VAN_STALL_SECONDS) return "STOPPED";
  return lateMinutesOf(motion) >= 1 ? "LATE" : "ON_THE_WAY";
}

/** Whole minutes of lateness, rounded the way every other shift on screen is. 0 when none. */
export function lateMinutesOf(motion: Pick<VanMotion, "lateSeconds">): number {
  const seconds = motion.lateSeconds;
  if (seconds === null || !Number.isFinite(seconds) || seconds <= 0) return 0;
  return Math.round(seconds / 60);
}

/**
 * The `{placeholder}` values a state's words need: the minutes of a stall or a lateness, and the
 * clock time a van with no fix was last seen at.
 *
 * One function, used by both renderings, so the chip in the DOM and the label on the canvas can
 * never be filled from different numbers.
 */
export function vanMarkerValues(
  state: VanMarkerState,
  motion: VanMotion,
): Record<string, string | number> | undefined {
  switch (state) {
    case "STOPPED":
      return { minutes: Math.floor(motion.stoppedSeconds / 60) };
    case "LATE":
      return { minutes: lateMinutesOf(motion) };
    case "NO_FIX":
      // `lastFixMs` is null only on a van with no displayable position at all, and such a van is
      // absent from the map entirely (LOC-01) rather than drawn at a place we made up.
      return { time: motion.lastFixMs === null ? copy.neverSeen : formatClock(motion.lastFixMs) };
    default:
      return undefined;
  }
}

/** The copy template for a state, before its values are filled in. */
export const VAN_MARKER_WORDS: Readonly<Record<VanMarkerState, string>> = {
  ON_THE_WAY: copy.onTheWay,
  LATE: copy.late,
  STOPPED: copy.stopped,
  NO_FIX: copy.lastSeen,
};

/** The state in words — "On the way", "Late 8 min", "Stopped 3 min", "Last seen 7:31 AM". */
export function vanMarkerWords(motion: VanMotion): string {
  const state = vanMarkerStateOf(motion);
  const values = vanMarkerValues(state, motion);
  const words = VAN_MARKER_WORDS[state];
  return values ? fill(words, values) : words;
}

/**
 * What the marker is labelled with on the canvas: the van's name, its state in words, and the
 * freshness of the position it is drawn at.
 *
 * The freshness segment is dropped for a van with no fix, because that state's own words
 * ("Last seen 7:31 AM") *are* the freshness, and "V2 · Last seen 7:31 AM · No signal 11 min"
 * says the same thing twice in two vocabularies.
 */
export function vanMarkerMapLabel(
  id: string,
  marker: { state: VanMarkerState; label: string },
  age: string,
): string {
  return marker.state === "NO_FIX"
    ? fill(copy.mapLabel, { van: id, state: marker.label })
    : fill(copy.mapLabelAged, { van: id, state: marker.label, age });
}

/** A van with no current fix is drawn faded, at the last place it was actually seen. */
export function vanMarkerFaded(motion: VanMotion): boolean {
  return vanMarkerStateOf(motion) === "NO_FIX";
}

/**
 * What one of the van's stops says: the window the family holds, or the arrival instead.
 *
 * Arrivals read "Arrived (vehicle)" — never "Handed off", because a geofence cannot complete a
 * handoff (AT-10, PRD SURF-01). A stale van shows its last published window with the pause
 * spelled out rather than hiding it (LOC-03, §4.1: never hide data).
 *
 * It lives here, beside the van's own words, because two surfaces say it now: the pane's van
 * list and the child's drawer, which lists the van's stops in pickup order when a marker opens
 * it. It used to live in the pane's component, and importing that into the drawer would have
 * pulled MapLibre into a panel that draws no map.
 */
export function stopWindowText(
  status: "arrived" | "passed" | "pending",
  windowText?: string,
  etaTextSuppressed?: boolean,
): string {
  if (status === "arrived") return stops.arrived;
  if (status === "passed") return stops.passed;
  if (!windowText) return stops.windowPending;
  return etaTextSuppressed ? fill(stops.windowPaused, { window: windowText }) : windowText;
}
