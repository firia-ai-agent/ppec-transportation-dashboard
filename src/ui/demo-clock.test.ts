import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildBoard } from "@/domain/board/board";
import { BOARD_SCENARIO_TICK, DAY_LAST_TICK, demoDayAtTick } from "@/domain/board/day";
import { tickIntervalMs } from "@/domain/eta/scenario-clock";
import { DEMO_RESET_REFUSAL } from "@/modules/demo/refusal";
import { scenarioClock } from "./copy";
import {
  DEMO_CLOCK_KEY,
  DEMO_CLOCK_SPEED,
  NOT_STARTED,
  demoClockReadout,
  demoClockSnapshot,
  readDemoStart,
  resetDemoClock,
  restartDemoClock,
  resumeDemoClock,
  startDemoClock,
  subscribeDemoClock,
} from "./demo-clock";
import { startDemoDay, type DemoResetAnswer } from "./demo-day";

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

/**
 * A reload, and the press that follows it.
 *
 * The gap this closes: the store above is module state, so a refresh — or the founder opening the
 * site in a second tab — came back to "Demo not started", and the button went back to being a
 * *first* press. A first press resets the demo day with no confirm (the founder's 2026-10-17
 * 14:44 ET ruling, and the right answer when there is nothing to lose), so a reload turned the
 * one unguarded press into an unguarded press available at any moment, throwing away everything
 * changed since the start without asking. After the first press the button has to stay "Restart
 * demo day" with its confirm, reload or no reload.
 *
 * So the *fact* of the start is remembered in this tab's `sessionStorage` — when it happened and
 * the tick it started from, two numbers — and `resumeDemoClock` rebuilds the clock from them.
 * vitest runs in node with no DOM, so `window` is stubbed here; that it is `undefined` in every
 * test above is the server's case, and the clock has to work there too (it does: nothing is
 * written and nothing is resumed).
 */

/** The tab's storage, as the browser's own API: a map with the three methods this module calls. */
function fakeStorage() {
  const entries = new Map<string, string>();
  return {
    entries,
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => void entries.set(key, value),
    removeItem: (key: string) => void entries.delete(key),
  };
}

/** A browser that refuses storage: reading or writing throws, as Safari's private mode does. */
const refusingStorage = {
  getItem: () => {
    throw new DOMException("denied", "SecurityError");
  },
  setItem: () => {
    throw new DOMException("quota", "QuotaExceededError");
  },
  removeItem: () => {
    throw new DOMException("denied", "SecurityError");
  },
};

/**
 * A reload, as far as this module is concerned: nothing left in memory, the tab's storage
 * untouched. `resetDemoClock` is the only way to put the store back from a test, and it clears
 * the record too (that is its job — "Demo not started" means no record), so the record is kept
 * across it by hand, which is what a refresh does to a page.
 */
function reload(storage: ReturnType<typeof fakeStorage>): void {
  const kept = [...storage.entries];
  resetDemoClock();
  storage.entries.clear();
  for (const [key, value] of kept) storage.entries.set(key, value);
}

/** A wall-clock instant to measure the elapsed time from. Any instant: the record stores its own. */
const PRESS_AT = Date.parse("2026-10-17T18:44:00.000Z");

