/**
 * The day the board is about (PRD §6.1: a service date is a calendar date in the site's
 * timezone, not an instant).
 *
 * The board used to show one day and never say which: the shell's header carried today's real
 * date, the board carried the seeded day the scenario replays, and both were labelled "Service
 * date" (docs/ui/B12-SLICE1-DEFERRED.md §5). This module is the answer to that — one date on
 * screen, the demo day, and a board that is about that date and nothing else.
 *
 * A date also decides **when** the board is read, which is what this module is for now that the
 * console has no date switcher in it (Vera's final call). The demo day is read live, twelve
 * minutes into its morning runs, and that is the day `/today` builds. A day before it is read
 * after the last van is in, so every ride on it has an outcome — the only way to see a ride that
 * *ended* somewhere rather than one on its way, which is where AT-13 and AT-10 are tested. A day
 * after it has not started, so it is the plan and nothing more. Three phases, one rule each, and
 * the board says which it is looking at.
 *
 * Only one of those three is a day a request may ask for: the demo day. The other two are a test
 * and review path, behind the four gates in `dateOverrideAllowed` below — `/today` reads the
 * date through `requestedServiceDay`, so on any deployment a `?date=` is not a day the board
 * can be moved to, it is a parameter nothing reads (Veri #49).
 *
 * The **clock** is behind the same four gates, and through the same helper: `requestedClockSpeed`
 * is `requestedServiceDay` for §6.2's clock speeds. Moving the clock and moving the day are the
 * same kind of act — asking the console for a morning other than the one it is replaying at the
 * speed of a day — so they are one gate rather than two that could drift apart (Veri).
 *
 * Pure: the instants are whole-day offsets from the scenario's own start (`SCENARIO_START_MS`),
 * so nothing here reads a clock and every date in range is as deterministic as the demo day. The
 * range is bounded at a fortnight each way for exactly that reason: whole-day arithmetic is only
 * exact while the offset does not cross a daylight-saving change, and ±14 days around the seeded
 * Wednesday stays inside EDT.
 */

import { liveStreamConfig } from "@/config/live";
import {
  clampTick,
  instantAt,
  normalizeSpeed,
  tickAtScenarioSeconds,
  type ClockSpeed,
} from "@/domain/eta/scenario-clock";
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

/** The widest the test-only date override may reach, in days each way (daylight-saving note). */
export const DAY_RANGE_DAYS = 14;

/** The seeded day the scenario's runs are replayed on — the board's default, and its "live" day. */
export const DEMO_SERVICE_DATE = serviceDateIso(new Date(SCENARIO_START_MS));

/**
 * `ENDED` — the vans are in and every ride has an outcome.
 * `LIVE` — the demo day, read mid-morning.
 * `PLANNED` — the day has not started; this is the plan.
 */
export type DayPhase = "ENDED" | "LIVE" | "PLANNED";

