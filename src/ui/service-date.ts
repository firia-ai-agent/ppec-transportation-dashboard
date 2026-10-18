/**
 * The site's operational "service date". PRD §6.1: service dates are calendar dates in the
 * site's timezone (America/New_York), not instants.
 */
import { SCENARIO_START_MS } from "@/fixtures/replays";

export const SITE_TIME_ZONE = "America/New_York";

/** "Tue, Oct 14" — the format COPY-GUIDE §5 uses in the board's empty state. */
export function serviceDateLabel(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: SITE_TIME_ZONE,
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(now);
}

/**
 * A wall-clock time, in the words a screen uses: "06:50" → "6:50 AM" (COPY-GUIDE §3).
 *
 * The plan and the schedule fixtures write a time in 24-hour form, which is a convenient way to
 * sort and the wrong way to read: no screen in this app prints "16:20". Formatted in UTC
 * deliberately — the string is already site-local, so there is nothing to convert, only to
 * write out. A string that is not "HH:MM" comes back unchanged, so a bad fixture is visible in
 * review rather than silently rendered as midnight.
 */
export function clockLabel(hhmm: string): string {
  const match = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!match) return hhmm;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return hhmm;
  return CLOCK_FMT.format(new Date(Date.UTC(2000, 0, 1, hours, minutes)));
}

const CLOCK_FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
});

/**
 * An instant as the clock on the wall at the centre: "2026-10-17T17:24:03Z" → "1:24 PM".
 *
 * The companion to {@link clockLabel}, for the times this app *makes* rather than reads out of a
 * fixture. A plan is saved at a moment, the server is the one that knows when, and it answers in
 * UTC — so the conversion is this function's, in the site's own timezone (PRD §6.1), and never
 * the browser's idea of local time: a coordinator on a laptop still set to Phoenix must read the
 * same minute as the one next to them.
 */
export function siteTimeLabel(at: Date): string {
  return SITE_CLOCK_FMT.format(at);
}

const SITE_CLOCK_FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: SITE_TIME_ZONE,
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
});

/**
 * The hour on the wall at the centre, 0–23 (PRD §6.1: the site's own timezone, never the
 * browser's). The one thing the day's *leg* is decided by — before noon the morning run is the
 * one being worked, after it the afternoon (REDESIGN-SPEC §9.1) — and it is read here, beside
 * the date the same clock gives, so the two cannot be taken from two different clocks.
 */
export function siteHour(now: Date = new Date()): number {
  return Number(HOUR_FMT.format(now));
}

const HOUR_FMT = new Intl.DateTimeFormat("en-GB", {
  timeZone: SITE_TIME_ZONE,
  hour: "2-digit",
  hourCycle: "h23",
});

/** "2026-10-14", for `<time dateTime>` and, later, query parameters. */
export function serviceDateIso(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: SITE_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/* ─────────────────── the day the demo is given on (4:50 PM ET ruling) ─────────────────── */

/**
 * THE ONE DATE HELPER. Every date a screen prints goes through here.
 *
 * The scenario is a recording: its runs, its texts and its stalls are all measured from one
 * seeded Wednesday, and that is what makes the board worth a screenshot. But a recording of a
 * Wednesday shown on a Saturday says "Wed, Oct 14" at the top of a screen somebody is looking
 * at on the 17th, which is the first thing the founder's walk caught (and the only sentence on
 * the board that was false). Firia's ruling, 2026-10-17 4:50 PM ET: the scenario day *is*
 * today, in the centre's own timezone, written "Sat, Oct 17". The times on it do not move —
 * 06:50 is still 06:50 — because the day is being re-dated, not re-timed.
 *
 * So a fixture date is a *key* and never a label: the board, the plan and the ramp look their
 * rows up by the seeded date and then ask this for the words. A fixture day either side of the
 * scenario's keeps its distance, so "the day before the demo day" is still yesterday.
 */
export const SCENARIO_SERVICE_DATE = serviceDateIso(new Date(SCENARIO_START_MS));

/** Whole days between two `YYYY-MM-DD` dates, as calendar days rather than as instants. */
function isoMidday(iso: string): number {
  const [year, month, day] = iso.split("-").map(Number);
  // Noon, so a timezone offset either way lands on the same calendar day.
  return Date.UTC(year, month - 1, day, 12);
}

/** The date this fixture day stands in for: the scenario's own day is today in New York. */
export function demoDateIso(scenarioIso: string, now: Date = new Date()): string {
  const shift = isoMidday(scenarioIso) - isoMidday(SCENARIO_SERVICE_DATE);
  return ISO_FMT.format(new Date(isoMidday(serviceDateIso(now)) + shift));
}

/** "Sat, Oct 17" — {@link demoDateIso}, in the words every screen writes a date in. */
export function demoDateLabel(scenarioIso: string, now: Date = new Date()): string {
  return LABEL_FMT.format(new Date(isoMidday(demoDateIso(scenarioIso, now))));
}

/*
 * Both formatters read UTC, not the site timezone: their input is already a calendar date
 * pinned to noon UTC, so there is nothing left to convert and converting again would move the
 * day at either end of the clock.
 */
const ISO_FMT = new Intl.DateTimeFormat("en-CA", {
  timeZone: "UTC",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const LABEL_FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  weekday: "short",
  month: "short",
  day: "numeric",
});
