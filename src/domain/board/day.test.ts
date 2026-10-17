import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { liveStreamConfig } from "@/config/live";
import { SCENARIO_START_MS } from "@/fixtures/replays";
import { serviceDate } from "@/ui/copy";
import { serviceDateIso, serviceDateLabel } from "@/ui/service-date";
import {
  BOARD_SCENARIO_SECONDS,
  BOARD_SCENARIO_TICK,
  CLOCK_PARAM,
  DATE_OVERRIDE_ENV_VAR,
  DAY_LAST_TICK,
  DEMO_SERVICE_DATE,
  DAY_RANGE_DAYS,
  boardInstantMs,
  dateOverrideAllowed,
  demoDay,
  demoDayAtTick,
  demoDayTickAt,
  localTimeOn,
  requestedBoardDay,
  requestedClockSpeed,
  requestedScenarioTick,
  requestedServiceDay,
  serviceDayFor,
} from "./day";

/**
 * One service date for the screen (PRD §6.1), and the instant each kind of day is read at.
 *
 * The board can show three different things and the difference is entirely here: a day before
 * the demo day has finished, so its rides have outcomes; the demo day is live, so one of its
 * vans is on the road; a day after it has not started, so it is the plan. These are the
 * assertions that stop that from drifting into "whatever the clock happened to be".
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** A local browser-check shell: every one of the four gates open. */
const TEST_SHELL = {
  APP_DATA_CLASS: "SYNTHETIC",
  DEMO_MODE: "1",
  [DATE_OVERRIDE_ENV_VAR]: "1",
} as const;

const yesterday = demoDay().previousIso!;

describe("the demo day", () => {
  it("is the day the committed replays are on, read twelve minutes into them", () => {
    const day = demoDay();
    expect(day.iso).toBe(DEMO_SERVICE_DATE);
    expect(day.iso).toBe(serviceDateIso(new Date(SCENARIO_START_MS)));
    expect(day.phase).toBe("LIVE");
    expect(day.instantMs).toBe(SCENARIO_START_MS + BOARD_SCENARIO_SECONDS * 1000);
    expect(boardInstantMs()).toBe(day.instantMs);
    expect(day.offsetDays).toBe(0);
    expect(day.label).toBe(serviceDateLabel(new Date(day.instantMs)));
  });

  it("is a weekday the scenario runs, with a day each side of it", () => {
    const day = demoDay();
    expect(day.scheduled).toBe(true);
    expect(day.previousIso).toBe("2026-10-13");
    expect(day.nextIso).toBe("2026-10-15");
  });
});

describe("the phase of a day decides when it is read", () => {
  it("reads a finished day after the last van is in (MOCKS §7 step 12)", () => {
    const day = serviceDayFor(demoDay().previousIso);
    expect(day.phase).toBe("ENDED");
    expect(day.instantMs).toBe(localTimeOn(day, "17:30"));
    // A whole day earlier than the demo day's own 17:30, to the millisecond.
    expect(day.instantMs).toBe(localTimeOn(demoDay(), "17:30") - DAY_MS);
  });

  it("reads a day that has not started at the scenario clock's own start (MOCKS §6)", () => {
    const day = serviceDayFor(demoDay().nextIso);
    expect(day.phase).toBe("PLANNED");
    expect(day.instantMs).toBe(localTimeOn(day, "06:00"));
  });

  it("gives every phase words of its own, so a finished board says why it is finished", () => {
    for (const phase of ["ENDED", "LIVE", "PLANNED"] as const) {
      expect(serviceDate.phases[phase].length).toBeGreaterThan(0);
    }
  });
});

/**
 * Veri #49: the console has no date switcher, so a request may not be one either. The finished
 * day is still where AT-10 and AT-13 are proved in a browser, so the override stays — behind
 * four gates, one of which (`VERCEL_ENV` unset) cannot hold on any deployment we own.
 */
