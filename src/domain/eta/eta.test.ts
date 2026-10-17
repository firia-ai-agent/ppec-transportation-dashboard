import { describe, expect, it } from "vitest";
import { ROUTE_1, ROUTE_2 } from "@/fixtures/routes";
import { measureRoute, stopHoldSeconds } from "@/domain/location/route";
import {
  computeEta,
  formatClock,
  formatDelta,
  formatWindow,
  plannedEta,
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

  /**
   * 2026-11-01 is the autumn fall-back: at 2:00 AM EDT the local clock goes back to
   * 1:00 AM EST, so 1:00–1:59 AM happens twice. Pinned by UTC instants, so these assertions
   * hold whatever TZ the test runner is started with — ET is the project clock
   * (PROJECT_TIME_ZONE), not the machine's.
   */
  describe("the DST fall-back hour (2026-11-01, America/New_York)", () => {
    /** 1:50 AM EDT = 05:50 UTC; ten minutes later is 1:00 AM EST = 06:00 UTC. */
    const fallBackStart = Date.UTC(2026, 10, 1, 5, 50, 0);
    const fallBackEnd = Date.UTC(2026, 10, 1, 6, 0, 0);

    it("names the offset on both ends instead of reading backwards", () => {
      // It used to render "1:50–1:00 AM", which tells a family to expect the van an hour
      // before it leaves.
      expect(formatWindow(fallBackStart, fallBackEnd)).toBe("1:50 AM EDT–1:00 AM EST");
      expect(formatWindow(fallBackStart, fallBackEnd)).not.toBe("1:50–1:00 AM");
    });

    it("reads forwards: the clock on the left is earlier than the clock on the right", () => {
      const text = formatWindow(fallBackStart, fallBackEnd);
      const [left, right] = text.split("–");
      // Monotone in the only sense that survives a repeated hour: each end carries the
      // offset that tells you which of the two 1 o'clocks it is.
      expect(left).toContain("EDT");
      expect(right).toContain("EST");
      expect(fallBackStart).toBeLessThan(fallBackEnd);
    });

    it("disambiguates a window wholly inside the repeated hour, not just the fold", () => {
      // 1:10–1:20 AM happens twice: once EDT (05:10 UTC) and once EST (06:10 UTC). Both
      // ends share an offset in each case, so only naming the zone tells them apart.
      const firstPass = formatWindow(Date.UTC(2026, 10, 1, 5, 10, 0), Date.UTC(2026, 10, 1, 5, 20, 0));
      const secondPass = formatWindow(Date.UTC(2026, 10, 1, 6, 10, 0), Date.UTC(2026, 10, 1, 6, 20, 0));
      expect(firstPass).toBe("1:10 AM EDT–1:20 AM EDT");
      expect(secondPass).toBe("1:10 AM EST–1:20 AM EST");
      expect(firstPass).not.toBe(secondPass);
    });

    it("walks the whole repeated hour without ever printing the same window twice", () => {
      const bucket = WINDOW_MINUTES * 60 * 1000;
      const texts: string[] = [];
      // 12:30 AM EDT through 2:00 AM EST: every 10-minute window across the fold.
      for (let t = Date.UTC(2026, 10, 1, 4, 30, 0); t < Date.UTC(2026, 10, 1, 7, 0, 0); t += bucket) {
        texts.push(formatWindow(t, t + bucket));
      }
      expect(new Set(texts).size).toBe(texts.length);
      expect(texts).toContain("1:50 AM EDT–1:00 AM EST");
    });

    it("leaves an ordinary window alone: no offset where there is nothing to disambiguate", () => {
      const window = windowFor(Date.UTC(2026, 9, 14, 11, 52, 31));
      expect(formatWindow(window.startMs, window.endMs)).toBe("7:50–8:00 AM");
      expect(formatWindow(window.startMs, window.endMs)).not.toMatch(/EDT|EST/);
    });

    it("spring-forward needs nothing: that hour does not exist, so no reading repeats", () => {
      // 2026-03-08: 1:50 AM EST (06:50 UTC) + 10 min is 3:00 AM EDT (07:00 UTC).
      expect(
        formatWindow(Date.UTC(2026, 2, 8, 6, 50, 0), Date.UTC(2026, 2, 8, 7, 0, 0)),
      ).toBe("1:50 AM EST–3:00 AM EDT");
    });
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

  it("says a shift is not known rather than printing '−NaN min'", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(formatDelta(bad)).toBe("Not known yet");
      expect(formatDelta(bad)).not.toMatch(/NaN|Infinity/);
      expect(formatDelta(bad)).not.toMatch(/min$/);
    }
    // And it is not quietly "On time" either: that would be a claim, not an answer.
    expect(formatDelta(Number.NaN)).not.toBe("On time");
  });

  it("every delta it can print carries a sign or says it is on time", () => {
    for (const seconds of [-3600, -61, -60, -31, 0, 31, 60, 3600, Number.NaN]) {
      expect(formatDelta(seconds)).toMatch(/^(?:\+\d+ min|−\d+ min|On time|Not known yet)$/);
    }
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

/**
 * The window a family holds before the van has moved (PRD §8). This is what every afternoon ride
 * on the board is showing, so the two things that matter are that it is the same formula as a
 * live calculation and that it never pretends to be one.
 */
describe("plannedEta (the plan's own windows)", () => {
  const planned = plannedEta({ measured: R2, departureMs: T0, trafficMultiplier: 1 });

  it("serves the origin at the departure itself, and gives it a window too", () => {
    // computeEta cannot answer this: a vehicle at chainage 0 has already "passed" its first
    // stop, and the first family of a morning run is exactly the one at chainage 0.
    expect(planned[0].stopId).toBe(ROUTE_2.stops[0].id);
    expect(planned[0].etaMs).toBe(T0);
    expect(planned[0].windowText).toMatch(/^\d{1,2}:\d{2}(\s[AP]M)?–\d{1,2}:\d{2}\s[AP]M$/);
  });

  it("adds the committed drive time, then dwell and service at the stops in between", () => {
    const [legA, legB] = ROUTE_2.legs;
    expect(planned[1].etaMs).toBe(T0 + legA.durationSec * 1000);
    expect(planned[2].etaMs).toBe(
      T0 + (legA.durationSec + legB.durationSec + stopHoldSeconds(ROUTE_2.stops[1])) * 1000,
    );
    // The origin carries no dwell: a run begins at its departure, loaded.
    expect(planned[1].dwellSeconds).toBe(0);
  });

  it("multiplies only the driving by traffic", () => {
    const peak = plannedEta({ measured: R2, departureMs: T0, trafficMultiplier: 1.25 });
    expect(peak[1].driveSeconds).toBeCloseTo(ROUTE_2.legs[0].durationSec * 1.25, 6);
    expect(peak[2].dwellSeconds).toBe(stopHoldSeconds(ROUTE_2.stops[1]));
  });

  it("claims nothing a plan cannot know: every stop is pending, and no stop holds", () => {
    for (const stop of planned) {
      expect(stop.status).toBe("pending");
      expect(stop.holdSeconds).toBe(0);
      expect(stop.uncertaintySeconds).toBeGreaterThanOrEqual(UNCERTAINTY_FLOOR_SECONDS);
      expect(stop.windowEndMs! - stop.windowStartMs!).toBe(WINDOW_MINUTES * 60_000);
    }
  });

  it("is pure: the same plan is the same windows", () => {
    expect(plannedEta({ measured: R2, departureMs: T0, trafficMultiplier: 1 })).toEqual(planned);
  });
});

describe("formatClock", () => {
  it("reads a single ET time (COPY-GUIDE l.36)", () => {
    expect(formatClock(Date.UTC(2026, 9, 14, 11, 42, 0))).toBe("7:42 AM");
    expect(formatClock(Date.UTC(2026, 9, 14, 20, 5, 0))).toBe("4:05 PM");
  });
});
