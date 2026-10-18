import { describe, expect, it } from "vitest";
import {
  defaultLeg,
  deriveReadiness,
  unreadFacts,
  weekdayLabel,
  type DayFacts,
  type Leg,
} from "./readiness";
import { legAt, serviceDateAt } from "./day-facts";

/**
 * THE DAY'S READINESS, every combination of it.
 *
 * REDESIGN-SPEC §9.4 asks for a pure core and a thin loader so that exactly this is possible:
 * the states a founder reads off the step strip are decided by a function with no database
 * under it, so "0/3 checked", "3/3 checked" and "the live map is locked because nothing is
 * saved" are each a line in a test rather than a seeded row somebody has to go and look at.
 *
 * Facts are injected here, which is the seam the browser checks use too — a session with no
 * site reads nothing and gets the unread day (src/domain/day/day-facts.ts).
 */
const DATE = "2026-10-17";

function facts(over: Partial<DayFacts> = {}): DayFacts {
  return { date: DATE, leg: "PM", read: true, vans: 3, vansChecked: 0, planSavedAt: null, ...over };
}

describe("van setup", () => {
  it.each([
    [0, 3, "NEEDED"],
    [1, 3, "NEEDED"],
    [2, 3, "NEEDED"],
    [3, 3, "DONE"],
  ] as const)("%i of %i vans checked is %s", (vansChecked, vans, state) => {
    const day = deriveReadiness(facts({ vans, vansChecked }));
    expect(day.setup.state).toBe(state);
    expect(day.setup.checked).toBe(vansChecked);
    expect(day.setup.total).toBe(vans);
  });

  /**
   * A site with no vans is not a site that has finished checking them. §9.3 gives "No vans yet"
   * its own empty state; a tick here would be congratulating nobody.
   */
  it("is Needed, not Done, when the site has no vans at all", () => {
    expect(deriveReadiness(facts({ vans: 0, vansChecked: 0 })).setup.state).toBe("NEEDED");
  });

  /** §9.1: Van setup → Plan routes is a *soft* arrow, so this step is never Locked. */
  it("is never Locked, whatever the day looks like", () => {
    const every = [
      facts({ vansChecked: 0 }),
      facts({ vansChecked: 3 }),
      facts({ vans: 0 }),
      unreadFacts(DATE, "AM"),
    ];
    for (const f of every) expect(String(deriveReadiness(f).setup.state)).not.toBe("LOCKED");
  });
});

describe("plan routes", () => {
  it("is Needed with no saved plan for this leg", () => {
    const day = deriveReadiness(facts({ planSavedAt: null }));
    expect(day.plan.state).toBe("NEEDED");
    expect(day.plan.savedAt).toBeNull();
  });

  it("is Done once a plan is saved, and carries the minute it was saved at", () => {
    const at = new Date("2026-10-17T18:41:00Z");
    const day = deriveReadiness(facts({ planSavedAt: at }));
    expect(day.plan.state).toBe("DONE");
    expect(day.plan.savedAt).toEqual(at);
  });

  it("answers for the leg it was asked about, and says which that was", () => {
    for (const leg of ["AM", "PM"] as const) {
      expect(deriveReadiness(facts({ leg })).leg).toBe(leg);
    }
  });
});

describe("live map", () => {
  /** §9.1's one hard arrow here: "No saved plan = no routes, no ETAs". */
  it("is Locked on the plan while none is saved", () => {
    const day = deriveReadiness(facts({ planSavedAt: null }));
    expect(day.live.state).toBe("LOCKED");
    expect(day.live.blockedBy).toBe("PLAN");
  });

  it("unlocks to Needed the moment a plan exists, however little else does", () => {
    const day = deriveReadiness(facts({ vansChecked: 0, planSavedAt: new Date() }));
    expect(day.live.state).toBe("NEEDED");
    expect(day.live.blockedBy).toBeNull();
  });

  /**
   * §9.2 draws a fourth state, `Running`, for a live map with vans moving on it. Nothing in this
   * build records that a van has left the depot — the positions the map draws are the scenario's
   * replay, not a report from a van — so the derivation cannot produce it and the type does not
   * have it. It lands with the fact that would back it.
   */
  it("is never Running, because no fact in this build says a van has moved", () => {
    const every = [facts(), facts({ planSavedAt: new Date() }), unreadFacts(DATE, "PM")];
    for (const f of every) expect(String(deriveReadiness(f).live.state)).not.toBe("RUNNING");
  });
});

