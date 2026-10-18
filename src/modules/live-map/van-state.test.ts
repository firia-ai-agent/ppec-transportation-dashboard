/**
 * ONE CHIP PER VAN, derived from GPS fixes — and never an ETA.
 *
 * Layer 2 (behaviour), per /workspace/ppec-redesign/MOCKUP-TEST-CONTRACT.md: the rule, not the
 * mockup, decides. The rules these assert, each cited where it is asserted:
 *
 *  - **docs/DATA-MODEL.md "Location & freshness" (LOC-03)** — the GPS age bands. A fix older
 *    than the stale band is a van we cannot see, and a van we cannot see is never reported as on
 *    time. The bands themselves live in src/config/live.ts and are tested in
 *    src/domain/location/freshness.test.ts; what is tested here is that the *chip* obeys them.
 *  - **ASM-18 / the geofence (src/domain/location/geofence.ts)** — "At stop" is the same 100 m
 *    radius the arrival detector uses, so the chip and the ingest cannot disagree about whether
 *    a van has arrived.
 *  - **PRD §8 / `notifyGateConfig.shiftSeconds`** — "Late" is the same 10 minutes that decides a
 *    family is owed a text. One threshold: a van cannot be late on the map while the outbox
 *    thinks it is on time.
 *  - **Firia, goal-5 brief** — exactly one of On route / At stop / Late / No GPS, and no ETA.
 *
 * The last test is the one that earns its keep: it walks the whole simulated day, every 15
 * scenario-seconds, and asserts that all four chips actually occur. A derivation that can only
 * ever return two of its four values is a screen with two states on it, and no browser check
 * sampling a few instants would catch that.
 */
import { describe, expect, it } from "vitest";
import { notifyGateConfig } from "@/config/live";
import type { StopEta } from "@/domain/eta/eta";
import type { FrameStop } from "@/domain/eta/replay";
import { GEOFENCE_RADIUS_M } from "@/domain/location/geofence";
import { GPS_STALE_SECONDS } from "@/domain/location/freshness";
import { VAN_CHIPS } from "@/domain/location/van-chip";
import { offsetByMeters, type Coord } from "@/domain/location/geo";
import { DEMO_RUN_SECONDS } from "@/fixtures/replays";
import { liveDayAt } from "./day";
import {
  atStopOf,
  behindSecondsOf,
  bySeverity,
  countsOf,
  LATE_SECONDS,
  matchesFilter,
  vanStateOf,
} from "./van-state";

const STOP: Coord = [-80.145541, 26.645352];
const STOPS = [{ id: "S1", coord: STOP }];
/** Far from every stop, so only the GPS age and the schedule are in play. */
const AWAY: Coord = offsetByMeters(STOP, 5_000, 5_000);

function pending(etaMs: number): FrameStop[] {
  return [{ stopId: "S1", stopName: "Somewhere", status: "pending", etaMs }];
}
function promised(etaMs: number): StopEta[] {
  return [{ stopIndex: 0, stopId: "S1", stopName: "Somewhere", status: "pending", etaMs }];
}

describe("At stop is the geofence, not a second idea of arriving (ASM-18)", () => {
  it("is true inside the radius the arrival detector uses", () => {
    expect(atStopOf(offsetByMeters(STOP, GEOFENCE_RADIUS_M - 10, 0), STOPS)).toBe(true);
  });

  it("is false outside it", () => {
    expect(atStopOf(offsetByMeters(STOP, GEOFENCE_RADIUS_M + 50, 0), STOPS)).toBe(false);
  });

  it("is false for a van whose run has no stops left to be at", () => {
    expect(atStopOf(STOP, [])).toBe(false);
  });
});

describe("Late is the notify gate's own threshold (PRD §8)", () => {
  it("measures the next stop still owed, against what the plan promised it", () => {
    const base = Date.UTC(2026, 9, 14, 12, 0, 0);
    expect(behindSecondsOf(pending(base + 600_000), promised(base))).toBe(600);
  });

  /* A delay only moves what is still ahead (PRD §8, "downstream families"). */
  it("ignores stops already arrived at or passed", () => {
    const base = Date.UTC(2026, 9, 14, 12, 0, 0);
    const current: FrameStop[] = [
      { stopId: "S0", stopName: "Behind us", status: "passed", etaMs: base + 9_999_999 },
      { stopId: "S1", stopName: "Somewhere", status: "pending", etaMs: base },
    ];
    expect(behindSecondsOf(current, promised(base))).toBe(0);
  });

  it("is never negative: a van running early is not late by a negative amount", () => {
    const base = Date.UTC(2026, 9, 14, 12, 0, 0);
    expect(behindSecondsOf(pending(base - 600_000), promised(base))).toBe(0);
  });

  it("says 0 rather than guessing when either side has no time on it", () => {
    expect(behindSecondsOf([], [])).toBe(0);
    expect(behindSecondsOf(pending(1), [])).toBe(0);
  });

  it("is the same 10 minutes that decides a family is owed a text", () => {
    expect(LATE_SECONDS).toBe(notifyGateConfig.shiftSeconds);
  });
});

