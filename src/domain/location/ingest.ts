/**
 * LocationIngest (B-10) — the seam every position enters through.
 *
 * SOURCE: ADR-013 (dedupe on `(device_id, recorded_at)`; unbound devices stored with
 * `bound=false` and never displayed), PRD LOC-01 / LOC-03, AT-11 (duplicate and
 * out-of-order points, 180 s / 600 s location loss), DECISION-LEDGER row 30.
 *
 * Pure reducer, no database: `ingestPoint` takes the accumulated state and one point
 * and returns new state plus the decision. The SQL form of exactly this rule is
 * ARCHITECTURE §6's `INSERT ... ON CONFLICT (device_id, recorded_at) DO NOTHING`, and
 * the M5 work is deliberately DB-free (no migrations, no seeds).
 */

import { ageSecondsAt, gpsBand, raisesLocationLossException, suppressesEtaText, type GpsBand } from "./freshness";
import type { TelemetryPoint } from "./simulator";

/** Why a point did not become the device's new position. */
export type RejectReason =
  /** Same `(device_id, recorded_at)` as a point already held (ADR-013). */
  | "duplicate"
  /** Older than the newest point already held: ignored, never rewinds the vehicle. */
  | "out-of-order";

export type IngestOutcome =
  | { status: "accepted"; point: StoredPoint }
  /** Stored for audit with `bound=false`; shown nowhere (LOC-01). */
  | { status: "stored-unbound"; point: StoredPoint }
  | { status: "rejected"; reason: RejectReason };

export interface StoredPoint extends TelemetryPoint {
  /** Monotone arrival index, so "stored order" is observable in tests. */
  sequence: number;
}

export interface DeviceState {
  deviceId: string;
  /** Newest accepted *bound* point — the only position any surface may display. */
  latest?: StoredPoint;
  /** `recorded_at` values seen for this device; the dedupe key's other half. */
  seenRecordedAtMs: ReadonlySet<number>;
  /** Append-only audit of unbound points. Never displayed, never fed to the ETA engine. */
  unbound: readonly StoredPoint[];
  counts: {
    accepted: number;
    duplicate: number;
    outOfOrder: number;
    unbound: number;
  };
}

export interface IngestState {
  devices: Readonly<Record<string, DeviceState>>;
  sequence: number;
}

export function emptyIngestState(): IngestState {
  return { devices: {}, sequence: 0 };
}

function deviceOrEmpty(state: IngestState, deviceId: string): DeviceState {
  return (
    state.devices[deviceId] ?? {
      deviceId,
      seenRecordedAtMs: new Set<number>(),
      unbound: [],
      counts: { accepted: 0, duplicate: 0, outOfOrder: 0, unbound: 0 },
    }
  );
}

function withDevice(state: IngestState, device: DeviceState, sequence: number): IngestState {
  return { devices: { ...state.devices, [device.deviceId]: device }, sequence };
}

/**
 * Ingest one point.
 *
 * Order of checks matters and matches ADR-013: the dedupe key is checked first (a
 * re-sent point is a duplicate whether or not the device is bound), then the binding,
 * then monotonicity.
 */
export function ingestPoint(
  state: IngestState,
  point: TelemetryPoint,
): { state: IngestState; outcome: IngestOutcome } {
  const device = deviceOrEmpty(state, point.deviceId);

  if (device.seenRecordedAtMs.has(point.recordedAtMs)) {
    const next: DeviceState = {
      ...device,
      counts: { ...device.counts, duplicate: device.counts.duplicate + 1 },
    };
    return {
      state: withDevice(state, next, state.sequence),
      outcome: { status: "rejected", reason: "duplicate" },
    };
  }

  const sequence = state.sequence + 1;
  const stored: StoredPoint = { ...point, sequence };
  const seen = new Set(device.seenRecordedAtMs);
  seen.add(point.recordedAtMs);

  if (!point.bound) {
    // LOC-01 / ADR-013: kept for audit, excluded from `latest`, so no surface and no
    // ETA calculation can ever see it.
    const next: DeviceState = {
      ...device,
      seenRecordedAtMs: seen,
      unbound: [...device.unbound, stored],
      counts: { ...device.counts, unbound: device.counts.unbound + 1 },
    };
    return {
      state: withDevice(state, next, sequence),
      outcome: { status: "stored-unbound", point: stored },
    };
  }

  if (device.latest && point.recordedAtMs < device.latest.recordedAtMs) {
    // AT-11: a late arrival never rewinds the vehicle. The `recorded_at` is still
    // recorded as seen, so its eventual re-send is a duplicate.
    const next: DeviceState = {
      ...device,
      seenRecordedAtMs: seen,
      counts: { ...device.counts, outOfOrder: device.counts.outOfOrder + 1 },
    };
    return {
      state: withDevice(state, next, sequence),
      outcome: { status: "rejected", reason: "out-of-order" },
    };
  }

  const next: DeviceState = {
    ...device,
    latest: stored,
    seenRecordedAtMs: seen,
    counts: { ...device.counts, accepted: device.counts.accepted + 1 },
  };
  return { state: withDevice(state, next, sequence), outcome: { status: "accepted", point: stored } };
}

/** Fold a batch in arrival order. The outcome list lines up with `points`. */
export function ingestBatch(
  state: IngestState,
  points: readonly TelemetryPoint[],
): { state: IngestState; outcomes: IngestOutcome[] } {
  let current = state;
  const outcomes: IngestOutcome[] = [];
  for (const point of points) {
    const step = ingestPoint(current, point);
    current = step.state;
    outcomes.push(step.outcome);
  }
  return { state: current, outcomes };
}

/**
 * What a surface may display for a device, or `undefined` when there is nothing
 * displayable — an unbound device included (LOC-01: "stored, shown nowhere").
 */
export function displayablePosition(state: IngestState, deviceId: string): StoredPoint | undefined {
  return state.devices[deviceId]?.latest;
}

export interface FreshnessStatus {
  deviceId: string;
  /** `undefined` when the device has never produced a displayable point. */
  ageSeconds?: number;
  band: GpsBand;
  /** LOC-03: ETA texts are suppressed from 180 s. */
  etaTextSuppressed: boolean;
  /** LOC-03: a location-loss exception + dispatcher ping from 600 s. */
  exceptionRaised: boolean;
}

/**
 * Freshness of a device at a clock instant (DECISION-LEDGER row 30 bands, LOC-03
 * effects). A device with no displayable position reads as `lost`: an unbound or
 * silent device is a location loss, not a fresh one.
 */
export function freshnessOf(state: IngestState, deviceId: string, nowMs: number): FreshnessStatus {
  const latest = displayablePosition(state, deviceId);
  if (!latest) {
    return {
      deviceId,
      band: "lost",
      etaTextSuppressed: true,
      exceptionRaised: true,
    };
  }
  const ageSeconds = ageSecondsAt(latest.recordedAtMs, nowMs);
  return {
    deviceId,
    ageSeconds,
    band: gpsBand(ageSeconds),
    etaTextSuppressed: suppressesEtaText(ageSeconds),
    exceptionRaised: raisesLocationLossException(ageSeconds),
  };
}
