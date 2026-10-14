import { describe, expect, it } from "vitest";
import {
  ageSecondsAt,
  gpsBand,
  GPS_FRESH_SECONDS,
  GPS_LOST_SECONDS,
  GPS_STALE_SECONDS,
  MAX_FUTURE_SKEW_MS,
  raisesLocationLossException,
  suppressesEtaText,
} from "./freshness";

describe("the four freshness bands (DECISION-LEDGER row 30, Decided by founder)", () => {
  it("bands at 60 / 180 / 600 s, with each boundary belonging to the worse band", () => {
    expect([GPS_FRESH_SECONDS, GPS_STALE_SECONDS, GPS_LOST_SECONDS]).toEqual([60, 180, 600]);
    expect(gpsBand(0)).toBe("fresh");
    expect(gpsBand(59.9)).toBe("fresh");
    expect(gpsBand(60)).toBe("aging");
    expect(gpsBand(179.9)).toBe("aging");
    expect(gpsBand(180)).toBe("stale");
    expect(gpsBand(599.9)).toBe("stale");
    expect(gpsBand(600)).toBe("lost");
    expect(gpsBand(36_000)).toBe("lost");
  });

  it("suppresses ETA texts from 180 s and never before (LOC-03)", () => {
    expect(suppressesEtaText(179)).toBe(false);
    expect(suppressesEtaText(180)).toBe(true);
    expect(suppressesEtaText(599)).toBe(true);
    expect(suppressesEtaText(600)).toBe(true);
  });

  it("raises the location-loss exception from 600 s and never before (LOC-03)", () => {
    expect(raisesLocationLossException(599)).toBe(false);
    expect(raisesLocationLossException(600)).toBe(true);
  });
});

describe("ageSecondsAt", () => {
  it("measures age in seconds", () => {
    expect(ageSecondsAt(1_000_000, 1_120_000)).toBe(120);
  });

  it("reports a future-dated stamp as a negative age rather than clamping it to 0", () => {
    // Clamping at 0 here was the bug: it handed `gpsBand` the freshest age it has, so a
    // skewed clock read "Live · 0 s". The sign is kept, and gpsBand decides what it means.
    expect(ageSecondsAt(1_120_000, 1_000_000)).toBe(-120);
  });

  it("is NaN when either instant is not a number", () => {
    expect(ageSecondsAt(Number.NaN, 1_000_000)).toBeNaN();
    expect(ageSecondsAt(1_000_000, Number.NaN)).toBeNaN();
  });
});

describe("ages that are not ages (reviewer: NaN and future stamps read fresh)", () => {
  it("reads a non-finite age as no signal, not as the freshest band", () => {
    expect(gpsBand(Number.NaN)).toBe("lost");
    expect(gpsBand(Number.POSITIVE_INFINITY)).toBe("lost");
    expect(suppressesEtaText(Number.NaN)).toBe(true);
    expect(raisesLocationLossException(Number.NaN)).toBe(true);
  });

  it("tolerates small clock skew and refuses the rest", () => {
    expect(MAX_FUTURE_SKEW_MS).toBe(60_000);
    // Inside the tolerated skew, a stamp a moment ahead of us is still this second's position.
    expect(gpsBand(-1)).toBe("fresh");
    expect(gpsBand(-MAX_FUTURE_SKEW_MS / 1000)).toBe("fresh");
    // Beyond it, the device clock is wrong and the point says nothing about where it is now.
    expect(gpsBand(-MAX_FUTURE_SKEW_MS / 1000 - 0.001)).toBe("lost");
    expect(gpsBand(-3600)).toBe("lost");
    expect(suppressesEtaText(-3600)).toBe(true);
    expect(raisesLocationLossException(-3600)).toBe(true);
  });

  it("a position stamped in the future never reads Live through ageSecondsAt", () => {
    const nowMs = Date.UTC(2026, 9, 14, 11, 30, 0);
    const skewed = nowMs + 2 * 60 * 60 * 1000; // two hours ahead
    expect(gpsBand(ageSecondsAt(skewed, nowMs))).toBe("lost");
  });
});