describe("the one chip, in the order of precedence the brief sets", () => {
  const base = Date.UTC(2026, 9, 14, 12, 0, 0);
  const onTime = { current: pending(base), planned: promised(base) };
  const behind = { current: pending(base + LATE_SECONDS * 1000), planned: promised(base) };

  it("is On route for a fresh fix, away from a stop, on schedule", () => {
    expect(vanStateOf({ gpsAgeSeconds: 10, coord: AWAY, stops: STOPS, ...onTime })).toBe("onRoute");
  });

  it("is At stop for a fresh fix inside a geofence", () => {
    expect(vanStateOf({ gpsAgeSeconds: 10, coord: STOP, stops: STOPS, ...onTime })).toBe("atStop");
  });

  it("is Late once the leg is behind, even while it is standing at a stop", () => {
    expect(vanStateOf({ gpsAgeSeconds: 10, coord: STOP, stops: STOPS, ...behind })).toBe("late");
  });

  /*
   * LOC-03, and the whole reason the precedence runs worst-first: a van whose fix has gone
   * stale is a van we cannot see, and a screen that calls it "On route" is making a claim out of
   * silence. No GPS beats Late and beats At stop.
   */
  it("is No GPS once the fix is stale, whatever the schedule says", () => {
    expect(
      vanStateOf({ gpsAgeSeconds: GPS_STALE_SECONDS, coord: STOP, stops: STOPS, ...behind }),
    ).toBe("noGps");
  });

  it("is No GPS for a van that has never reported at all", () => {
    expect(vanStateOf({ gpsAgeSeconds: undefined, coord: AWAY, stops: STOPS, ...onTime })).toBe(
      "noGps",
    );
  });
});

describe("the header's counts and the list's order", () => {
  it("counts on route, late and no GPS — and never at stop, which the mockup does not count", () => {
    expect(countsOf(["onRoute", "atStop", "late", "noGps"])).toEqual({
      all: 4,
      onRoute: 1,
      late: 1,
      noGps: 1,
    });
  });

  /* REDESIGN-SPEC §3: "Sorted with the worst first." */
  it("puts the van that needs a person first, then the one we have lost", () => {
    const vans = [
      { number: 1, chip: "onRoute" as const },
      { number: 2, chip: "noGps" as const },
      { number: 3, chip: "late" as const },
      { number: 4, chip: "atStop" as const },
    ];
    expect(bySeverity(vans).map((v) => v.number)).toEqual([3, 2, 4, 1]);
  });

  it("keeps the day's own order between vans in the same state, so rows do not swap on a tick", () => {
    const vans = [
      { number: 3, chip: "late" as const },
      { number: 1, chip: "late" as const },
      { number: 2, chip: "late" as const },
    ];
    expect(bySeverity(vans).map((v) => v.number)).toEqual([1, 2, 3]);
  });

  it("filters All / Late / No GPS, with All keeping the vans at a stop", () => {
    expect(VAN_CHIPS.filter((chip) => matchesFilter(chip, "all"))).toEqual([...VAN_CHIPS]);
    expect(VAN_CHIPS.filter((chip) => matchesFilter(chip, "late"))).toEqual(["late"]);
    expect(VAN_CHIPS.filter((chip) => matchesFilter(chip, "noGps"))).toEqual(["noGps"]);
  });
});

/**
 * THE WHOLE SIMULATED DAY, at 15-second steps.
 *
 * The screen promises four states. A derivation that can only produce two of them is a screen
 * with two states on it, and a browser check that looks at three instants would not find out —
 * so the day is walked here, where it is cheap, and e2e then only has to prove that the chip a
 * van wears reaches the DOM.
 */
describe("the simulated day produces all four states", () => {
  const seen = new Set<string>();
  for (let s = 0; s <= DEMO_RUN_SECONDS; s += 15) {
    for (const van of liveDayAt(s, { tween: true }).vans) seen.add(van.chip);
  }

  it.each(VAN_CHIPS)("shows %s at some point in the day", (chip) => {
    expect(seen.has(chip), `no van is ever "${chip}" in the simulated day`).toBe(true);
  });

  it("gives every van exactly one chip, and it is one of the four", () => {
    for (const van of liveDayAt(1200, { tween: true }).vans) {
      expect(VAN_CHIPS).toContain(van.chip);
    }
  });

  /*
   * LOC-01 / ADR-013: the run whose device has no active binding has no displayable position,
   * so its van is absent from the list entirely — not drawn faintly, and not numbered, which is
   * why the day's vans are 1, 2, 3 with no gap in them.
   */
  it("numbers only the vans it can show, with no gap where the unbound one would be", () => {
    const vans = liveDayAt(1200, { tween: true }).vans;
    expect(vans.map((v) => v.number).sort()).toEqual([1, 2, 3]);
  });

  /* Firia's goal-5 brief: no ETAs anywhere on this screen. Nothing the day hands the UI is one. */
  it("hands the screen no time of any kind: no ETA field, no window, no 'min' text", () => {
    const day = liveDayAt(1200, { tween: true, familyLabels: true });
    for (const van of day.vans) {
      const text = [van.nextStop, van.driver].join(" ");
      expect(text).not.toMatch(/\b\d{1,2}:\d{2}\b/);
      expect(text).not.toMatch(/\bmin\b/);
      expect(Object.keys(van)).not.toContain("etaMs");
      expect(Object.keys(van)).not.toContain("windowText");
    }
  });
});