describe("the date override is a test path and nothing a deployment has", () => {
  it("reads the day a test shell asks for", () => {
    expect(dateOverrideAllowed(TEST_SHELL)).toBe(true);
    const day = requestedServiceDay(yesterday, TEST_SHELL);
    expect(day.iso).toBe(yesterday);
    expect(day.phase).toBe("ENDED");
  });

  it.each([
    ["a deployment, where the platform sets VERCEL_ENV", { VERCEL_ENV: "production" }],
    ["a preview, which is a deployment too", { VERCEL_ENV: "preview" }],
    ["real data (ADR-015)", { APP_DATA_CLASS: "LIVE" }],
    ["no data class at all", { APP_DATA_CLASS: undefined }],
    ["the demo switch off (ADR-014)", { DEMO_MODE: "0" }],
    ["the demo switch unset", { DEMO_MODE: undefined }],
    ["an ordinary local shell that did not ask", { [DATE_OVERRIDE_ENV_VAR]: undefined }],
    ["an override asked for by any other value", { [DATE_OVERRIDE_ENV_VAR]: "true" }],
  ])("is the demo day on %s", (_why, override) => {
    const env = { ...TEST_SHELL, ...override };
    expect(dateOverrideAllowed(env)).toBe(false);
    // Whatever was asked for, and however well-formed: one day is reachable.
    for (const asked of [yesterday, demoDay().nextIso, "2026-10-17", "nonsense"]) {
      expect(requestedServiceDay(asked, env).iso).toBe(DEMO_SERVICE_DATE);
    }
  });

  it("an empty environment is the demo day, so a forgotten variable cannot open it", () => {
    expect(dateOverrideAllowed({})).toBe(false);
    expect(requestedServiceDay(yesterday, {}).iso).toBe(DEMO_SERVICE_DATE);
  });
});

/**
 * Veri: the scenario clock may be moved only under **exactly** the same gates as the date, and
 * through the same helper rather than a second copy of the list.
 *
 * §6.2's ×10 and ×60 exist so a browser check can reach the 180 s badge, the 600 s exception and
 * the one damped window inside a test. A console that read `?speed=` on a deployment would be a
 * demo instrument on a coordinator's screen: a morning running ten times over, every age and
 * every window on it true of a day that is not passing at that rate. So it is one gate for both,
 * and the first of its four conditions cannot hold on any deployment we own.
 */