/**
 * THE FAIL-SAFE. §9.4: a module that cannot load must not blank the shell — and a strip that
 * said "3/3 checked" because a query threw would be worse than one that said nothing.
 */
describe("a day that could not be read", () => {
  const unread = deriveReadiness(unreadFacts(DATE, "AM"));

  it("shows Needed, Needed and Locked — never a Done", () => {
    expect(unread.setup.state).toBe("NEEDED");
    expect(unread.plan.state).toBe("NEEDED");
    expect(unread.live.state).toBe("LOCKED");
  });

  it("counts nothing rather than counting what it did not read", () => {
    expect(unread.setup).toMatchObject({ checked: 0, total: 0 });
    expect(unread.plan.savedAt).toBeNull();
  });

  /** Even handed counts, an unread day reports none: `read: false` is the whole answer. */
  it("ignores any counts that came with it", () => {
    const day = deriveReadiness({
      date: DATE,
      leg: "PM",
      read: false,
      vans: 3,
      vansChecked: 3,
      planSavedAt: new Date(),
    });
    expect(day.setup).toMatchObject({ state: "NEEDED", checked: 0, total: 0 });
    expect(day.plan.state).toBe("NEEDED");
    expect(day.live.state).toBe("LOCKED");
  });

  it("still says which day and which leg it is about", () => {
    expect(unread.date).toBe(DATE);
    expect(unread.leg).toBe("AM");
  });
});

/**
 * The leg is the centre's clock, not the reader's (§9.1: "before 12:00 PM centre time the
 * default leg is Morning, after it Afternoon"). Written as instants in UTC, so the boundary is
 * checked where it actually falls in New York rather than where it falls for whoever runs this.
 */
describe("which leg the day is on", () => {
  it.each([
    ["2026-10-17T04:00:00Z", "AM"], // 12:00 AM ET
    ["2026-10-17T15:59:00Z", "AM"], // 11:59 AM ET
    ["2026-10-17T16:00:00Z", "PM"], // 12:00 PM ET, the boundary itself
    ["2026-10-17T23:30:00Z", "PM"], // 7:30 PM ET
  ] as const)("%s at the centre is %s", (iso, leg: Leg) => {
    expect(legAt(new Date(iso))).toBe(leg);
  });

  it("reads the service date from the same clock", () => {
    // 1:00 AM UTC on the 18th is still the 17th in New York, and both answers must agree.
    expect(serviceDateAt(new Date("2026-10-18T01:00:00Z"))).toBe("2026-10-17");
    expect(legAt(new Date("2026-10-18T01:00:00Z"))).toBe("PM");
  });
});

/* ─────────────── the planned day's own facts (#73's board, merged in) ─────────────── */

/**
 * The same helper for the facts a *planned* day has: whether the demo day was started, which
 * counts it stands on, how many riders are in no van, how many vans have moved. These came in
 * with the board (#73) and are asserted here because there is one readiness module, not two.
 */
const planned = (over: Partial<DayFacts> = {}): DayFacts => ({
  date: DATE,
  leg: "PM",
  read: true,
  started: true,
  vans: 3,
  vansChecked: 0,
  setupSource: "DEFAULT",
  planSavedAt: null,
  planSavedBy: null,
  unassigned: 9,
  vansOut: 0,
  approvalsWaiting: 0,
  ...over,
});

