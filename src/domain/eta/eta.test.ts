import { describe, expect, it } from "vitest";
import { ROUTE_1, ROUTE_2 } from "@/fixtures/routes";
import { measureRoute, stopHoldSeconds } from "@/domain/location/route";
import {
  computeEta,
  formatClock,
  formatDelta,
  formatWindow,
  uncertaintySeconds,
  UNCERTAINTY_FLOOR_SECONDS,
  UNCERTAINTY_FRACTION,
  windowFor,
  WINDOW_MINUTES,
} from "./eta";

/** 07:30 ET on 2026-10-14. */
const T0 = Date.UTC(2026, 9, 14, 11, 30, 0);
const R2 = measureRoute(ROUTE_2);
const R1 = measureRoute(ROUTE_1);

describe("uncertainty u (ASM-13: max(5 min, 15% remaining))", () => {
  it("floors at 5 minutes", () => {
    expect(UNCERTAINTY_FLOOR_SECONDS).toBe(300);
    expect(uncertaintySeconds(0)).toBe(300);
    expect(uncertaintySeconds(600)).toBe(300);
  });

  it("grows to 15% of a long remaining time", () => {
    expect(UNCERTAINTY_FRACTION).toBe(0.15);
    expect(uncertaintySeconds(4000)).toBeCloseTo(600, 6);
  });
});

describe("window text (PRD §8: a 10-minute window, never minute precision)", () => {
  it("snaps to the 10-minute bucket the ETA falls in", () => {
    expect(WINDOW_MINUTES).toBe(10);
    const window = windowFor(Date.UTC(2026, 9, 14, 11, 52, 31));
    expect(window.startMs).toBe(Date.UTC(2026, 9, 14, 11, 50, 0));
    expect(window.endMs).toBe(Date.UTC(2026, 9, 14, 12, 0, 0));
  });

  it("formats as '7:50–8:00 AM' (COPY-GUIDE l.36), in ET", () => {
    const window = windowFor(Date.UTC(2026, 9, 14, 11, 52, 31));
    expect(formatWindow(window.startMs, window.endMs)).toBe("7:50–8:00 AM");
  });

  it("carries both meridiems when a window straddles noon", () => {
    expect(
      formatWindow(Date.UTC(2026, 9, 14, 15, 50, 0), Date.UTC(2026, 9, 14, 16, 0, 0)),
    ).toBe("11:50 AM–12:00 PM");
  });

  it("never prints a minute-precision ETA", () => {
    const text = formatWindow(
      windowFor(Date.UTC(2026, 9, 14, 11, 52, 31)).startMs,
      windowFor(Date.UTC(2026, 9, 14, 11, 52, 31)).endMs,
    );
    expect(text).not.toContain("52");
  });
});

describe("delta text (COPY-GUIDE l.36)", () => {
  it("reads '+6 min', '−3 min' and 'On time'", () => {
    expect(formatDelta(360)).toBe("+6 min");
    expect(formatDelta(-180)).toBe("−3 min");
    expect(formatDelta(0)).toBe("On time");
    expect(formatDelta(20)).toBe("On time");
  });
});