describe("the scenario clock moves only under the date's own gates", () => {
  const TEST_SHELL = {
    APP_DATA_CLASS: "SYNTHETIC",
    DEMO_MODE: "1",
    [DATE_OVERRIDE_ENV_VAR]: "1",
  } as const;

  const CONSOLE_SPEED = liveStreamConfig.defaultSpeed;
  const yesterday = demoDay().previousIso!;

  it("runs the demo day at the console's own ×1 by default, open gate or not", () => {
    expect(CONSOLE_SPEED).toBe(1);
    expect(requestedClockSpeed(undefined, TEST_SHELL)).toBe(CONSOLE_SPEED);
    expect(requestedClockSpeed(undefined, {})).toBe(CONSOLE_SPEED);
  });

  it("lets a test shell ask for the §6.2 speeds", () => {
    expect(dateOverrideAllowed(TEST_SHELL)).toBe(true);
    for (const speed of liveStreamConfig.speeds) {
      expect(requestedClockSpeed(String(speed), TEST_SHELL)).toBe(speed);
    }
    // A speed that is not one of the three falls back rather than failing, like a bad `?date=`.
    for (const asked of ["1000", "-1", "fast", ""]) {
      expect(requestedClockSpeed(asked, TEST_SHELL)).toBe(CONSOLE_SPEED);
    }
  });

  /**
   * One row per gate, each closed on its own with the other three left open — so a gate that
   * stopped being read fails here by itself rather than hiding behind the next one. The first
   * two rows are the deployments: `VERCEL_ENV` is set by the platform on preview and on
   * production, which is why **no deployment has a clock to move**.
   */
  it.each([
    ["production, where the platform sets VERCEL_ENV", { VERCEL_ENV: "production" }],
    ["a preview, which is a deployment too", { VERCEL_ENV: "preview" }],
    ["real data (ADR-015)", { APP_DATA_CLASS: "LIVE" }],
    ["no data class at all", { APP_DATA_CLASS: undefined }],
    ["the demo switch off (ADR-014)", { DEMO_MODE: "0" }],
    ["the demo switch unset", { DEMO_MODE: undefined }],
    ["an ordinary local shell that did not ask", { [DATE_OVERRIDE_ENV_VAR]: undefined }],
    ["an override asked for by any other value", { [DATE_OVERRIDE_ENV_VAR]: "true" }],
  ])("is ×1 on %s, whatever speed was asked for", (_why, closed) => {
    const env = { ...TEST_SHELL, ...closed };
    expect(dateOverrideAllowed(env)).toBe(false);
    for (const asked of [10, 60, "10", "60", "1000"]) {
      expect(requestedClockSpeed(asked, env)).toBe(CONSOLE_SPEED);
    }
  });

  it("is the same gate as the date's, not a second list that could drift", () => {
    // Every combination of the four gates: the day moves exactly when the clock does.
    for (const vercel of [undefined, "production"]) {
      for (const dataClass of [undefined, "SYNTHETIC"]) {
        for (const demo of [undefined, "1"]) {
          for (const asked of [undefined, "1"]) {
            const env = {
              VERCEL_ENV: vercel,
              APP_DATA_CLASS: dataClass,
              DEMO_MODE: demo,
              [DATE_OVERRIDE_ENV_VAR]: asked,
            };
            const dayMoved = requestedServiceDay(yesterday, env).iso !== DEMO_SERVICE_DATE;
            const clockMoved = requestedClockSpeed(60, env) !== CONSOLE_SPEED;
            expect({ env, dayMoved, clockMoved }).toEqual({
              env,
              dayMoved: dateOverrideAllowed(env),
              clockMoved: dateOverrideAllowed(env),
            });
          }
        }
      }
    }
  });

  /**
   * And the gate is *reached*: a surface that called `normalizeSpeed` itself would be the second
   * copy of the rule this requirement is about, and it would pass every assertion above.
   */
  it("is how every surface reads a speed: none of them normalizes one itself", () => {
    const SRC = path.resolve(__dirname, "..", "..");
    const readers = [
      path.join(SRC, "app", "(app)", "today", "page.tsx"),
      path.join(SRC, "app", "api", "stream", "route.ts"),
    ];
    for (const file of readers) {
      const source = readFileSync(file, "utf8");
      expect(source, `${file} reads the speed through the gate`).toMatch(
        /requestedClockSpeed\([\s\S]*?process\.env\)/,
      );
      expect(source, `${file} normalizes a speed of its own`).not.toMatch(/normalizeSpeed\(/);
    }
  });
});

describe("which days the override can reach", () => {
  it("walks whole days, and the arrows stop at the end of the range", () => {
    let day = demoDay();
    for (let i = 0; i < DAY_RANGE_DAYS; i += 1) {
      const next = serviceDayFor(day.nextIso);
      expect(next.offsetDays, next.iso).toBe(day.offsetDays + 1);
      day = next;
    }
    expect(day.offsetDays).toBe(DAY_RANGE_DAYS);
    expect(day.nextIso).toBeNull();
  });

  it("stays inside one daylight-saving offset, which is why the range is a fortnight", () => {
    // Whole-day arithmetic is only exact while the offset does not change; US DST ends on
    // 2026-11-01, well outside ±14 days of the seeded Wednesday.
    const zone = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      timeZoneName: "short",
    });
    const names = new Set<string>();
    for (const offset of [-DAY_RANGE_DAYS, 0, DAY_RANGE_DAYS]) {
      names.add(
        zone
          .formatToParts(new Date(demoDay().instantMs + offset * DAY_MS))
          .find((p) => p.type === "timeZoneName")!.value,
      );
    }
    expect([...names]).toEqual(["EDT"]);
  });

  it("knows a weekend is not a service day (PRD §18.1 Mon–Fri)", () => {
    expect(serviceDayFor("2026-10-17").scheduled).toBe(false);
    expect(serviceDayFor("2026-10-18").scheduled).toBe(false);
    expect(serviceDayFor("2026-10-16").scheduled).toBe(true);
  });

  /**
   * A URL is typed by hand and pasted into chats. Anything that is not a date in range comes
   * back as the demo day, because a board that refuses to render is a worse answer than the one
   * it was always going to show.
   */
  it.each(["", "not-a-date", "2026-13-01", "1999-01-01", "2027-10-14", undefined, null])(
    "falls back to the demo day for %p",
    (value) => {
      expect(serviceDayFor(value).iso).toBe(DEMO_SERVICE_DATE);
    },
  );

  it("refuses a clock time that is not one, rather than reading it as midnight", () => {
    expect(() => localTimeOn(demoDay(), "half past four")).toThrow(/wall-clock time/);
  });
});

