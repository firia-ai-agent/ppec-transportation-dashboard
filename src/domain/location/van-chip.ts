/**
 * The one state chip a van shows on the Live map (goal 5; mockups/live-map.html, png/live-map.png,
 * png/live-map-390.png): exactly one of On route, At stop, Late, No GPS, and never an ETA.
 *
 * Pure: the van's GPS age, whether it is inside a stop's geofence, and whether the saved plan's
 * leg is behind, in; one chip out. Order of precedence, worst first:
 *  1. No GPS — the fix is stale or lost (LOC-03 bands, src/domain/location/freshness.ts). A van
 *     we cannot see is never reported as on time.
 *  2. Late — the leg is behind its planned time.
 *  3. At stop — inside a stop geofence.
 *  4. On route — everything else.
 */
import { gpsBand } from "./freshness";

export const VAN_CHIPS = ["onRoute", "atStop", "late", "noGps"] as const;
export type VanChip = (typeof VAN_CHIPS)[number];

export type VanChipInput = {
  /** Seconds since the last accepted fix; NaN/Infinity when the van has never reported. */
  gpsAgeSeconds: number;
  /** Inside a planned stop's geofence right now. */
  atStop: boolean;
  /** The saved plan's leg for this van is running behind. */
  behind: boolean;
};

export function vanChipOf({ gpsAgeSeconds, atStop, behind }: VanChipInput): VanChip {
  const band = gpsBand(gpsAgeSeconds);
  if (band === "stale" || band === "lost") return "noGps";
  if (behind) return "late";
  if (atStop) return "atStop";
  return "onRoute";
}
