/**
 * GPS freshness — the single source of the four bands.
 *
 * SOURCE: DECISION-LEDGER row 30 (**Decided by founder**, 2026-10-14 11:39 ET):
 * live <60 s / aging 60–179 s / stale 180–599 s / no signal ≥600 s. That row departs
 * from PRD SURF-01's three bands (l.1058) on purpose, to match PRD l.456 / l.828
 * (LOC-03, ASM-15): 180 s stale badge + ETA texts suppressed; 600 s exception +
 * dispatcher ping.
 *
 * Pure: age in seconds in, band out. The map pane re-exports these so the UI and the
 * notify gate can never drift apart.
 */

/** Live band ends here (ledger row 30). */
export const GPS_FRESH_SECONDS = 60;
/** Stale band starts here: badge + ETA texts suppressed (LOC-03, ASM-15). */
export const GPS_STALE_SECONDS = 180;
/** "No signal" band starts here: exception + dispatcher ping (LOC-03). */
export const GPS_LOST_SECONDS = 600;

/**
 * How far ahead of our clock a carrier timestamp may sit and still be believed.
 *
 * Device clocks drift, and a point stamped a few seconds into the future is that drift, not
 * a position from the future. Past this much it is a broken clock: the point tells us nothing
 * about where the vehicle is now, so it reads as "no signal" rather than as the freshest
 * reading on the map. `ingestPoint` re-exports this constant and refuses such a point
 * outright, so a skewed stamp cannot sit in front of the real points behind it.
 */
export const MAX_FUTURE_SKEW_MS = 60_000;

/** The four ledger row 30 bands. */
export type GpsBand = "fresh" | "aging" | "stale" | "lost";

/**
 * The band an age in seconds falls in. Every boundary belongs to the worse band.
 *
 * Two kinds of age are not ages at all, and both used to read `fresh` — the best band, from
 * the worst input. They now read `lost`, which is the band that suppresses ETA texts and
 * raises the location-loss exception (LOC-03):
 *  - a non-finite age (NaN from a missing or unparsable stamp, Infinity from a device that
 *    has never reported);
 *  - an age further in the future than {@link MAX_FUTURE_SKEW_MS}, i.e. a clock we cannot use.
 */
export function gpsBand(ageSeconds: number): GpsBand {
  if (!Number.isFinite(ageSeconds)) return "lost";
  if (ageSeconds < -MAX_FUTURE_SKEW_MS / 1000) return "lost";
  if (ageSeconds >= GPS_LOST_SECONDS) return "lost";
  if (ageSeconds >= GPS_STALE_SECONDS) return "stale";
  if (ageSeconds >= GPS_FRESH_SECONDS) return "aging";
  return "fresh";
}

/**
 * LOC-03 first half: at 180 s the badge goes STALE and **ETA texts are suppressed**.
 * Still true in the `lost` band — stale-or-worse suppresses.
 */
export function suppressesEtaText(ageSeconds: number): boolean {
  const band = gpsBand(ageSeconds);
  return band === "stale" || band === "lost";
}

/**
 * LOC-03 second half: at 600 s a location-loss **exception** is raised and the
 * dispatcher is pinged. (Staff call after 10 more minutes — that timer belongs to
 * B-03's JobScheduler, not here.)
 */
export function raisesLocationLossException(ageSeconds: number): boolean {
  return gpsBand(ageSeconds) === "lost";
}

/**
 * Age of a position at a given clock instant, in seconds.
 *
 * Signed on purpose: a future-dated stamp gives a negative age, and {@link gpsBand} is the
 * one place that decides what to do about it. Clamping the age at 0 here used to hide a
 * skewed clock behind the freshest possible band. A stamp that is not a number gives NaN,
 * which reads as `lost` for the same reason.
 */
export function ageSecondsAt(recordedAtMs: number, nowMs: number): number {
  if (!Number.isFinite(recordedAtMs) || !Number.isFinite(nowMs)) return Number.NaN;
  return (nowMs - recordedAtMs) / 1000;
}