export type ServiceDay = {
  /** "2026-10-14", the `<time dateTime>` and what the date override names a day by. */
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
  const inRange = (n: number) => Math.abs(n) <= DAY_RANGE_DAYS;
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
 * The service day a date names — the projection itself, with no gate on it: a test, a browser
 * check and `board.test.ts` all build a finished or an unstarted day through here.
 *
 * Anything that is not a date in range comes back as the demo day rather than as an error: this
 * value reaches the projection from outside it, and a board that refuses to render is a worse
 * answer than the day it was always going to show. A date that *is* in range and simply has no
 * runs is a different thing — the board renders it and says the day is empty (COPY-GUIDE §5).
 *
 * A request never reaches this function; `requestedServiceDay` is what `/today` calls.
 */
export function serviceDayFor(dateIso: string | undefined | null): ServiceDay {
  if (!dateIso || !/^\d{4}-\d{2}-\d{2}$/.test(dateIso)) return demoDay();
  for (let offset = -DAY_RANGE_DAYS; offset <= DAY_RANGE_DAYS; offset += 1) {
    const day = dayAtOffset(offset);
    if (day.iso === dateIso) return day;
  }
  return demoDay();
}

/** The instant the board reads the demo day at. */
export function boardInstantMs(): number {
  return demoDay().instantMs;
}

/** The tick the board's own instant falls on, so the live stream starts where the page did. */
export const BOARD_SCENARIO_TICK = tickAtScenarioSeconds(BOARD_SCENARIO_SECONDS);

/**
 * The demo day read at a tick of the scenario clock rather than at the fixed board instant.
 *
 * This is the one thing the live board needs that the three phases cannot give it: the same
 * service day, read *later*. The day is still the demo day in every other respect — its date,
 * its label, its LIVE phase, the runs it schedules — so a board built from it is the board a
 * coordinator is already looking at, a few minutes further into the morning.
 *
 * The clock holds at the last tick of the committed runs (`LAST_TICK`): the morning ends, and
 * a console that silently looped back to 07:30 would be claiming a day that is not happening.
 */
export function demoDayAtTick(tick: number): ServiceDay {
  const day = demoDay();
  return { ...day, instantMs: instantAt(clampTick(tick)) };
}

/** The one variable that opens the date override, named once so a test can set it by name. */
export const DATE_OVERRIDE_ENV_VAR = "E2E_DATE_OVERRIDE";

/**
 * Whether anything outside this build may ask the board for a day other than the demo day.
 *
 * The console has no date switcher (Vera's final call) and `?date=` was still read on every
 * deployment, which made it a switcher without a control: a URL in a chat message, or a crafted
 * link, and a coordinator is reading a day that is not today under a heading that says so in
 * small type (Veri #49). The parameter stays, because the finished day is where AT-10 and AT-13
 * are *proved* in a browser, and it is now a test-only path — four gates, the same shape as the
 * browser check's synthetic session (`src/domain/access/map-view.ts demoSessionRole`), one of
 * which cannot hold on any deployment we own:
 *
 *  1. `VERCEL_ENV` is unset — a local or CI shell, never a preview and never production, where
 *     the platform always sets it;
 *  2. `APP_DATA_CLASS=SYNTHETIC` — the ADR-015 data class, so there is no real day to look at;
 *  3. `DEMO_MODE=1` — the ADR-014 demo switch;
 *  4. `E2E_DATE_OVERRIDE=1` — said explicitly, so a local `pnpm dev` is the demo day too unless
 *     it is asked for. playwright.config.ts sets it for the browser check and nothing else does.
 */
export function dateOverrideAllowed(env: Record<string, string | undefined>): boolean {
  if (env.VERCEL_ENV !== undefined) return false;
  if (env.APP_DATA_CLASS !== "SYNTHETIC") return false;
  if (env.DEMO_MODE !== "1") return false;
  return env[DATE_OVERRIDE_ENV_VAR] === "1";
}

/**
 * The day a request gets: the demo day, unless this shell is a test shell that asked for the
 * override (above). The only way a date from outside may reach the projection.
 */
export function requestedServiceDay(
  dateIso: string | undefined | null,
  env: Record<string, string | undefined>,
): ServiceDay {
  return dateOverrideAllowed(env) ? serviceDayFor(dateIso) : demoDay();
}

/**
 * The speed the scenario clock runs at for a request: ×1, unless this shell is the same test
 * shell that may move the day (Veri).
 *
 * **The gate is `dateOverrideAllowed` itself**, called rather than copied, so there is exactly
 * one list of gates in this build and the clock cannot drift away from the date by someone
 * editing one of two copies. The clock is the same kind of act as the date: §6.2's ×10 and ×60
 * exist so a browser check can reach the 180 s badge, the 600 s exception and the one damped
 * window inside a test, and a console that read `?speed=` on a deployment would be a demo
 * instrument on a coordinator's screen — a morning running ten times over, with every age and
 * every window on it true of a day that is not passing at that rate.
 *
 * A speed outside the gate is not an error, for the same reason a date outside it is not: it is
 * the console's own ×1 (`liveStreamConfig.defaultSpeed`). A URL is typed by hand and pasted into
 * chats, and a board that refused to render would be a worse answer than the speed it was always
 * going to run at.
 */
export function requestedClockSpeed(
  raw: string | number | undefined | null,
  env: Record<string, string | undefined>,
): ClockSpeed {
  return dateOverrideAllowed(env) ? normalizeSpeed(raw) : liveStreamConfig.defaultSpeed;
}
