import { describe, expect, it } from "vitest";
import type { Exec } from "@/domain/transition";
import { readRightNow } from "@/domain/health/right-now-facts";
import { getDayReadiness, legAt, legFor, serviceDateAt } from "./day-facts";

/**
 * TODAY AND HEALTH FOLLOW `?leg=` WHEN THE ADDRESS NAMES ONE, AND THE CLOCK WHEN IT DOES NOT.
 *
 * SOURCE: Firia's S1 add-on of 2026-10-18, and §9.3 ("deep links keep state in the URL"). The
 * step cards and the four Right-now tiles took their leg from the clock alone, so a coordinator
 * who followed a morning link from the plan board or from the ramp iPad's van tabs at 2 PM read
 * the afternoon's steps under the morning's board. The leg in the address is a decision somebody
 * already made and the clock does not overrule it.
 *
 * With no `?leg=` nothing changes: {@link legAt} answers, in centre time, exactly as before —
 * which is the half of this that is asserted hardest, because it is the behaviour of every other
 * link in the app.
 */

/** 07:30 and 13:30 at the centre on the same service date. */
const MORNING = new Date("2026-10-16T11:30:00.000Z");
const AFTERNOON = new Date("2026-10-16T17:30:00.000Z");

describe("legFor: the address, then the clock", () => {
  it("is the clock's answer when the address names no leg", () => {
    expect(legAt(MORNING)).toBe("AM");
    expect(legAt(AFTERNOON)).toBe("PM");
    expect(legFor(undefined, MORNING)).toBe("AM");
    expect(legFor(undefined, AFTERNOON)).toBe("PM");
  });

  it("is the address's answer when it names one, whatever the hour is", () => {
    expect(legFor("AM", AFTERNOON)).toBe("AM");
    expect(legFor("PM", MORNING)).toBe("PM");
    expect(legFor("AM", MORNING)).toBe("AM");
    expect(legFor("PM", AFTERNOON)).toBe("PM");
  });
});

describe("the step cards", () => {
  /** No site behind the session: the unread path, which still names the day and the leg. */
  it("read the leg the address names, and the clock's when it names none", async () => {
    expect((await getDayReadiness({ siteId: null, now: AFTERNOON })).leg).toBe("PM");
    expect((await getDayReadiness({ siteId: null, now: AFTERNOON, leg: "AM" })).leg).toBe("AM");
    expect((await getDayReadiness({ siteId: null, now: MORNING })).leg).toBe("AM");
    expect((await getDayReadiness({ siteId: null, now: MORNING, leg: "PM" })).leg).toBe("PM");
    // The date is the clock's either way: `?leg=` says which half of a day, never which day.
    expect((await getDayReadiness({ siteId: null, now: AFTERNOON, leg: "AM" })).date).toBe(
      serviceDateAt(AFTERNOON),
    );
  });
});

describe("the Health tiles", () => {
  /** An exec that answers nothing and remembers what it was asked, so the leg is readable. */
  function recorder(): { exec: Exec; legs: () => string[] } {
    const seen: unknown[][] = [];
    return {
      exec: {
        query: async <R>(_sql: string, params: unknown[]) => {
          seen.push(params);
          return { rows: [] as R[] };
        },
      },
      legs: () =>
        seen
          .map((params) => params[2])
          .filter((value): value is string => value === "AM" || value === "PM"),
    };
  }

  it("count the leg the address names, and the clock's when it names none", async () => {
    const byClock = recorder();
    await readRightNow({ siteId: "site", now: AFTERNOON, exec: byClock.exec });
    expect(byClock.legs().length).toBeGreaterThan(0);
    expect([...new Set(byClock.legs())]).toEqual(["PM"]);

    const byAddress = recorder();
    await readRightNow({ siteId: "site", now: AFTERNOON, leg: "AM", exec: byAddress.exec });
    expect([...new Set(byAddress.legs())]).toEqual(["AM"]);

    const morning = recorder();
    await readRightNow({ siteId: "site", now: MORNING, exec: morning.exec });
    expect([...new Set(morning.legs())]).toEqual(["AM"]);
  });
});