describe("computeEta (PRD §8 formula over ADR-007 fixtures)", () => {
  const base = { measured: R2, nowMs: T0, trafficMultiplier: 1 };

  it("predicts the first pending stop from the committed leg duration alone", () => {
    const snapshot = computeEta({ ...base, alongM: 0 });
    const s1 = snapshot.stops[1];
    expect(s1.status).toBe("pending");
    expect(s1.driveSeconds).toBeCloseTo(ROUTE_2.legs[0].durationSec, 6);
    expect(s1.dwellSeconds).toBe(0);
    expect(s1.etaMs).toBe(T0 + ROUTE_2.legs[0].durationSec * 1000);
  });

  it("treats the run's origin as passed, with no dwell charged for it", () => {
    const snapshot = computeEta({ ...base, alongM: 0 });
    expect(snapshot.stops[0].status).toBe("passed");
    expect(snapshot.stops[0].etaMs).toBeUndefined();
  });

  it("adds dwell + service for every intermediate stop still ahead (ASM-12)", () => {
    const snapshot = computeEta({ ...base, alongM: 0 });
    const center = snapshot.stops[2];
    expect(center.dwellSeconds).toBe(stopHoldSeconds(ROUTE_2.stops[1]));
    expect(center.driveSeconds).toBeCloseTo(
      ROUTE_2.legs[0].durationSec + ROUTE_2.legs[1].durationSec,
      6,
    );
  });

  it("scales only the driving time by traffic, never the dwell", () => {
    const plain = computeEta({ ...base, alongM: 0 }).stops[2];
    const slow = computeEta({ ...base, alongM: 0, trafficMultiplier: 1.5 }).stops[2];
    expect(slow.driveSeconds).toBeCloseTo(plain.driveSeconds! * 1.5, 6);
    expect(slow.dwellSeconds).toBe(plain.dwellSeconds);
  });

  it("shrinks the drive time as the vehicle advances", () => {
    const half = R2.stopDistanceM[1] / 2;
    const snapshot = computeEta({ ...base, alongM: half });
    expect(snapshot.stops[1].driveSeconds).toBeCloseTo(ROUTE_2.legs[0].durationSec / 2, 0);
  });

  it("marks a stop arrived once the geofence says so, and gives it no ETA", () => {
    const snapshot = computeEta({
      ...base,
      alongM: R2.stopDistanceM[1],
      arrivalsMs: { S1: T0 },
    });
    expect(snapshot.stops[1].status).toBe("arrived");
    expect(snapshot.stops[1].etaMs).toBeUndefined();
    expect(snapshot.stops[2].status).toBe("pending");
  });

  it("shrinks the dwell still owed while the vehicle stands at a stop, so the ETA holds", () => {
    const alongM = R2.stopDistanceM[1];
    const arrivalsMs = { S1: T0 };
    const atArrival = computeEta({ ...base, alongM, arrivalsMs }).stops[2];
    const twoMinLater = computeEta({ ...base, alongM, nowMs: T0 + 120_000, arrivalsMs }).stops[2];
    expect(twoMinLater.dwellSeconds).toBeCloseTo(atArrival.dwellSeconds! - 120, 6);
    expect(twoMinLater.etaMs).toBe(atArrival.etaMs);
  });

  it("marks a stop passed when the vehicle is beyond it without an observed arrival", () => {
    const snapshot = computeEta({ ...base, alongM: R2.stopDistanceM[1] + 500 });
    expect(snapshot.stops[1].status).toBe("passed");
    expect(snapshot.stops[1].etaMs).toBeUndefined();
    expect(snapshot.stops[2].dwellSeconds).toBe(0);
  });

  it("applies hold = max(0, window_start − arrival) when a stop has a pickup window", () => {
    const windowed = {
      ...ROUTE_1,
      stops: [ROUTE_1.stops[0], { ...ROUTE_1.stops[1], windowStartOffsetSeconds: 1800 }],
    };
    const snapshot = computeEta({
      measured: measureRoute(windowed),
      alongM: 0,
      nowMs: T0,
      trafficMultiplier: 1,
      runStartMs: T0,
    });
    const center = snapshot.stops[1];
    expect(center.holdSeconds).toBeCloseTo(1800 - ROUTE_1.legs[0].durationSec, 6);
    expect(center.etaMs).toBe(T0 + 1800 * 1000);
  });

  it("is pure: the same input always gives the same snapshot", () => {
    const input = { measured: R1, alongM: 400, nowMs: T0, trafficMultiplier: 1.25 };
    expect(computeEta(input)).toEqual(computeEta(input));
  });

  it("gives every pending stop a window and an uncertainty", () => {
    for (const stop of computeEta({ ...base, alongM: 100 }).stops) {
      if (stop.status !== "pending") continue;
      expect(stop.windowText).toMatch(/^\d{1,2}:\d{2}(\s[AP]M)?–\d{1,2}:\d{2}\s[AP]M$/);
      expect(stop.uncertaintySeconds).toBeGreaterThanOrEqual(300);
      expect(stop.windowEndMs! - stop.windowStartMs!).toBe(WINDOW_MINUTES * 60_000);
    }
  });
});

describe("formatClock", () => {
  it("reads a single ET time (COPY-GUIDE l.36)", () => {
    expect(formatClock(Date.UTC(2026, 9, 14, 11, 42, 0))).toBe("7:42 AM");
    expect(formatClock(Date.UTC(2026, 9, 14, 20, 5, 0))).toBe("4:05 PM");
  });
});
