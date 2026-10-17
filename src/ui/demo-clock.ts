"use client";
/**
 * The demo day's clock **in the browser**: one store, read by every surface that shows it.
 *
 * SOURCE: DESIGN-DIRECTION §2 (the header carries the scenario clock), §6.1 "Clock" (a readout
 * and a control), COPY-GUIDE §52 ("Demo not started" with a Start button), MOCKS-AND-DEMO §6.2
 * (the ×1/×10/×60 speeds), PRD §8 (acceleration applies to the scenario clock only).
 *
 * The clock itself is not here. The walk is `src/domain/eta/scenario-clock.ts` — a pure function
 * of a tick number — and the day it is read on is `src/domain/board/day.ts`. This module is the
 * small amount of state that walk needs to be *running*: a tick, whether it is running, and a
 * `setInterval` that advances it at one of §6.2's speeds. Nothing here recomputes a time of day
 * or an instant; it asks the domain for both.
 *
 * A module-level store rather than a React context, because the two readers are in different
 * trees: the clock sits in the shell's header (src/ui/ScenarioClock.tsx) and the board is the
 * page inside it (src/app/(app)/today/TodayBoard.tsx). A context would need a provider above
 * both, which means a change to the shell's layout for a value that has exactly one instance on
 * screen. `useSyncExternalStore` is React's own answer to that, and it gives the server render
 * the one snapshot a server has: not started.
 *
 * **No server state, by design.** Starting the clock writes nothing and asks nothing: it is the
 * instant the synthetic day is read at, and the day is already committed in the fixtures
 * (ADR-015 synthetic-only). That is what makes Start work on a Vercel preview, where the demo
 * reset endpoint refuses because the database is read-only there (DECISION-LEDGER #43,
 * `demoControlsGate` in src/modules/demo/reset.ts). Resetting the **data** is a different thing
 * with a different control, and this one does not pretend to do it.
 *
 * Not the map's clock: /live-map animates the committed replays on their own loop, with §6.2's
 * play/pause and speeds beside it (src/components/map/LiveFleetMap.tsx). That pane is its own
 * route, outside the shell, and it has no Start to press — this store is the console's clock,
 * and both read their frames out of the same deterministic replays at the instant a tick names.
 */

import { useSyncExternalStore } from "react";
import { liveStreamConfig } from "@/config/live";
import { BOARD_SCENARIO_TICK, DAY_LAST_TICK } from "@/domain/board/day";
import { formatClock } from "@/domain/eta/eta";
import { clampTick, instantAt, tickIntervalMs } from "@/domain/eta/scenario-clock";
import { scenarioClock } from "./copy";

/**
 * How fast the console walks the day: ×10, one of §6.2's three speeds and the same one the map
 * pane opens at.
 *
 * Not ×1 (the config's default, for the stream that plays a day at the speed of a day): the
 * readout is a wall clock to the minute, so at ×1 a founder presses Start and the only thing
 * that changes for the next sixty seconds is the button. At ×10 the time moves every six
 * seconds and the ages on the board move every half-second. Not ×60 either — the committed GPS
 * tracks end at 08:47, and a clock that reached the afternoon in a minute would spend the demo
 * showing vans with no signal.
 */
export const DEMO_CLOCK_SPEED: (typeof liveStreamConfig.speeds)[number] = 10;

export type DemoClock = {
  /** Whether the demo day is walking. `false` is "Demo not started", not "paused". */
  readonly running: boolean;
  /** The tick the day is read at — an instant, the same one for every reader (ADR-002). */
  readonly tick: number;
};

/**
 * Before Start, and after a reset: the board's own instant, which is where the server renders
 * the day (`BOARD_SCENARIO_TICK`, twelve minutes into the morning). The tick is already the
 * page's, so pressing Start continues the day the coordinator is looking at instead of jumping
 * them back to 7:30 and an empty board.
 */
export const NOT_STARTED: DemoClock = { running: false, tick: BOARD_SCENARIO_TICK };

let state: DemoClock = NOT_STARTED;
let timer: ReturnType<typeof setInterval> | null = null;
const listeners = new Set<() => void>();

function publish(next: DemoClock): void {
  state = next;
  for (const listener of [...listeners]) listener();
}

function stopTimer(): void {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
}

/**
 * One tick on. The clock **holds** at the end of the day rather than looping, for the reason
 * `demoDayAtTick` gives: a console that silently restarted the morning would be claiming a day
 * that is not happening.
 */
function step(): void {
  const next = clampTick(state.tick + 1, DAY_LAST_TICK);
  if (next === state.tick) {
    stopTimer();
    return;
  }
  publish({ running: true, tick: next });
}

/** What the Start button does. Starting an already-running clock is not a restart. */
export function startDemoClock(): void {
  if (state.running) return;
  publish({ running: true, tick: state.tick });
  stopTimer();
  timer = setInterval(step, tickIntervalMs(DEMO_CLOCK_SPEED));
}

/**
 * What the Reset button does: the readout says the demo has not started again, and every surface
 * reading this clock is back at the instant the server rendered. No stored data is touched,
 * because none was written.
 */
export function resetDemoClock(): void {
  stopTimer();
  publish(NOT_STARTED);
}

export function demoClockSnapshot(): DemoClock {
  return state;
}

export function subscribeDemoClock(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The clock, for a client component. A server render always gets "not started". */
export function useDemoClock(): DemoClock {
  return useSyncExternalStore(subscribeDemoClock, demoClockSnapshot, () => NOT_STARTED);
}

/**
 * What the readout says: the scenario time the day is at, or that it has not started. The one
 * place either of those words is chosen, so the header and a test cannot disagree about it.
 */
export function demoClockReadout(clock: DemoClock): string {
  return clock.running ? formatClock(instantAt(clock.tick)) : scenarioClock.notStarted;
}
