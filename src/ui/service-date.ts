/**
 * The site's operational "service date". PRD §6.1: service dates are calendar dates in the
 * site's timezone (America/New_York), not instants.
 */
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

/** "2026-10-14", for `<time dateTime>` and, later, query parameters. */
export function serviceDateIso(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: SITE_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}
