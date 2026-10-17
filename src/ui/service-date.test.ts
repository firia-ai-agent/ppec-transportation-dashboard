import { describe, expect, it } from "vitest";
import { SCENARIO_START_MS } from "@/fixtures/replays";
import {
  clockLabel,
  demoDateIso,
  demoDateLabel,
  SCENARIO_SERVICE_DATE,
  serviceDateIso,
  serviceDateLabel,
  siteTimeLabel,
  SITE_TIME_ZONE,
} from "./service-date";

/**
 * The site's own clock and calendar (PRD §6.1: a service date is a calendar date in the site's
 * timezone, not an instant).
 *
 * Pinned to America/New_York rather than to whatever zone the test runner booted in, which is
 * the bug this module exists to prevent: a time rendered from the browser's local zone reads
 * right on the machine that wrote it and wrong on the next one.
 */
describe("the site's timezone", () => {
  it("is the one the project is in, and nothing reads the machine's", () => {
    expect(SITE_TIME_ZONE).toBe("America/New_York");
  });
});

describe("an instant, as the clock on the wall at the centre", () => {
  /**
   * The time a plan was saved at. The server answers in UTC — that is what `toISOString` gives
   * and what the save endpoint sends — so this is where it becomes a time a coordinator reads.
   */
  it("converts a UTC instant to the site's own wall clock", () => {
    // 2026-10-17 is inside eastern daylight time: UTC-4, so 17:24 UTC is 1:24 PM at the centre.
    expect(siteTimeLabel(new Date("2026-10-17T17:24:03Z"))).toBe("1:24 PM");
    // And in January, when the offset is UTC-5, the same UTC time is an hour earlier.
    expect(siteTimeLabel(new Date("2026-01-17T17:24:03Z"))).toBe("12:24 PM");
  });

  it("writes midnight and noon the way a person says them", () => {
    expect(siteTimeLabel(new Date("2026-10-17T04:00:00Z"))).toBe("12:00 AM");
    expect(siteTimeLabel(new Date("2026-10-17T16:00:00Z"))).toBe("12:00 PM");
  });

  it("never prints the 24-hour form, a seconds field or a zone name", () => {
    const label = siteTimeLabel(new Date("2026-10-17T20:05:09Z"));
    expect(label).toBe("4:05 PM");
    expect(label).not.toMatch(/16:05|:09|EDT|UTC|GMT/);
  });

  /**
   * It is not the other formatter: `clockLabel` writes out a time a fixture already holds as
   * site-local text, so it converts nothing. Handing it an instant is a different question, and
   * the two are deliberately not one function.
   */
  it("is the instant's answer, where clockLabel is a fixture string's", () => {
    expect(clockLabel("16:05")).toBe("4:05 PM");
    expect(clockLabel("not a time")).toBe("not a time");
  });
});

describe("the service date", () => {
  it("names the calendar day at the centre, not the one the machine is on", () => {
    // Late evening in the east is already the next day in UTC, and the service date is the
    // centre's day: 2026-10-14T23:30 local is still Wednesday the 14th.
    const instant = new Date("2026-10-15T03:30:00Z");
    expect(serviceDateIso(instant)).toBe("2026-10-14");
    expect(serviceDateLabel(instant)).toBe("Wed, Oct 14");
  });
});

/**
 * THE DAY THE DEMO IS GIVEN ON — Firia's ruling, 2026-10-17 4:50 PM ET.
 *
 * The walk found "Wed, Oct 14" at the top of a board being looked at on the 17th: the scenario
 * is a recording of one seeded Wednesday, and the screens were printing the recording's own
 * date. The ruling is that the scenario day *is* today in the centre's timezone. These assert
 * the mapping both ways — the seeded day lands on today, and a day either side of it keeps its
 * distance — with the clock injected, so the test says the same thing on every day of the year.
 */
describe("the scenario day is today in New York", () => {
  const nyIso = (now: Date) => serviceDateIso(now);

  it("maps the scenario's own day onto today", () => {
    for (const now of [
      new Date("2026-10-17T16:00:00Z"),
      new Date("2027-03-02T05:00:00Z"),
      // Late evening in New York, which is already tomorrow in UTC: the site's day is the one
      // that counts, so this must still be the 17th and not the 18th.
      new Date("2026-10-18T02:30:00Z"),
    ]) {
      expect(demoDateIso(SCENARIO_SERVICE_DATE, now)).toBe(nyIso(now));
      expect(demoDateLabel(SCENARIO_SERVICE_DATE, now)).toBe(
        new Intl.DateTimeFormat("en-US", {
          timeZone: SITE_TIME_ZONE,
          weekday: "short",
          month: "short",
          day: "numeric",
        }).format(now),
      );
    }
  });

  it("writes it the way every screen writes a date", () => {
    const now = new Date("2026-10-17T16:00:00Z");
    expect(demoDateLabel(SCENARIO_SERVICE_DATE, now)).toBe("Sat, Oct 17");
    expect(demoDateLabel(SCENARIO_SERVICE_DATE, now)).toMatch(/^[A-Z][a-z]{2}, [A-Z][a-z]{2} \d{1,2}$/);
  });

  it("keeps a fixture day either side of the scenario's at its own distance", () => {
    const now = new Date("2026-10-17T16:00:00Z");
    // The scenario's seeded day is a Wednesday; the day before it is still the day before.
    expect(demoDateIso("2026-10-13", now)).toBe("2026-10-16");
    expect(demoDateLabel("2026-10-13", now)).toBe("Fri, Oct 16");
    expect(demoDateIso("2026-10-15", now)).toBe("2026-10-18");
    expect(demoDateLabel("2026-10-15", now)).toBe("Sun, Oct 18");
  });

  it("is the seeded Wednesday it claims to re-date, read from the fixtures", () => {
    expect(SCENARIO_SERVICE_DATE).toBe(serviceDateIso(new Date(SCENARIO_START_MS)));
    expect(serviceDateLabel(new Date(SCENARIO_START_MS))).toMatch(/^Wed, /);
  });

  it("crosses a daylight-saving boundary without losing a day", () => {
    // EDT → EST is the first Sunday of November; a day-arithmetic bug shows up as an off-by-one.
    const now = new Date("2026-11-02T17:00:00Z");
    expect(demoDateIso(SCENARIO_SERVICE_DATE, now)).toBe("2026-11-02");
    expect(demoDateIso("2026-10-13", now)).toBe("2026-11-01");
    expect(demoDateIso("2026-10-15", now)).toBe("2026-11-03");
  });
});
