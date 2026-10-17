import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildBoard } from "@/domain/board/board";
import { BOARD_SCENARIO_TICK, DAY_LAST_TICK, demoDayAtTick } from "@/domain/board/day";
import { tickIntervalMs } from "@/domain/eta/scenario-clock";
import { scenarioClock } from "./copy";
import {
  DEMO_CLOCK_SPEED,
  demoClockReadout,
  demoClockSnapshot,
  resetDemoClock,
  startDemoClock,
  subscribeDemoClock,
} from "./demo-clock";

/**
 * The demo day's clock, and the press that starts it.
 *
 * The founder's report from prod (2026-10-17 14:40 ET) was "the start demo data button still
 * doesn't work": the button had no handler at all. What a click calls is `startDemoClock`, and
 * these are the assertions about that call — the readout stops saying the demo has not started,
 * the day walks, the board read at the clock's tick is the same day further into itself, and the
 * reset puts all of it back. e2e/scenario-clock.spec.ts then does it with a real mouse, which is
 * the half a unit test cannot claim (vitest runs in node, with no DOM).
 */

/** What the readout says right now — the string the header is showing. */
const readout = () => demoClockReadout(demoClockSnapshot());

/** A wall-clock second at ×10 is two ticks; a scenario minute is twelve. */
const TICK_MS = tickIntervalMs(DEMO_CLOCK_SPEED);

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  resetDemoClock();
  vi.useRealTimers();
});

describe("a click starts the demo day", () => {
  it("reads 'Demo not started' until it is pressed", () => {
    expect(readout()).toBe(scenarioClock.notStarted);
    expect(demoClockSnapshot().running).toBe(false);
  });

  it("changes the readout to the running scenario time on the press itself", () => {
    startDemoClock();

    expect(readout()).not.toBe(scenarioClock.notStarted);
    expect(demoClockSnapshot().running).toBe(true);
    /*
     * The board's own instant, 7:42 AM — the page is already rendered twelve minutes into the
     * morning, so Start continues the day on screen instead of sending it back to 7:30 and an
     * empty board.
     */
    expect(readout()).toBe("7:42 AM");
    expect(demoClockSnapshot().tick).toBe(BOARD_SCENARIO_TICK);
  });

  it("walks the day: the readout is a later time a scenario minute on", () => {
    startDemoClock();
    // §6.2's ×10: twelve ticks of 5 scenario seconds, which is six seconds of a founder's time.
    vi.advanceTimersByTime(TICK_MS * 12);

    expect(readout()).toBe("7:43 AM");
    expect(demoClockSnapshot().tick).toBe(BOARD_SCENARIO_TICK + 12);
  });

  it("notifies every reader of the same tick, so there is one clock on screen", () => {
    const seen: number[] = [];
    const unsubscribe = subscribeDemoClock(() => seen.push(demoClockSnapshot().tick));

    startDemoClock();
    vi.advanceTimersByTime(TICK_MS * 2);
    unsubscribe();
    vi.advanceTimersByTime(TICK_MS * 2);

    expect(seen).toEqual([
      BOARD_SCENARIO_TICK,
      BOARD_SCENARIO_TICK + 1,
      BOARD_SCENARIO_TICK + 2,
    ]);
  });

  it("is not a restart: pressing a running clock leaves the day where it is", () => {
    startDemoClock();
    vi.advanceTimersByTime(TICK_MS * 12);
    startDemoClock();

    expect(demoClockSnapshot().tick).toBe(BOARD_SCENARIO_TICK + 12);
    // And it is still one interval, so the day does not then run at twice the speed.
    vi.advanceTimersByTime(TICK_MS * 12);
    expect(demoClockSnapshot().tick).toBe(BOARD_SCENARIO_TICK + 24);
  });

  /** PRD §8: acceleration only ever changes how long we wait between ticks. */
  it("accelerates the waiting and nothing else", () => {
    expect(DEMO_CLOCK_SPEED).toBe(10);
    expect(TICK_MS).toBe(500);
    startDemoClock();
    const first = demoClockSnapshot().tick;
    vi.advanceTimersByTime(TICK_MS);
    // One tick is 5 scenario seconds at every speed; only the wall time it took differs.
    expect(demoClockSnapshot().tick - first).toBe(1);
  });
});

describe("the reset beside it", () => {
  it("says the demo has not started again, from wherever the day had reached", () => {
    startDemoClock();
    vi.advanceTimersByTime(TICK_MS * 60);
    expect(readout()).not.toBe(scenarioClock.notStarted);

    resetDemoClock();

    expect(readout()).toBe(scenarioClock.notStarted);
    expect(demoClockSnapshot()).toEqual({ running: false, tick: BOARD_SCENARIO_TICK });
    // Stopped, not merely rewound: nothing moves afterwards.
    vi.advanceTimersByTime(TICK_MS * 60);
    expect(readout()).toBe(scenarioClock.notStarted);
  });
});

describe("the end of the day", () => {
  it("holds at 5:30 PM instead of restarting the morning", () => {
    startDemoClock();
    vi.advanceTimersByTime(TICK_MS * (DAY_LAST_TICK + 100));

    expect(demoClockSnapshot().tick).toBe(DAY_LAST_TICK);
    expect(readout()).toBe("5:30 PM");
    // And it is still the day that is running — it has simply arrived at its end.
    expect(demoClockSnapshot().running).toBe(true);
  });
});

describe("the board reads the same clock", () => {
  /**
   * The header is not the only surface that moves: /today rebuilds the board at the clock's tick
   * with the same function the server used (src/app/(app)/today/TodayBoard.tsx). This is that
   * call, at the tick the clock reaches a minute in — the same demo day, read later, with the
   * van's last position a minute older than it was.
   */
  it("is the same demo day read later, with older positions on it", () => {
    const rendered = buildBoard(demoDayAtTick(BOARD_SCENARIO_TICK));

    startDemoClock();
    vi.advanceTimersByTime(TICK_MS * 12);
    const walked = buildBoard(demoDayAtTick(demoClockSnapshot().tick));

    expect(walked.day.iso).toBe(rendered.day.iso);
    expect(walked.day.phase).toBe("LIVE");
    expect(walked.day.instantMs).toBe(rendered.day.instantMs + 60_000);

    // A van whose device is reporting: its last position is sixty seconds older than it was.
    const before = rendered.legs.find((leg) => (leg.ride.gpsAgeSeconds ?? 0) > 0);
    expect(before, "a ride with a reported position").toBeDefined();
    const after = walked.legs.find((leg) => leg.key === before!.key);
    expect(after?.ride.gpsAgeSeconds ?? 0).toBeGreaterThan(before!.ride.gpsAgeSeconds ?? 0);
  });
});
