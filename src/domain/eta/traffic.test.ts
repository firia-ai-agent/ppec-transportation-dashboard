import { describe, expect, it } from "vitest";
import { minutesOfDayET, TRAFFIC_BANDS, trafficBandAt, trafficMultiplierAt } from "./traffic";

/** 2026-10-14 is EDT (UTC−4), so 11:30 UTC is 07:30 ET. */
const at = (hUtc: number, mUtc = 0) => Date.UTC(2026, 9, 14, hUtc, mUtc, 0);

describe("minutesOfDayET", () => {
  it("reads the local ET time, not UTC", () => {
    expect(minutesOfDayET(at(11, 30))).toBe(7 * 60 + 30);
    expect(minutesOfDayET(at(4, 0))).toBe(0);
  });

  it("follows the offset across the DST boundary", () => {
    // 2026-11-01 02:00 ET ends EDT; 12:00 UTC is 08:00 EDT in October, 07:00 EST in November.
    expect(minutesOfDayET(Date.UTC(2026, 9, 14, 12, 0, 0))).toBe(8 * 60);
    expect(minutesOfDayET(Date.UTC(2026, 10, 14, 12, 0, 0))).toBe(7 * 60);
  });
});

describe("traffic bands (ADR-007: deterministic multiplier per time band)", () => {
  it("covers the whole day with no gap and no overlap", () => {
    expect(TRAFFIC_BANDS[0].fromMinute).toBe(0);
    expect(TRAFFIC_BANDS[TRAFFIC_BANDS.length - 1].toMinute).toBe(24 * 60);
    for (let i = 1; i < TRAFFIC_BANDS.length; i += 1) {
      expect(TRAFFIC_BANDS[i].fromMinute).toBe(TRAFFIC_BANDS[i - 1].toMinute);
    }
  });

  it("slows the morning and afternoon peaks and leaves the night alone", () => {
    expect(trafficBandAt(at(11, 30)).id).toBe("am-peak"); // 07:30 ET
    expect(trafficBandAt(at(11, 30)).multiplier).toBe(1.25);
    expect(trafficBandAt(at(20, 0)).id).toBe("pm-peak"); // 16:00 ET
    expect(trafficBandAt(at(6, 0)).multiplier).toBe(1); // 02:00 ET
  });

  it("never speeds a vehicle up", () => {
    for (const band of TRAFFIC_BANDS) expect(band.multiplier).toBeGreaterThanOrEqual(1);
  });

  it("is deterministic: the same instant always gives the same multiplier", () => {
    expect(trafficMultiplierAt(at(11, 30))).toBe(trafficMultiplierAt(at(11, 30)));
  });

  it("multiplies the injected ×1.5 fault on top of the band (MOCKS §5)", () => {
    expect(trafficMultiplierAt(at(11, 30), 1.5)).toBeCloseTo(1.25 * 1.5, 10);
    expect(trafficMultiplierAt(at(6, 0), 1.5)).toBeCloseTo(1.5, 10);
  });
});