describe("van setup is soft, and says which day it is standing on (conflict C5)", () => {
  it("is Needed until every van has been confirmed today, and never Locked", () => {
    expect(deriveReadiness(planned()).setup).toMatchObject({ state: "NEEDED", checked: 0, total: 3 });
    expect(deriveReadiness(planned({ vansChecked: 1 })).setup.state).toBe("NEEDED");
    expect(deriveReadiness(planned({ vansChecked: 3 })).setup.state).toBe("DONE");
  });

  /**
   * Firia/Veri, 2026-10-17 6:00 PM ET: there is no carry-over rung and no day to name. A van is
   * on today's confirmed counts or on the shared config's defaults, and the readiness object has
   * exactly those two sources — nothing that could render "From Fri".
   */
  it("stands on one of two sources, and names no earlier day", () => {
    expect(deriveReadiness(planned()).setup.source).toBe("DEFAULT");
    expect(deriveReadiness(planned({ setupSource: "CHECKED", vansChecked: 3 })).setup.source).toBe(
      "CHECKED",
    );
    expect(deriveReadiness(planned()).setup).not.toHaveProperty("fromDay");
    // The weekday helper is still here for the times a *date* is read out, and is not a setup line.
    expect(weekdayLabel("2026-10-17")).toBe("Sat");
    expect(weekdayLabel("not a date")).toBe("");
  });

  it("is Needed when there is no van at all, rather than Done over nothing", () => {
    expect(deriveReadiness(planned({ vans: 0, vansChecked: 0 })).setup.state).toBe("NEEDED");
  });
});

describe("a plan is the hard step", () => {
  it("is Locked only while the day has not been started", () => {
    expect(deriveReadiness(planned({ started: false })).plan.state).toBe("LOCKED");
    expect(deriveReadiness(planned({ started: true })).plan.state).toBe("NEEDED");
  });

  it("is Done once one is saved, and carries when and by whom", () => {
    const readiness = deriveReadiness(
      planned({ planSavedAt: "2026-10-17T18:41:00.000Z", planSavedBy: "Dana M.", unassigned: 0 }),
    );
    expect(readiness.plan).toEqual({
      state: "DONE",
      savedAt: new Date("2026-10-17T18:41:00.000Z"),
      savedBy: "Dana M.",
      unassigned: 0,
    });
  });

  it("still says how many riders are in no van on a saved plan", () => {
    expect(deriveReadiness(planned({ planSavedAt: "2026-10-17T18:41:00.000Z", unassigned: 2 })).plan.unassigned).toBe(2);
  });
});

describe("live needs a plan, and says what is missing", () => {
  it("is locked by the day itself before anything else", () => {
    expect(deriveReadiness(planned({ started: false, planSavedAt: "2026-10-17T18:41:00.000Z" })).live).toEqual({
      state: "LOCKED",
      vansOut: 0,
      blockedBy: "START",
    });
  });

  it("is locked by the missing plan once the day is started", () => {
    expect(deriveReadiness(planned()).live).toEqual({ state: "LOCKED", vansOut: 0, blockedBy: "PLAN" });
  });

  it("is Not started with a plan and nothing moving, and Running once a van moves", () => {
    const saved = { planSavedAt: "2026-10-17T18:41:00.000Z" };
    expect(deriveReadiness(planned(saved)).live).toEqual({
      state: "NEEDED",
      vansOut: 0,
      blockedBy: null,
    });
    expect(deriveReadiness(planned({ ...saved, vansOut: 2 })).live).toEqual({
      state: "RUNNING",
      vansOut: 2,
      blockedBy: null,
    });
  });
});

describe("the rest of the object", () => {
  it("carries the date, the leg and the approvals waiting through unchanged", () => {
    const readiness = deriveReadiness(planned({ leg: "AM", approvalsWaiting: 2 }));
    expect(readiness).toMatchObject({ date: "2026-10-17", leg: "AM", started: true });
    expect(readiness.approvals).toEqual({ waiting: 2 });
  });

  it("§9.1: the leg a screen opens on is the morning until noon in centre time", () => {
    expect(defaultLeg(0)).toBe("AM");
    expect(defaultLeg(11)).toBe("AM");
    expect(defaultLeg(12)).toBe("PM");
    expect(defaultLeg(23)).toBe("PM");
  });
});
