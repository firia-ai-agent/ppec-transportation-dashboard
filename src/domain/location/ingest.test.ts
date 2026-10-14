import { describe, expect, it } from "vitest";
import {
  displayablePosition,
  emptyIngestState,
  freshnessOf,
  ingestBatch,
  ingestPoint,
  MAX_FUTURE_SKEW_MS,
} from "./ingest";
import type { TelemetryPoint } from "./simulator";

const DEVICE = "DEV-V1";
const T0 = Date.UTC(2026, 9, 14, 11, 30, 0);

function point(offsetSeconds: number, over: Partial<TelemetryPoint> = {}): TelemetryPoint {
  return {
    deviceId: DEVICE,
    recordedAtMs: T0 + offsetSeconds * 1000,
    lat: 26.6 + offsetSeconds / 100_000,
    lon: -80.145,
    speedMps: 10,
    headingDeg: 0,
    bound: true,
    ...over,
  };
}

describe("dedupe on (device_id, recorded_at) (ADR-013, AT-11)", () => {
  it("accepts the first point and rejects a re-send of the same stamp", () => {
    const first = ingestPoint(emptyIngestState(), point(0));
    expect(first.outcome.status).toBe("accepted");
    const second = ingestPoint(first.state, point(0));
    expect(second.outcome).toEqual({ status: "rejected", reason: "duplicate" });
    expect(second.state.devices[DEVICE].counts).toMatchObject({ accepted: 1, duplicate: 1 });
  });

  it("does not treat another device's identical stamp as a duplicate", () => {
    const first = ingestPoint(emptyIngestState(), point(0));
    const other = ingestPoint(first.state, point(0, { deviceId: "DEV-V2" }));
    expect(other.outcome.status).toBe("accepted");
  });

  it("keeps the first copy: a duplicate never overwrites the stored position", () => {
    const { state } = ingestBatch(emptyIngestState(), [
      point(0),
      point(5),
      point(5, { lat: 99 }),
    ]);
    expect(displayablePosition(state, DEVICE)?.lat).not.toBe(99);
    expect(displayablePosition(state, DEVICE)?.recordedAtMs).toBe(T0 + 5000);
  });
});

describe("out-of-order points (AT-11)", () => {
  it("ignores a point older than the newest one held, and never rewinds", () => {
    const { state, outcomes } = ingestBatch(emptyIngestState(), [point(0), point(10), point(5)]);
    expect(outcomes.map((o) => o.status)).toEqual(["accepted", "accepted", "rejected"]);
    expect(displayablePosition(state, DEVICE)?.recordedAtMs).toBe(T0 + 10_000);
    expect(state.devices[DEVICE].counts.outOfOrder).toBe(1);
  });

  it("treats a later re-send of an ignored stamp as a duplicate, not a new point", () => {
    const { state } = ingestBatch(emptyIngestState(), [point(0), point(10), point(5)]);
    const again = ingestPoint(state, point(5));
    expect(again.outcome).toEqual({ status: "rejected", reason: "duplicate" });
  });

  it("accepts the swapped pair the simulator's out-of-order fault produces, in order", () => {
    // Emission order [t10, t5]: the later stamp lands first, the earlier is ignored.
    const { outcomes } = ingestBatch(emptyIngestState(), [point(10), point(5)]);
    expect(outcomes.map((o) => o.status)).toEqual(["accepted", "rejected"]);
  });
});

describe("unbound devices (LOC-01, ADR-013: stored bound=false, shown nowhere)", () => {
  const unbound = [point(0, { bound: false }), point(5, { bound: false })];

  it("stores them but never makes them displayable", () => {
    const { state, outcomes } = ingestBatch(emptyIngestState(), unbound);
    expect(outcomes.every((o) => o.status === "stored-unbound")).toBe(true);
    expect(state.devices[DEVICE].unbound).toHaveLength(2);
    expect(displayablePosition(state, DEVICE)).toBeUndefined();
    expect(state.devices[DEVICE].counts).toMatchObject({ accepted: 0, unbound: 2 });
  });

  it("reads as a location loss rather than as fresh", () => {
    const { state } = ingestBatch(emptyIngestState(), unbound);
    const freshness = freshnessOf(state, DEVICE, T0 + 5000);
    expect(freshness.band).toBe("lost");
    expect(freshness.etaTextSuppressed).toBe(true);
    expect(freshness.exceptionRaised).toBe(true);
    expect(freshness.ageSeconds).toBeUndefined();
  });

  it("still dedupes: an unbound re-send is a duplicate", () => {
    const { state } = ingestBatch(emptyIngestState(), unbound);
    expect(ingestPoint(state, unbound[0]).outcome).toEqual({
      status: "rejected",
      reason: "duplicate",
    });
  });

  it("does not block the same device once it is bound again", () => {
    const { state } = ingestBatch(emptyIngestState(), unbound);
    expect(ingestPoint(state, point(10)).outcome.status).toBe("accepted");
  });
});

describe("freshness of a device (ledger row 30 bands, LOC-03 effects)", () => {
  it("reports the band of the newest displayable point", () => {
    const { state } = ingestBatch(emptyIngestState(), [point(0)]);
    expect(freshnessOf(state, DEVICE, T0 + 30_000)).toMatchObject({
      band: "fresh",
      etaTextSuppressed: false,
      exceptionRaised: false,
      ageSeconds: 30,
    });
    expect(freshnessOf(state, DEVICE, T0 + 200_000)).toMatchObject({
      band: "stale",
      etaTextSuppressed: true,
      exceptionRaised: false,
    });
    expect(freshnessOf(state, DEVICE, T0 + 700_000)).toMatchObject({
      band: "lost",
      etaTextSuppressed: true,
      exceptionRaised: true,
    });
  });

  it("treats a device that has never reported as lost", () => {
    expect(freshnessOf(emptyIngestState(), "DEV-NEW", T0).band).toBe("lost");
  });
});

