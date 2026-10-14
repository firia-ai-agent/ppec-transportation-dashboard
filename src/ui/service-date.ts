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

/** "2026-10-14", for `<time dateTime>` and, later, query parameters. */
export function serviceDateIso(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: SITE_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}
