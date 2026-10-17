/**
 * The scenario clock (B-10) — a replay walked in ticks.
 *
 * SOURCE: PRD §8 ("clock acceleration applies only to `scenario_clock`, never to carrier
 * timestamps"), §18.2 steps 7–8, AT-03 (deterministic replay), MOCKS-AND-DEMO §6.2 (the
 * ×1/×10/×60 speeds), ADR-002 (the stream that walks it).
 *
 * This is B-10 work rather than B-12's: it is the clock the *replay* is read on, and the live
 * surface is one of its callers. /map-preview has had a clock of its own since M5 — a React
 * interval that increments a second counter — and the live board needs the same walk on the
 * server, where there is no component to hold it. So the walk is a pure function of a tick
 * number here, and both sides read frames out of the deterministic replay at the instant a
 * tick names.
 *
 * The unit is a **tick**, not a second: one tick is `tickScenarioSeconds` of scenario time
 * (5 s, the cadence every committed replay emits positions at, src/config/live.ts). Ticks are
 * numbered from the scenario's own start, so a tick number is an instant — the same instant
 * for every client, on every connection, in every test — which is what makes it usable as the
 * SSE event id that a reconnect resumes from (ADR-002 `Last-Event-ID`).
 *
 * Pure: no `Date.now()` anywhere in this file. Wall time arrives as an argument.
 */

import { liveStreamConfig } from "@/config/live";
import { DEMO_RUN_SECONDS, SCENARIO_START_MS } from "@/fixtures/replays";

/** Scenario seconds in one tick. */
export const TICK_SCENARIO_SECONDS = liveStreamConfig.tickScenarioSeconds;

/** §6.2's three speeds. Anything else is not offered. */
export type ClockSpeed = (typeof liveStreamConfig.speeds)[number];

/** The last tick of the demo morning: the runs are over and the clock holds here. */
export const LAST_TICK = Math.floor(DEMO_RUN_SECONDS / TICK_SCENARIO_SECONDS);

/** Scenario seconds at a tick, measured from the scenario start. */
export function scenarioSecondsAt(tick: number): number {
  return tick * TICK_SCENARIO_SECONDS;
}

/** The tick a scenario instant falls in (the tick at or before it). */
export function tickAtScenarioSeconds(scenarioSeconds: number): number {
  return Math.floor(scenarioSeconds / TICK_SCENARIO_SECONDS);
}

/** Epoch ms of a tick on the scenario clock — what the replay engine is read at. */
export function instantAt(tick: number): number {
  return SCENARIO_START_MS + scenarioSecondsAt(tick) * 1000;
}

/** Inside the run, and not before the start: the range a stream may walk. */
export function clampTick(tick: number): number {
  if (!Number.isFinite(tick)) return 0;
  return Math.max(0, Math.min(LAST_TICK, Math.floor(tick)));
}

/**
 * How long one tick takes in wall time at a given speed: 5 s at ×1, 500 ms at ×10.
 *
 * This is the only place acceleration happens, and it only ever changes how long we *wait*
 * between ticks — never what a tick contains. That is PRD §8's rule made structural: a
 * carrier timestamp inside the replay cannot be accelerated, because the acceleration is not
 * in the data.
 */
export function tickIntervalMs(speed: number): number {
  return Math.max(1, Math.round((TICK_SCENARIO_SECONDS * 1000) / speed));
}

/** Whole ticks elapsed in a span of wall time at a speed. */
export function ticksElapsed(wallMs: number, speed: number): number {
  if (!Number.isFinite(wallMs) || wallMs <= 0) return 0;
  return Math.floor(wallMs / tickIntervalMs(speed));
}

/**
 * The speed a caller asked for, or the console's default.
 *
 * Only the §6.2 speeds are honoured, and anything else — a word, a negative, a thousand —
 * falls back rather than failing: like `?date=`, this arrives in a URL that is typed by hand
 * and pasted into chats, and a board that refuses to render is a worse answer than the speed
 * it was always going to run at.
 */
export function normalizeSpeed(raw: string | number | undefined | null): ClockSpeed {
  const value = typeof raw === "string" ? Number(raw) : raw;
  const match = liveStreamConfig.speeds.find((speed) => speed === value);
  return match ?? liveStreamConfig.defaultSpeed;
}

/**
 * The tick a client says it already has, from the SSE `Last-Event-ID` header (or the `?since=`
 * form, for a caller that reconnects by hand). `null` means "send me the board first".
 *
 * A value that is not a tick number is `null` for the same reason as above: the client then
 * gets a full snapshot, which is correct and merely larger.
 */
export function parseLastTick(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined || raw.trim() === "") return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return null;
  return clampTick(value);
}
