/**
 * The day the board is about (PRD §6.1: a service date is a calendar date in the site's
 * timezone, not an instant).
 *
 * The board used to show one day and never say which: the shell's header carried today's real
 * date, the board carried the seeded day the scenario replays, and both were labelled "Service
 * date" (docs/ui/B12-SLICE1-DEFERRED.md §5). This module is the answer to that — one service
 * date for the screen, chosen in the header, and a board that is about that date and nothing
 * else.
 *
 * A date also decides **when** the board is read, which is the thing a date switcher is actually
 * for. The demo day is read live, twelve minutes into its morning runs. A day before it is read
 * after the last van is in, so every ride on it has an outcome — which is the only way to see a
 * ride that *ended* somewhere, rather than one that is on its way. A day after it has not
 * started, so it is the plan and nothing more. Three phases, one rule each, and the board says
 * which it is looking at.
 *
 * Pure: the instants are whole-day offsets from the scenario's own start (`SCENARIO_START_MS`),
 * so nothing here reads a clock and every date in range is as deterministic as the demo day. The
 * range is bounded at a fortnight each way for exactly that reason: whole-day arithmetic is only
 * exact while the offset does not cross a daylight-saving change, and ±14 days around the seeded
 * Wednesday stays inside EDT.
 */

import { SCENARIO_START_MS } from "@/fixtures/replays";
import { serviceDateIso, serviceDateLabel, SITE_TIME_ZONE } from "@/ui/service-date";

const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

/** `SCENARIO_START_MS` is 07:30 ET on the seeded day; every other instant is measured from it. */
const SCENARIO_START_LOCAL_MINUTE = 7 * 60 + 30;

/**
 * How far into the demo day's runs the board is read.
 *
 * The replays start at 07:30 ET and twelve minutes in is the instant where the day has something
 * to say in each of the three shapes the modules can produce: one run is standing in the PRD
 * §18.2 step 7 stall and its window has moved, one is inside the step 8 GPS gap so its texts are
 * paused (LOC-03), and one has no displayable position at all because its device is not bound to
 * it (LOC-01, ADR-013). A fixed instant also makes the board a thing a screenshot can be
 * evidence of.
 */
export const BOARD_SCENARIO_SECONDS = 720;

/** MOCKS-AND-DEMO §7 step 12 closes the day at 17:30; a day before the demo day is read there. */
const DAY_ENDED_LOCAL_MINUTE = 17 * 60 + 30;

/** MOCKS-AND-DEMO §6 "clock = 06:00 today": a day that has not started is read at its start. */
const DAY_NOT_STARTED_LOCAL_MINUTE = 6 * 60;

/** The widest a crafted `?date=` may reach, in days each way (see the daylight-saving note). */
export const SWITCHER_RANGE_DAYS = 14;

/** The seeded day the scenario's runs are replayed on — the board's default, and its "live" day. */
export const DEMO_SERVICE_DATE = serviceDateIso(new Date(SCENARIO_START_MS));

/**
 * `ENDED` — the vans are in and every ride has an outcome.
 * `LIVE` — the demo day, read mid-morning.
 * `PLANNED` — the day has not started; this is the plan.
 */
export type DayPhase = "ENDED" | "LIVE" | "PLANNED";

export type ServiceDay = {
  /** "2026-10-14", the `?date=` value and the `<time dateTime>`. */
  iso: string;
  /** "Wed, Oct 14" — the format COPY-GUIDE §5 uses. */
  label: string;
  phase: DayPhase;
  /** The instant the board reads this day at, epoch ms. */
  instantMs: number;
  /** Whole days from the demo day: −1 is the day before it. */
  offsetDays: number;
  /** PRD §18.1 schedules the runs Mon–Fri, so a weekend has no rides to show. */
  scheduled: boolean;
  /** The day before and the day after, as `?date=` values, or null at the ends of the range. */
  previousIso: string | null;
  nextIso: string | null;
};

const WEEKDAY = new Intl.DateTimeFormat("en-US", { timeZone: SITE_TIME_ZONE, weekday: "short" });

/** An instant on a day, from a site-local "HH:MM" wall clock. */
function instantOn(offsetDays: number, localMinute: number): number {
  return (
    SCENARIO_START_MS +
    offsetDays * DAY_MS +
    (localMinute - SCENARIO_START_LOCAL_MINUTE) * MINUTE_MS
  );
}

/** The instant a site-local time falls on, on this service day. The plan's own clock. */
export function localTimeOn(day: ServiceDay, hhmm: string): number {
  const match = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!match) throw new Error(`localTimeOn: ${hhmm} is not a wall-clock time`);
  return instantOn(day.offsetDays, Number(match[1]) * 60 + Number(match[2]));
}

function phaseFor(offsetDays: number): DayPhase {
  if (offsetDays < 0) return "ENDED";
  return offsetDays === 0 ? "LIVE" : "PLANNED";
}

const INSTANT_MINUTE: Readonly<Record<DayPhase, number>> = {
  ENDED: DAY_ENDED_LOCAL_MINUTE,
  LIVE: SCENARIO_START_LOCAL_MINUTE + BOARD_SCENARIO_SECONDS / 60,
  PLANNED: DAY_NOT_STARTED_LOCAL_MINUTE,
};

function dayAtOffset(offsetDays: number): ServiceDay {
  const phase = phaseFor(offsetDays);
  const instantMs = instantOn(offsetDays, INSTANT_MINUTE[phase]);
  const weekday = WEEKDAY.format(new Date(instantMs));
  const inRange = (n: number) => Math.abs(n) <= SWITCHER_RANGE_DAYS;
  return {
    iso: serviceDateIso(new Date(instantMs)),
    label: serviceDateLabel(new Date(instantMs)),
    phase,
    instantMs,
    offsetDays,
    scheduled: weekday !== "Sat" && weekday !== "Sun",
    previousIso: inRange(offsetDays - 1) ? dayIsoAtOffset(offsetDays - 1) : null,
    nextIso: inRange(offsetDays + 1) ? dayIsoAtOffset(offsetDays + 1) : null,
  };
}

function dayIsoAtOffset(offsetDays: number): string {
  return serviceDateIso(new Date(instantOn(offsetDays, INSTANT_MINUTE.LIVE)));
}

/** The demo day: the board's default, and the only day the committed replays belong to. */
export function demoDay(): ServiceDay {
  return dayAtOffset(0);
}

/**
 * The service day a `?date=` asks for.
 *
 * Anything that is not a date in range comes back as the demo day rather than as an error: a URL
 * is typed by hand and pasted into chats, and a board that refuses to render is a worse answer
 * than the day it was always going to show. A date that *is* in range and simply has no runs is
 * a different thing — the board renders it and says the day is empty (COPY-GUIDE §5).
 */
export function serviceDayFor(dateIso: string | undefined | null): ServiceDay {
  if (!dateIso || !/^\d{4}-\d{2}-\d{2}$/.test(dateIso)) return demoDay();
  for (let offset = -SWITCHER_RANGE_DAYS; offset <= SWITCHER_RANGE_DAYS; offset += 1) {
    const day = dayAtOffset(offset);
    if (day.iso === dateIso) return day;
  }
  return demoDay();
}

/** The instant the board reads the demo day at. */
export function boardInstantMs(): number {
  return demoDay().instantMs;
}