/**
 * Moving the board's clock is gated exactly as the date is, by calling the same function: a
 * clock decides which rides have *happened*, so a request that could move it could put a hold,
 * an exception or a cleared board in front of a coordinator reading what they believe is now.
 *
 * One test per gate below, and the first assertion in each is on `dateOverrideAllowed` itself —
 * if the clock ever grows a condition of its own, the pair stops agreeing and these fail.
 */
describe("moving the clock is gated exactly as the date is", () => {
  /** 4:25 PM on the demo day: five minutes past the AT-13 ride's window (AT-13's whole point). */
  const PAST_THE_DROPOFF = String(demoDayTickAt("16:25"));

  it("walks the demo day to the tick a test shell asks for", () => {
    expect(dateOverrideAllowed(TEST_SHELL)).toBe(true);
    expect(requestedScenarioTick(PAST_THE_DROPOFF, TEST_SHELL)).toBe(demoDayTickAt("16:25"));
    const day = requestedBoardDay(undefined, PAST_THE_DROPOFF, TEST_SHELL);
    // The same day — its date, its label, its phase — read at another instant on it.
    expect(day.iso).toBe(DEMO_SERVICE_DATE);
    expect(day.phase).toBe("LIVE");
    expect(day.instantMs).toBe(localTimeOn(demoDay(), "16:25"));
  });

  /** Gate 1. The platform sets `VERCEL_ENV` on every deployment, production included. */
  it("has no clock on a deployment, production included", () => {
    for (const vercelEnv of ["production", "preview", "development"]) {
      const env = { ...TEST_SHELL, VERCEL_ENV: vercelEnv };
      expect(dateOverrideAllowed(env), vercelEnv).toBe(false);
      expect(requestedScenarioTick(PAST_THE_DROPOFF, env), vercelEnv).toBe(BOARD_SCENARIO_TICK);
      expect(requestedBoardDay(undefined, PAST_THE_DROPOFF, env).instantMs, vercelEnv).toBe(
        boardInstantMs(),
      );
    }
  });

  /** Gate 2. ADR-015: with a real day in the database there is no scenario to walk. */
  it("has no clock on anything but synthetic data", () => {
    for (const dataClass of ["LIVE", undefined]) {
      const env = { ...TEST_SHELL, APP_DATA_CLASS: dataClass };
      expect(dateOverrideAllowed(env), String(dataClass)).toBe(false);
      expect(requestedScenarioTick(PAST_THE_DROPOFF, env), String(dataClass)).toBe(
        BOARD_SCENARIO_TICK,
      );
    }
  });

  /** Gate 3. ADR-014: the demo switch. */
  it("has no clock with the demo switch off", () => {
    for (const demoMode of ["0", undefined]) {
      const env = { ...TEST_SHELL, DEMO_MODE: demoMode };
      expect(dateOverrideAllowed(env), String(demoMode)).toBe(false);
      expect(requestedScenarioTick(PAST_THE_DROPOFF, env), String(demoMode)).toBe(
        BOARD_SCENARIO_TICK,
      );
    }
  });

  /** Gate 4. Said by name, so a local `pnpm dev` is the demo day at 07:42 unless it asked. */
  it("has no clock in a local shell that did not ask for the override by name", () => {
    for (const asked of [undefined, "true", "0"]) {
      const env = { ...TEST_SHELL, [DATE_OVERRIDE_ENV_VAR]: asked };
      expect(dateOverrideAllowed(env), String(asked)).toBe(false);
      expect(requestedScenarioTick(PAST_THE_DROPOFF, env), String(asked)).toBe(
        BOARD_SCENARIO_TICK,
      );
    }
    expect(dateOverrideAllowed({})).toBe(false);
    expect(requestedScenarioTick(PAST_THE_DROPOFF, {})).toBe(BOARD_SCENARIO_TICK);
  });

  it("is the board's own instant when no tick is asked for, to the millisecond", () => {
    expect(requestedScenarioTick(undefined, TEST_SHELL)).toBe(BOARD_SCENARIO_TICK);
    expect(demoDayAtTick(BOARD_SCENARIO_TICK)).toEqual(demoDay());
    expect(requestedBoardDay(undefined, undefined, TEST_SHELL)).toEqual(demoDay());
  });

  /** A tick arrives in a URL that is typed by hand, so none of these may fail to render. */
  it.each([
    ["the end of the day, and holds there", "999999", "17:30"],
    ["the scenario's own start, which is tick zero", "0", "07:30"],
  ])("walks to %s", (_why, asked, hhmm) => {
    expect(requestedBoardDay(undefined, asked, TEST_SHELL).instantMs).toBe(
      localTimeOn(demoDay(), hhmm),
    );
  });

  it.each(["", "   ", "noon", "4:20 PM", "NaN", "-500"])(
    "is the board's own instant for a tick that is not one (%p)",
    (asked) => {
      expect(requestedScenarioTick(asked, TEST_SHELL)).toBe(BOARD_SCENARIO_TICK);
    },
  );

  it("holds at the end of the day, which is where a finished day is read too", () => {
    expect(demoDayAtTick(DAY_LAST_TICK).instantMs).toBe(localTimeOn(demoDay(), "17:30"));
    expect(demoDayAtTick(DAY_LAST_TICK + 1000)).toEqual(demoDayAtTick(DAY_LAST_TICK));
    // Longer than the committed replays on purpose: they stop in the morning and the ride
    // AT-13 is about ends at 4:20 PM.
    expect(DAY_LAST_TICK).toBeGreaterThan(demoDayTickAt("16:20"));
  });

  /**
   * The clock is the demo day's. A finished day *is* its instant — after the last van is in —
   * and a tick that moved it would be inventing a phase the day does not have.
   */
  it("leaves a day that is not the demo day at the instant its phase is read at", () => {
    const ended = requestedBoardDay(yesterday, PAST_THE_DROPOFF, TEST_SHELL);
    expect(ended.phase).toBe("ENDED");
    expect(ended.instantMs).toBe(localTimeOn(ended, "17:30"));
    const planned = requestedBoardDay(demoDay().nextIso, PAST_THE_DROPOFF, TEST_SHELL);
    expect(planned.phase).toBe("PLANNED");
    expect(planned.instantMs).toBe(localTimeOn(planned, "06:00"));
  });

  it("names the parameter once, so nothing has to spell it twice", () => {
    expect(CLOCK_PARAM).toBe("tick");
  });
});
