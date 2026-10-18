"use client";

import { useSyncExternalStore } from "react";
import { DEMO_RUN_SECONDS } from "@/fixtures/replays";

/**
 * THE DEMO'S CLOCK — one scenario clock for the whole app, in the DEMO bar.
 *
 * It used to live inside the live map's own component: a row above the map reading "Scenario
 * clock 11:42 ET" with Pause, ×1/×10/×60 and Restart beside it (audit §3, §4 item 5: "delete the
 * helper lines, links and clock row"). Firia, 2026-10-17 8:36 PM ET: the clock moves into the
 * violet bar, beside Restart demo day, because it is chrome about the *demo* rather than a
 * control on a screen — which is the same rule that put "Restart demo day" there and took the
 * dead "Demo day · Not started" readout out of the old white header.
 *
 * So the state has to outlive the map, and be the same state the map reads: the bar is mounted
 * by the root layout and the map by a page, which are two React trees. A module-level store with
 * `useSyncExternalStore` is how two client components in two trees share one clock — both are in
 * the browser's one bundle, so this module is one object and there is one clock, not two that
 * drift. (The store is *client* state: nothing here is read on the server, which is why the
 * server snapshot is the start of the day rather than a guess at the current second.)
 *
 * The clock runs for everyone; the *controls* are a demo control and only the roles that hold
 * them get the buttons (src/domain/access/map-view.ts `clockControls`), exactly as before.
 */

/** §6.2 clock speeds. ×10 by default: a 25-minute run plays in two and a half. */
export const SPEEDS = [1, 10, 60] as const;
export const DEFAULT_SPEED = 10;
/** Wall-clock tick. 4 Hz is smooth enough for a tween between 5 s points. */
export const TICK_MS = 250;

export type DemoClockState = {
  /** Seconds into the scenario day, wrapping at the end of the demo's runs. */
  seconds: number;
  playing: boolean;
  speed: number;
};

const START: DemoClockState = { seconds: 0, playing: true, speed: DEFAULT_SPEED };

let state: DemoClockState = START;
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;

function emit(next: DemoClockState): void {
  state = next;
  for (const listener of listeners) listener();
}

/**
 * The ticker runs while something is watching and the clock is playing, and stops otherwise —
 * so a screen with no clock on it is not advancing an interval nobody reads.
 */
function sync(): void {
  const wanted = state.playing && listeners.size > 0;
  if (wanted && timer === null) {
    timer = setInterval(() => {
      emit({
        ...state,
        seconds: (state.seconds + (state.speed * TICK_MS) / 1000) % DEMO_RUN_SECONDS,
      });
    }, TICK_MS);
  } else if (!wanted && timer !== null) {
    clearInterval(timer);
    timer = null;
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  sync();
  return () => {
    listeners.delete(listener);
    sync();
  };
}

function getSnapshot(): DemoClockState {
  return state;
}

function getServerSnapshot(): DemoClockState {
  return START;
}

export const demoClock = {
  setPlaying(playing: boolean): void {
    emit({ ...state, playing });
    sync();
  },
  toggle(): void {
    demoClock.setPlaying(!state.playing);
  },
  setSpeed(speed: number): void {
    emit({ ...state, speed });
  },
  restart(): void {
    emit({ ...state, seconds: 0 });
  },
};

/** The clock, as a component reads it: the state, and the four things that change it. */
export function useDemoClock(): DemoClockState {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