describe("a reload keeps the demo day", () => {
  let storage: ReturnType<typeof fakeStorage>;

  beforeEach(() => {
    storage = fakeStorage();
    vi.stubGlobal("window", { sessionStorage: storage });
    vi.setSystemTime(PRESS_AT);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** The record as it is on disk, parsed — what a reload in this tab would read. */
  const stored = () => {
    const raw = storage.entries.get(DEMO_CLOCK_KEY);
    return raw === undefined ? null : (JSON.parse(raw) as unknown);
  };

  it("remembers when the day started and the tick it started from, under one key", () => {
    restartDemoClock();

    expect([...storage.entries.keys()]).toEqual([DEMO_CLOCK_KEY]);
    expect(stored()).toEqual({ startedAtMs: PRESS_AT, startTick: BOARD_SCENARIO_TICK });
    // And the same two numbers come back out, which is all a resume reads.
    expect(readDemoStart()).toEqual({ startedAtMs: PRESS_AT, startTick: BOARD_SCENARIO_TICK });
  });

  it("resumes at the tick the day would have reached, still walking", () => {
    restartDemoClock();
    // The reload: nothing in memory, the record still there, and a minute of a founder's time
    // gone by while the page was loading itself again.
    reload(storage);
    vi.setSystemTime(PRESS_AT + 60_000);
    expect(demoClockSnapshot()).toEqual(NOT_STARTED);

    resumeDemoClock();

    // ×10: a minute of wall time is 120 ticks, which is ten scenario minutes on from 7:42.
    expect(demoClockSnapshot()).toEqual({ running: true, tick: BOARD_SCENARIO_TICK + 120 });
    expect(readout()).toBe("7:52 AM");
    // Running, not merely rewound: the day carries on from there at the same speed.
    vi.advanceTimersByTime(TICK_MS * 12);
    expect(readout()).toBe("7:53 AM");
  });

  it("offers the restart after the reload, because the clock is running", () => {
    restartDemoClock();
    reload(storage);
    vi.setSystemTime(PRESS_AT + 60_000);

    resumeDemoClock();

    /*
     * The header reads its label off `running` (ScenarioClock.tsx): running is "Restart demo
     * day" and its confirm, not running is the unguarded "Start demo day". This is the gap, in
     * one assertion — before the fix a reload made this `false`.
     */
    expect(demoClockSnapshot().running).toBe(true);
    expect(readout()).not.toBe(scenarioClock.notStarted);
  });

  it("holds at the end of the day when the tab was left open past it", () => {
    storage.entries.set(
      DEMO_CLOCK_KEY,
      JSON.stringify({ startedAtMs: PRESS_AT, startTick: BOARD_SCENARIO_TICK }),
    );
    // Ten hours later, which at ×10 is far beyond the end of the service day.
    vi.setSystemTime(PRESS_AT + 10 * 60 * 60 * 1000);

    resumeDemoClock();

    expect(demoClockSnapshot()).toEqual({ running: true, tick: DAY_LAST_TICK });
    expect(readout()).toBe("5:30 PM");
    // And it stays there rather than looping the morning, exactly as `step` holds.
    vi.advanceTimersByTime(TICK_MS * 100);
    expect(demoClockSnapshot()).toEqual({ running: true, tick: DAY_LAST_TICK });
  });

  it("is the start tick again when no time has passed", () => {
    storage.entries.set(
      DEMO_CLOCK_KEY,
      JSON.stringify({ startedAtMs: PRESS_AT, startTick: BOARD_SCENARIO_TICK }),
    );

    resumeDemoClock();

    expect(demoClockSnapshot().tick).toBe(BOARD_SCENARIO_TICK);
  });

  it("says the demo has not started when this tab never pressed Start", () => {
    resumeDemoClock();

    expect(readout()).toBe(scenarioClock.notStarted);
    expect(demoClockSnapshot()).toEqual(NOT_STARTED);
  });

  /** Anything under the key that is not the record we wrote is "not started", never a throw. */
  it.each([
    ["not JSON at all", "{nope"],
    ["half a write", '{"startedAtMs":176'],
    ["null", "null"],
    ["a string", '"started"'],
    ["a number", "7"],
    ["an array", "[1,2]"],
    ["no fields", "{}"],
    ["a tick but no instant", '{"startTick":504}'],
    ["an instant but no tick", '{"startedAtMs":1760000000000}'],
    ["the instant as words", '{"startedAtMs":"now","startTick":504}'],
    ["the tick as words", '{"startedAtMs":1760000000000,"startTick":"504"}'],
    ["nulls", '{"startedAtMs":null,"startTick":null}'],
    ["not a finite number", '{"startedAtMs":1e999,"startTick":504}'],
  ])("a corrupt record (%s) reads as not started", (_what, raw) => {
    storage.entries.set(DEMO_CLOCK_KEY, raw);

    expect(readDemoStart()).toBeNull();
    expect(() => resumeDemoClock()).not.toThrow();
    expect(readout()).toBe(scenarioClock.notStarted);
    expect(demoClockSnapshot().running).toBe(false);
  });

  it("clamps a record whose tick is outside the day", () => {
    storage.entries.set(
      DEMO_CLOCK_KEY,
      JSON.stringify({ startedAtMs: PRESS_AT, startTick: DAY_LAST_TICK + 10_000 }),
    );

    resumeDemoClock();

    expect(demoClockSnapshot()).toEqual({ running: true, tick: DAY_LAST_TICK });
  });

  it("ignores a start in the future rather than running the day backwards", () => {
    // A machine whose clock moved, or a record from a tab on the other side of a time change.
    storage.entries.set(
      DEMO_CLOCK_KEY,
      JSON.stringify({ startedAtMs: PRESS_AT + 60_000, startTick: BOARD_SCENARIO_TICK }),
    );

    resumeDemoClock();

    expect(demoClockSnapshot()).toEqual({ running: true, tick: BOARD_SCENARIO_TICK });
  });

  it("leaves a running clock alone, so a second mount does not double the speed", () => {
    restartDemoClock();
    vi.advanceTimersByTime(TICK_MS * 12);

    resumeDemoClock();

    expect(demoClockSnapshot().tick).toBe(BOARD_SCENARIO_TICK + 12);
    vi.advanceTimersByTime(TICK_MS * 12);
    expect(demoClockSnapshot().tick).toBe(BOARD_SCENARIO_TICK + 24);
  });

  it("a restart overwrites the record with the day it is now running", () => {
    restartDemoClock();
    vi.advanceTimersByTime(TICK_MS * 60);
    vi.setSystemTime(PRESS_AT + TICK_MS * 60);

    restartDemoClock();

    expect([...storage.entries.keys()]).toEqual([DEMO_CLOCK_KEY]);
    expect(stored()).toEqual({
      startedAtMs: PRESS_AT + TICK_MS * 60,
      startTick: BOARD_SCENARIO_TICK,
    });
  });

  it("forgets the start when the clock is put back to 'Demo not started'", () => {
    restartDemoClock();
    expect(stored()).not.toBeNull();

    resetDemoClock();

    expect(stored()).toBeNull();
    // Which is what a reload would then see: a tab that has not started a demo day.
    resumeDemoClock();
    expect(readout()).toBe(scenarioClock.notStarted);
  });

  it("runs the clock and keeps no record when the browser refuses storage", () => {
    vi.stubGlobal("window", { sessionStorage: refusingStorage });

    expect(() => restartDemoClock()).not.toThrow();

    expect(demoClockSnapshot()).toEqual({ running: true, tick: BOARD_SCENARIO_TICK });
    expect(readDemoStart()).toBeNull();
  });

  it("resumes nothing, and throws nothing, when the browser refuses storage", () => {
    vi.stubGlobal("window", { sessionStorage: refusingStorage });

    // A reload in that browser is the behaviour this tab always had: not started.
    expect(() => resumeDemoClock()).not.toThrow();
    expect(readout()).toBe(scenarioClock.notStarted);
    expect(demoClockSnapshot()).toEqual(NOT_STARTED);
  });

  it("writes nothing on the server, where there is no tab to remember in", () => {
    vi.unstubAllGlobals();

    expect(() => restartDemoClock()).not.toThrow();
    expect(readDemoStart()).toBeNull();
    expect(storage.entries.size).toBe(0);
  });
});

/**
 * Which presses are remembered: the two that start a clock, and not the one that does not.
 *
 * `startDemoDay` is the order (src/ui/demo-day.ts) and `restartDemoClock` is the one effect it
 * calls to start a clock, so "written only when the clock actually starts" is a property of the
 * two of them together — which is why the real function is passed in here instead of a spy.
 */
describe("only a press that starts the clock is remembered", () => {
  let storage: ReturnType<typeof fakeStorage>;

  beforeEach(() => {
    storage = fakeStorage();
    vi.stubGlobal("window", { sessionStorage: storage });
    vi.setSystemTime(PRESS_AT);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const press = (answer: DemoResetAnswer) =>
    startDemoDay({
      reset: async () => answer,
      startClock: restartDemoClock,
      refresh: () => {},
    });

  it("the reset ran: the start is written, so a reload resumes the day", async () => {
    const outcome = await press({ status: 200 });

    expect(outcome.started).toBe(true);
    expect(readDemoStart()).toEqual({ startedAtMs: PRESS_AT, startTick: BOARD_SCENARIO_TICK });
  });

  it("a preview refused by design: the clock started, so that is written too", async () => {
    const outcome = await press({ status: 403, refusal: DEMO_RESET_REFUSAL.readOnlyDb });

    expect(outcome.started).toBe(true);
    expect(readDemoStart()).toEqual({ startedAtMs: PRESS_AT, startTick: BOARD_SCENARIO_TICK });
  });

  it.each([
    ["signed out", { status: 401 }],
    ["not this role", { status: 403 }],
    ["the demo flags are off", { status: 404 }],
    ["the reset threw", { status: 500 }],
    ["a refusal code from somewhere else", { status: 403, refusal: "something-else" }],
  ] as const)("%s: nothing started, so nothing is remembered", async (_who, answer) => {
    const outcome = await press(answer);

    expect(outcome.started).toBe(false);
    expect(storage.entries.size).toBe(0);
    expect(readDemoStart()).toBeNull();
    // And a reload after a failed press still offers the first press, as the screen does.
    resumeDemoClock();
    expect(readout()).toBe(scenarioClock.notStarted);
  });
});
