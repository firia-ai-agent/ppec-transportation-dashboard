/**
 * The one time zone this app has.
 *
 * SOURCE: PRD §6.1 — a service date is a calendar date **at the centre**, never the server's idea
 * of local time and never the browser's. A coordinator on a laptop still set to Phoenix has to be
 * looking at the same day as the person beside them.
 *
 * It lives here, in configuration, because it was written down twice: `PROJECT_TIME_ZONE` in
 * src/domain/eta/traffic.ts (the traffic curve's hour) and `SITE_TIME_ZONE` in
 * src/ui/service-date.ts (the date on every screen). Two constants with one value is one rename
 * away from two values, and the two surfaces they feed — a time on a screen and the hour a model
 * reads — must never disagree. One export, imported by both (Firia's rule 6, 2026-10-17 5:48 PM).
 */
export const SITE_TIME_ZONE = "America/New_York";
