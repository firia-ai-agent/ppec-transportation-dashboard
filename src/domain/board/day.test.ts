import { describe, expect, it } from "vitest";
import { SCENARIO_START_MS } from "@/fixtures/replays";
import { serviceDate } from "@/ui/copy";
import { serviceDateIso, serviceDateLabel } from "@/ui/service-date";
import {
  BOARD_SCENARIO_SECONDS,
  DEMO_SERVICE_DATE,
  SWITCHER_RANGE_DAYS,
  boardInstantMs,
  demoDay,
  localTimeOn,
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

describe("which days a URL can reach", () => {
  it("walks whole days, and the arrows stop at the end of the range", () => {
    let day = demoDay();
    for (let i = 0; i < SWITCHER_RANGE_DAYS; i += 1) {
      const next = serviceDayFor(day.nextIso);
      expect(next.offsetDays, next.iso).toBe(day.offsetDays + 1);
      day = next;
    }
    expect(day.offsetDays).toBe(SWITCHER_RANGE_DAYS);
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
    for (const offset of [-SWITCHER_RANGE_DAYS, 0, SWITCHER_RANGE_DAYS]) {
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
