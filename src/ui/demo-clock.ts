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
 * **No server state in here, by design.** This module asks the server nothing and writes it
 * nothing: a tick is the instant the synthetic day is read at, and the day is already committed
 * in the fixtures (ADR-015 synthetic-only). That is what lets the clock run on a Vercel preview,
 * where the demo reset endpoint refuses because the database is read-only there
 * (DECISION-LEDGER #43, `demoControlsGate` in src/modules/demo/reset.ts).
 *
 * The one thing it does keep is **that the day was started**, in this tab's `sessionStorage`
 * under `DEMO_CLOCK_KEY` — two numbers, written on the press and read back by `resumeDemoClock`
 * after a reload. No cookie, no row, nothing a preview could refuse. The reason is below.
 *
 * Resetting the **data** is the other half of the header's one button, and it is not in here:
 * the press calls `POST /api/demo/reset` first and then starts this clock, in that order, and
 * src/ui/demo-day.ts is where those two are put together. The split is what makes the preview
 * answer possible — the data refuses, the clock still runs.
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
import { clampTick, instantAt, tickIntervalMs, ticksElapsed } from "@/domain/eta/scenario-clock";
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

/**
 * Where the browser remembers that the day was started: one key, `sessionStorage`, this tab.
 *
 * SOURCE: the founder's 2026-10-17 14:44 ET ruling has exactly two presses — the first resets
 * with no confirm, and after that the button says "Restart demo day" and asks first. A reload
 * used to undo that: the store above is module state, so a refresh (or a second tab) came back
 * to "Demo not started", and the next press threw away everything changed since the start with
 * nothing asked. So the *fact* of the start is remembered, and the clock is rebuilt from it.
 *
 * `sessionStorage` and not a cookie, a row or a server call, because the clock itself is none of
 * those (see the header of this file): a tick is an instant the committed fixtures are read at,
 * so the whole record is two numbers, and the demo has to keep working on a Vercel preview where
 * the database refuses to be written. Per tab, which is what a demo wants — a second tab opened
 * to show someone the "before" is a fresh day, and closing the browser ends the demo.
 */
export const DEMO_CLOCK_KEY = "ppec-demo-clock";

/**
 * The start, as two numbers: when it happened in wall time, and the tick the day started from.
 * Everything else a reload needs — the tick it has reached now, whether it is running — is
 * computed from these and §6.2's speed, so there is nothing stored that can go stale.
 */
export type DemoClockStart = {
  /** `Date.now()` at the press. */
  readonly startedAtMs: number;
  /** The tick the day was put back to, which is where it began walking. */
  readonly startTick: number;
};

/**
 * The tab's storage, or `null` where there is none to have: the server render, and a browser
 * that refuses it (Safari's private mode, a third-party frame, a quota already full). Reading
 * the property is what throws in those browsers, so the guard is a `try` and not a `typeof`.
 */
function store(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

/** The remembered start, or `null` — which is "the demo has not started", the same as no key. */
export function readDemoStart(): DemoClockStart | null {
  const raw = (() => {
    try {
      return store()?.getItem(DEMO_CLOCK_KEY) ?? null;
    } catch {
      return null;
    }
  })();
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object") return null;
    const { startedAtMs, startTick } = parsed as Partial<DemoClockStart>;
    if (typeof startedAtMs !== "number" || !Number.isFinite(startedAtMs)) return null;
    if (typeof startTick !== "number" || !Number.isFinite(startTick)) return null;
    return { startedAtMs, startTick };
  } catch {
    // Anything that is not the record we wrote — half a string, a value from an older build,
    // something another tool put under the key. Not started, and never an exception into a
    // render: a demo whose header throws is worse than one that asks for another press.
    return null;
  }
}

function writeDemoStart(start: DemoClockStart): void {
  try {
    store()?.setItem(DEMO_CLOCK_KEY, JSON.stringify(start));
  } catch {
    // Out of quota, or a browser that will not keep it. The clock in this tab still runs; only
    // the reload forgets, which is where this began.
  }
}

function forgetDemoStart(): void {
  try {
    store()?.removeItem(DEMO_CLOCK_KEY);
  } catch {
    // As above: nothing to put back.
  }
}

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

/**
 * Running, from a tick: the one place the interval is created, so a press and a reload cannot
 * end up walking the day at two different speeds or with two timers on it.
 */
function runFrom(tick: number): void {
  publish({ running: true, tick });
  stopTimer();
  timer = setInterval(step, tickIntervalMs(DEMO_CLOCK_SPEED));
}

/** What the Start button does. Starting an already-running clock is not a restart. */
export function startDemoClock(): void {
  if (state.running) return;
  runFrom(state.tick);
}

/**
 * Back to "Demo not started": every surface reading this clock is at the instant the server
 * rendered, and nothing is advancing it. No row and no demo data is touched — the only thing
 * it clears is this tab's record of the start, so a reload agrees with the header.
 *
 * Not a control of its own any more: the header has one button, and it restarts (below). This is
 * the half of a restart that puts the clock back.
 */
export function resetDemoClock(): void {
  stopTimer();
  forgetDemoStart();
  publish(NOT_STARTED);
}

/**
 * What the header's button does to the clock, on either press: the day back to the instant the
 * page was rendered at, then running from there.
 *
 * One function rather than two presses, because the demo day it belongs to is restarted the same
 * way — `POST /api/demo/reset` puts the data back to the start of the day and then the clock runs
 * (founder's final ruling, 2026-10-17 14:44 ET). A `startDemoClock` on a running clock is
 * deliberately *not* a restart, so the second press needs this and not that.
 */
export function restartDemoClock(): void {
  resetDemoClock();
  startDemoClock();
  // Last, and only here: this is the one function a press reaches, and `startDemoDay` calls it
  // on exactly the two answers that start a clock — the reset ran, or a preview refused it by
  // design. A failure never gets this far, so a failed press leaves no record to resume from.
  // A restart overwrites the previous one, because the day it is now running is this one.
  writeDemoStart({ startedAtMs: Date.now(), startTick: state.tick });
}

/**
 * What a reload does: if this tab started a demo day, put the clock back where that day has got
 * to by now and keep it walking. No record, or one we cannot read, and nothing happens — the
 * header says the demo has not started, which is the truth for a tab that never pressed Start.
 *
 * The tick is computed, not stored: the start tick plus the ticks §6.2's speed has had time for
 * since the press, clamped to the end of the service day. So a page left open over lunch comes
 * back holding at 5:30 PM like `step` does, rather than resuming in the middle of a morning that
 * is hours gone.
 *
 * Client only, from an effect — never during a render. The server has one snapshot it can give
 * (`NOT_STARTED`, which is what `useDemoClock`'s server snapshot returns) and the first client
 * render has to match it, so the resume happens after hydration and publishes to the readers.
 *
 * Already running — a second mount of the header on a client navigation — is a no-op: the clock
 * in memory is the live one, and recomputing it from storage would be the same tick anyway.
 */
export function resumeDemoClock(): void {
  if (state.running) return;
  const start = readDemoStart();
  if (start === null) return;
  const tick = clampTick(
    clampTick(start.startTick, DAY_LAST_TICK) +
      ticksElapsed(Date.now() - start.startedAtMs, DEMO_CLOCK_SPEED),
    DAY_LAST_TICK,
  );
  runFrom(tick);
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
