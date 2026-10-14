import { describe, expect, it } from "vitest";
import {
  ageSecondsAt,
  gpsBand,
  GPS_FRESH_SECONDS,
  GPS_LOST_SECONDS,
  GPS_STALE_SECONDS,
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
  it("measures age in seconds and never goes negative", () => {
    expect(ageSecondsAt(1_000_000, 1_120_000)).toBe(120);
    expect(ageSecondsAt(1_120_000, 1_000_000)).toBe(0);
  });
});