describe("state handling", () => {
  it("is a pure reducer: the input state is never mutated", () => {
    const state = emptyIngestState();
    const next = ingestPoint(state, point(0)).state;
    expect(state.devices).toEqual({});
    expect(next).not.toBe(state);
  });

  it("gives every stored point a monotone sequence number", () => {
    const { state } = ingestBatch(emptyIngestState(), [point(0), point(5), point(10)]);
    expect(state.sequence).toBe(3);
    expect(displayablePosition(state, DEVICE)?.sequence).toBe(3);
  });
});

describe("a stamp that is not a usable instant (reviewer: NaN timestamps)", () => {
  it("rejects it outright instead of letting it become the device's position", () => {
    const { state, outcome } = ingestPoint(emptyIngestState(), point(0, { recordedAtMs: Number.NaN }));
    expect(outcome).toEqual({ status: "rejected", reason: "invalid-timestamp" });
    expect(displayablePosition(state, DEVICE)).toBeUndefined();
    expect(state.devices[DEVICE].counts).toMatchObject({ accepted: 0, invalidTimestamp: 1 });
    // Rejected before the dedupe key, so it took no sequence number either.
    expect(state.sequence).toBe(0);
  });

  it("rejects an infinite stamp the same way", () => {
    const { outcome } = ingestPoint(
      emptyIngestState(),
      point(0, { recordedAtMs: Number.POSITIVE_INFINITY }),
    );
    expect(outcome).toEqual({ status: "rejected", reason: "invalid-timestamp" });
  });

  it("does not block the real points that follow it", () => {
    const { state, outcomes } = ingestBatch(emptyIngestState(), [
      point(0, { recordedAtMs: Number.NaN }),
      point(0),
      point(5),
    ]);
    expect(outcomes.map((o) => o.status)).toEqual(["rejected", "accepted", "accepted"]);
    expect(displayablePosition(state, DEVICE)?.recordedAtMs).toBe(T0 + 5000);
    expect(freshnessOf(state, DEVICE, T0 + 5000).band).toBe("fresh");
  });
});

describe("a stamp from the future (reviewer: a skewed point must not block real ones)", () => {
  /** Our own clock while the batch arrives. */
  const now = T0 + 10_000;

  it("tolerates skew up to the named constant and refuses anything past it", () => {
    expect(MAX_FUTURE_SKEW_MS).toBe(60_000);
    const justInside = point(0, { recordedAtMs: now + MAX_FUTURE_SKEW_MS });
    expect(ingestPoint(emptyIngestState(), justInside, { nowMs: now }).outcome.status).toBe("accepted");

    const justOutside = point(0, { recordedAtMs: now + MAX_FUTURE_SKEW_MS + 1 });
    const { state, outcome } = ingestPoint(emptyIngestState(), justOutside, { nowMs: now });
    expect(outcome).toEqual({ status: "rejected", reason: "future-dated" });
    expect(displayablePosition(state, DEVICE)).toBeUndefined();
    expect(state.devices[DEVICE].counts).toMatchObject({ accepted: 0, futureDated: 1 });
  });

  it("a skewed point, then a real later point: the real one is accepted", () => {
    // The whole point of the rule. With the skewed stamp stored as `latest`, every real
    // point behind it looked out-of-order, so one broken device clock silently froze the
    // vehicle on the map for the rest of the run.
    const skewed = point(0, { recordedAtMs: now + 6 * 60 * 60 * 1000 }); // six hours ahead
    const { state, outcomes } = ingestBatch(
      emptyIngestState(),
      [skewed, point(15), point(20)],
      { nowMs: now + 20_000 },
    );
    expect(outcomes.map((o) => o.status)).toEqual(["rejected", "accepted", "accepted"]);
    expect(displayablePosition(state, DEVICE)?.recordedAtMs).toBe(T0 + 20_000);
    expect(state.devices[DEVICE].counts).toMatchObject({ accepted: 2, outOfOrder: 0, futureDated: 1 });
    expect(freshnessOf(state, DEVICE, T0 + 20_000).band).toBe("fresh");
  });

  it("does not record the skewed stamp as seen, so a corrected re-send is still new", () => {
    const skewed = point(0, { recordedAtMs: now + 10 * 60 * 1000 });
    const { state } = ingestPoint(emptyIngestState(), skewed, { nowMs: now });
    // The same stamp, once our clock has caught up with it, is a position and not a duplicate.
    const later = ingestPoint(state, skewed, { nowMs: skewed.recordedAtMs });
    expect(later.outcome.status).toBe("accepted");
  });

  it("without a clock there is nothing to call the future, so the check is skipped", () => {
    // The replay engine has no arrival clock of its own — a simulated point's stamp *is* the
    // scenario clock — so it passes no `nowMs`, and ingest behaves exactly as it always did.
    const ahead = point(0, { recordedAtMs: now + 6 * 60 * 60 * 1000 });
    expect(ingestPoint(emptyIngestState(), ahead).outcome.status).toBe("accepted");
  });
});
