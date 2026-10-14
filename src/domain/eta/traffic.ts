/**
 * Simulated traffic model (B-11).
 *
 * SOURCE: ADR-007 ("Traffic = deterministic multiplier per time band + fault
 * injection"; runtime never calls OSRM), MOCKS-AND-DEMO §5 (the ×1.5 traffic-band
 * fault button), PRD §8 (ETA = Σ route_time(traffic) …).
 *
 * The bands are **Unverified**: no traffic data was collected for Palm Beach County,
 * so they are a plausible commute shape, chosen to be deterministic rather than
 * accurate. Real traffic arrives with a traffic-aware provider behind the same seam
 * (Amazon Location, ADR-007). Times are ET, the project clock (DECISION-LEDGER).
 */

/** Times in this project are America/New_York unless stated (DECISION-LEDGER header). */
export const PROJECT_TIME_ZONE = "America/New_York";

export interface TrafficBand {
  id: string;
  /** Inclusive start, minutes from local midnight. */
  fromMinute: number;
  /** Exclusive end, minutes from local midnight. */
  toMinute: number;
  multiplier: number;
  label: string;
}

/** Deterministic bands, ET local time. Unverified (see the module note). */
export const TRAFFIC_BANDS: TrafficBand[] = [
  { id: "early", fromMinute: 0, toMinute: 6 * 60, multiplier: 1, label: "Overnight" },
  { id: "am-shoulder", fromMinute: 6 * 60, toMinute: 7 * 60, multiplier: 1.05, label: "Early morning" },
  { id: "am-peak", fromMinute: 7 * 60, toMinute: 9 * 60, multiplier: 1.25, label: "Morning peak" },
  { id: "midday", fromMinute: 9 * 60, toMinute: 15 * 60, multiplier: 1.05, label: "Midday" },
  { id: "pm-peak", fromMinute: 15 * 60, toMinute: 18 * 60, multiplier: 1.2, label: "Afternoon peak" },
  { id: "evening", fromMinute: 18 * 60, toMinute: 24 * 60, multiplier: 1, label: "Evening" },
];

const HOUR_MINUTE = new Intl.DateTimeFormat("en-US", {
  timeZone: PROJECT_TIME_ZONE,
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** Minutes from local (ET) midnight for an epoch-ms instant. */
export function minutesOfDayET(epochMs: number): number {
  const parts = HOUR_MINUTE.formatToParts(new Date(epochMs));
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0") % 24;
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  return hour * 60 + minute;
}

export function trafficBandAt(epochMs: number): TrafficBand {
  const minute = minutesOfDayET(epochMs);
  return (
    TRAFFIC_BANDS.find((b) => minute >= b.fromMinute && minute < b.toMinute) ??
    TRAFFIC_BANDS[TRAFFIC_BANDS.length - 1]
  );
}

/**
 * The multiplier the ETA engine applies to committed free-flow leg durations: the
 * time band, times any injected traffic fault (MOCKS §5 ×1.5).
 *
 * `injectedMultiplier` is the demo-panel fault, passed through rather than guessed at,
 * so an ETA can always be explained as "fixture duration × band × injected fault".
 */
export function trafficMultiplierAt(epochMs: number, injectedMultiplier = 1): number {
  return trafficBandAt(epochMs).multiplier * injectedMultiplier;
}
