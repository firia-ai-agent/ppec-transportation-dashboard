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

/** The four ledger row 30 bands. */
export type GpsBand = "fresh" | "aging" | "stale" | "lost";

export function gpsBand(ageSeconds: number): GpsBand {
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

/** Age of a position at a given clock instant, in seconds (never negative). */
export function ageSecondsAt(recordedAtMs: number, nowMs: number): number {
  return Math.max(0, (nowMs - recordedAtMs) / 1000);
}
