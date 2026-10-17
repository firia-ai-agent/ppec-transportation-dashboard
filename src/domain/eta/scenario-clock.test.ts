/**
 * The scenario clock (B-10): ticks, instants, speeds, and what a reconnect may resume from.
 *
 * Every assertion here is about the one property the live stream rests on — a tick number is
 * an instant, the same instant for every caller — because that is what makes an SSE event id
 * resumable (ADR-002) and a replay deterministic (AT-03).
 */
import { describe, expect, it } from "vitest";
import { liveStreamConfig } from "@/config/live";
import { DEMO_RUN_SECONDS, SCENARIO_START_MS } from "@/fixtures/replays";
import {
  clampTick,
  instantAt,
  LAST_TICK,
  normalizeSpeed,
  parseLastTick,
  scenarioSecondsAt,
  TICK_SCENARIO_SECONDS,
  tickAtScenarioSeconds,
  tickIntervalMs,
  ticksElapsed,
} from "./scenario-clock";

describe("a tick is an instant", () => {
  it("counts scenario seconds from the scenario's own start", () => {
    expect(TICK_SCENARIO_SECONDS).toBe(liveStreamConfig.tickScenarioSeconds);
    expect(scenarioSecondsAt(0)).toBe(0);
    expect(scenarioSecondsAt(144)).toBe(720);
    expect(instantAt(0)).toBe(SCENARIO_START_MS);
    expect(instantAt(144)).toBe(SCENARIO_START_MS + 720_000);
  });

  it("round-trips an instant through its tick", () => {
    for (const seconds of [0, 5, 720, 1234, 2695]) {
      const tick = tickAtScenarioSeconds(seconds);
      expect(scenarioSecondsAt(tick)).toBeLessThanOrEqual(seconds);
      expect(scenarioSecondsAt(tick + 1)).toBeGreaterThan(seconds);
    }
  });

  it("ends with the committed runs rather than looping back to 07:30", () => {
    expect(LAST_TICK).toBe(Math.floor(DEMO_RUN_SECONDS / TICK_SCENARIO_SECONDS));
    expect(clampTick(LAST_TICK + 500)).toBe(LAST_TICK);
    expect(clampTick(-3)).toBe(0);
    expect(clampTick(Number.NaN)).toBe(0);
    expect(clampTick(12.7)).toBe(12);
  });
});

describe("speed only changes how long we wait", () => {
  it("spends one tick of wall time per tick at ×1, and a tenth at ×10", () => {
    expect(tickIntervalMs(1)).toBe(TICK_SCENARIO_SECONDS * 1000);
    expect(tickIntervalMs(10)).toBe((TICK_SCENARIO_SECONDS * 1000) / 10);
    expect(tickIntervalMs(60)).toBeGreaterThan(0);
  });

  it("counts whole ticks out of a span of wall time", () => {
    expect(ticksElapsed(0, 1)).toBe(0);
    expect(ticksElapsed(4_999, 1)).toBe(0);
    expect(ticksElapsed(5_000, 1)).toBe(1);
    expect(ticksElapsed(5_000, 10)).toBe(10);
    expect(ticksElapsed(-1, 1)).toBe(0);
    expect(ticksElapsed(Number.NaN, 1)).toBe(0);
  });

  it("honours the §6.2 speeds and falls back to the console's rather than failing", () => {
    expect(normalizeSpeed(1)).toBe(1);
    expect(normalizeSpeed("10")).toBe(10);
    expect(normalizeSpeed("60")).toBe(60);
    for (const nonsense of ["fast", "-1", "1000", "", undefined, null, Number.NaN]) {
      expect(normalizeSpeed(nonsense)).toBe(liveStreamConfig.defaultSpeed);
    }
  });
});

describe("what a reconnecting client may say it already has (ADR-002 Last-Event-ID)", () => {
  it("reads a tick number", () => {
    expect(parseLastTick("144")).toBe(144);
    expect(parseLastTick("0")).toBe(0);
  });

  it("clamps one past the end of the morning", () => {
    expect(parseLastTick(String(LAST_TICK + 9))).toBe(LAST_TICK);
  });

  it("asks for a whole board when the header is missing or is not a tick", () => {
    for (const raw of [null, undefined, "", "   ", "later", "-5", "NaN"]) {
      expect(parseLastTick(raw)).toBeNull();
    }
  });
});
