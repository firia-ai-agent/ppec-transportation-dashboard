/**
 * Which day and which leg a screen is looking at, read from the address and defaulted in centre
 * time.
 *
 * SOURCE: redesign spec §0 ("every screen opens on the date the app is opened, in the centre's
 * time zone"), §9.1 (the leg is part of every check: morning before noon, afternoon after it) and
 * §9.3 ("deep links keep state in the URL … a bad or missing `date` falls back to today").
 *
 * It exists so the page, the four routes and the ramp iPad cannot disagree about what "today"
 * means. The one rule worth stating out loud: a date is a calendar date **in America/New_York**,
 * never the server's idea of local time and never the browser's — a coordinator on a laptop still
 * set to Phoenix must be looking at the same day as the person next to them (PRD §6.1).
 */
import { defaultLeg } from "@/domain/day/readiness";
import type { Direction } from "@/domain/solver";
import { SITE_TIME_ZONE, serviceDateIso } from "@/ui/service-date";

/** The URL parameters §9.3 fixes: `?date=2026-10-17&leg=pm&van={id}`. */
export const DATE_PARAM = "date";
export const LEG_PARAM = "leg";
export const VAN_PARAM = "van";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The hour it is at the centre right now, 0–23, for the default leg. */
export function centreHour(now: Date = new Date()): number {
  const hour = new Intl.DateTimeFormat("en-US", {
    timeZone: SITE_TIME_ZONE,
    hour: "numeric",
    hour12: false,
  }).format(now);
  return Number(hour) % 24;
}

/**
 * The service date to show: the one in the address when it is a real date, and today at the
 * centre otherwise.
 *
 * A malformed or impossible date is not an error anybody can act on — it is a link that was
 * mistyped or a bookmark that aged — so it falls back to today rather than to a refusal.
 */
export function resolveDate(param: string | undefined | null, now: Date = new Date()): string {
  if (param && ISO_DATE.test(param)) {
    const at = new Date(`${param}T12:00:00Z`);
    if (!Number.isNaN(at.getTime()) && at.toISOString().slice(0, 10) === param) return param;
  }
  return serviceDateIso(now);
}

/** The leg to show: the one in the address, or the morning before noon and the afternoon after. */
export function resolveLeg(
  param: string | undefined | null,
  now: Date = new Date(),
): Direction {
  const asked = (param ?? "").trim().toUpperCase();
  if (asked === "AM" || asked === "PM") return asked;
  return defaultLeg(centreHour(now));
}

/** The address a screen keeps its state in, so a reload restores the same view (§9.3). */
export function boardHref(
  base: string,
  state: { date: string; leg: Direction; van?: string },
): string {
  const params = new URLSearchParams({ [DATE_PARAM]: state.date, [LEG_PARAM]: state.leg.toLowerCase() });
  if (state.van) params.set(VAN_PARAM, state.van);
  return `${base}?${params.toString()}`;
}
