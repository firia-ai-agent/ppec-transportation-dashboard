/**
 * The live board's thresholds: the PRD values, and the one place they are written down.
 *
 * Two halves. First the values themselves, against PRD §8's parameter table and LOC-03 — a
 * change to any of them has to be made here and is then a decision somebody took, not a
 * literal that drifted. Second the "one place" claim: every module that *names* one of these
 * thresholds has to take it from this file, so the chip on a board row, the rule that
 * suppresses an ETA text and the gate that moves a family's window cannot be calibrated apart.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { agentRetryConfig, alertAgentConfig,
  freshnessConfig,
  liveConfig,
  liveStreamConfig,
  notifyGateConfig,
  parentTextConfig,
  recomputeConfig,
} from "./live";
import {
  GPS_FRESH_SECONDS,
  GPS_LOST_SECONDS,
  GPS_STALE_SECONDS,
  MAX_FUTURE_SKEW_MS,
} from "@/domain/location/freshness";
import {
  NOTIFY_CONSECUTIVE_CALCS,
  NOTIFY_COOLDOWN_SECONDS,
  NOTIFY_ESCALATION_SECONDS,
  NOTIFY_IMPROVEMENT_SECONDS,
  NOTIFY_MIN_LEAD_SECONDS,
  NOTIFY_SHIFT_SECONDS,
} from "@/domain/eta/notify-gate";
import {
  FRESHNESS_SWEEP_SECONDS,
  RECOMPUTE_DEBOUNCE_SECONDS,
  RECOMPUTE_MIN_METERS,
  RECOMPUTE_MIN_SECONDS,
  RECOMPUTE_PERIOD_SECONDS,
} from "@/domain/eta/replay";
import { gpsFreshnessBands } from "@/ui/states";

describe("PRD §8 / LOC-03 values", () => {
  it("keeps the freshness bands at 60 / 180 / 600 s (ledger row 30, ASM-15)", () => {
    expect(freshnessConfig.freshSeconds).toBe(60);
    expect(freshnessConfig.staleSeconds).toBe(180);
    expect(freshnessConfig.lostSeconds).toBe(600);
    expect(freshnessConfig.maxFutureSkewMs).toBe(60_000);
  });

  it("keeps the ASM-14 hysteresis at 10 min / 2 calcs / 20 min / +15 min", () => {
    expect(notifyGateConfig.shiftSeconds).toBe(600);
    expect(notifyGateConfig.consecutiveCalcs).toBe(2);
    expect(notifyGateConfig.minLeadSeconds).toBe(600);
    expect(notifyGateConfig.cooldownSeconds).toBe(1200);
    expect(notifyGateConfig.escalationSeconds).toBe(900);
    expect(notifyGateConfig.improvementSeconds).toBe(900);
  });

  it("keeps the ASM-11 recompute policy at 60 s / 300 m / 5 min / 30 s debounce", () => {
    expect(recomputeConfig.minSeconds).toBe(60);
    expect(recomputeConfig.minMeters).toBe(300);
    expect(recomputeConfig.periodSeconds).toBe(300);
    expect(recomputeConfig.debounceSeconds).toBe(30);
    expect(recomputeConfig.sweepSeconds).toBe(60);
  });

  it("keeps the stream at the §2 / ADR-002 numbers", () => {
    // DESIGN-DIRECTION §2: the amber bar at 15 s with no event.
    expect(liveStreamConfig.pausedAfterSeconds).toBe(15);
    // ADR-002: self-close under the 300 s platform default.
    expect(liveStreamConfig.maxStreamSeconds).toBeLessThan(300);
    // §6.2's three speeds, and a console that runs the demo day at the speed of a day.
    expect(liveStreamConfig.speeds).toEqual([1, 10, 60]);
    expect(liveStreamConfig.defaultSpeed).toBe(1);
    // The telemetry cadence: every committed replay emits a point every 5 s.
    expect(liveStreamConfig.tickScenarioSeconds).toBe(5);
  });

  it("is one object, so the whole table can be printed or diffed", () => {
    expect(liveConfig).toEqual({
      agentRetry: agentRetryConfig,
      alertAgent: alertAgentConfig,
      freshness: freshnessConfig,
      notifyGate: notifyGateConfig,
      parentText: parentTextConfig,
      recompute: recomputeConfig,
      stream: liveStreamConfig,
    });
  });
});

describe("every module reads the thresholds from here", () => {
  it("the freshness bands (domain)", () => {
    expect([GPS_FRESH_SECONDS, GPS_STALE_SECONDS, GPS_LOST_SECONDS, MAX_FUTURE_SKEW_MS]).toEqual([
      freshnessConfig.freshSeconds,
      freshnessConfig.staleSeconds,
      freshnessConfig.lostSeconds,
      freshnessConfig.maxFutureSkewMs,
    ]);
  });

  it("the freshness bands (the §3 chip vocabulary)", () => {
    expect(gpsFreshnessBands.map((b) => b.maxAgeSeconds)).toEqual([
      freshnessConfig.freshSeconds,
      freshnessConfig.staleSeconds,
      freshnessConfig.lostSeconds,
      Number.POSITIVE_INFINITY,
    ]);
  });

  it("the notify gate", () => {
    expect([
      NOTIFY_SHIFT_SECONDS,
      NOTIFY_CONSECUTIVE_CALCS,
      NOTIFY_MIN_LEAD_SECONDS,
      NOTIFY_COOLDOWN_SECONDS,
      NOTIFY_ESCALATION_SECONDS,
      NOTIFY_IMPROVEMENT_SECONDS,
    ]).toEqual([
      notifyGateConfig.shiftSeconds,
      notifyGateConfig.consecutiveCalcs,
      notifyGateConfig.minLeadSeconds,
      notifyGateConfig.cooldownSeconds,
      notifyGateConfig.escalationSeconds,
      notifyGateConfig.improvementSeconds,
    ]);
  });

  it("the recompute policy", () => {
    expect([
      RECOMPUTE_MIN_SECONDS,
      RECOMPUTE_MIN_METERS,
      RECOMPUTE_PERIOD_SECONDS,
      RECOMPUTE_DEBOUNCE_SECONDS,
      FRESHNESS_SWEEP_SECONDS,
    ]).toEqual([
      recomputeConfig.minSeconds,
      recomputeConfig.minMeters,
      recomputeConfig.periodSeconds,
      recomputeConfig.debounceSeconds,
      recomputeConfig.sweepSeconds,
    ]);
  });
});

/**
 * The static half: nothing outside this file may *declare* one of these thresholds as a
 * number. A module may name it — `export const GPS_STALE_SECONDS = freshnessConfig.staleSeconds`
 * is exactly the shape we want — but the day somebody writes `= 180` beside it, the two
 * values can disagree and no test above would notice, because both sides would be read from
 * the same stale copy. This scan is what notices.
 */
const SRC = path.resolve(__dirname, "..");

/** The names this rule is about: thresholds, not any constant that happens to be a number. */
const THRESHOLD_NAME =
  /\b(?:const|let)\s+((?:GPS|NOTIFY|RECOMPUTE|FRESHNESS|STALE|LOST|SSE|STREAM|PAUSED)_[A-Z0-9_]*|MAX_FUTURE_SKEW_MS)\s*(?::[^=]+)?=\s*([^;\n]+)/g;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    if (!/\.tsx?$/.test(entry) || /\.test\.tsx?$/.test(entry)) return [];
    return [full];
  });
}

describe("no module declares a threshold of its own", () => {
  it("every threshold constant under src/ is read from the config", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      if (file === path.join(SRC, "config", "live.ts")) continue;
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(THRESHOLD_NAME)) {
        const [, name, value] = match;
        // A numeric literal (`180`, `60_000`, `1200 * 2`) is a second copy of a decision.
        if (/^[-\d_.\s*+/()]+$/.test(value)) {
          offenders.push(`${path.relative(SRC, file)}: ${name} = ${value.trim()}`);
        }
      }
    }
    expect(offenders, "declare it in src/config/live.ts and name it here").toEqual([]);
  });
});
