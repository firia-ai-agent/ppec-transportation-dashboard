import { describe, expect, it } from "vitest";
import { defaultLeg, deriveReadiness, weekdayLabel, type DayFacts } from "./readiness";

/**
 * The order of the day (redesign spec §9.1, §9.4; Vera's binding interim rules of 2026-10-17
 * 3:00 PM ET). One helper decides it, so these are the assertions the step strip, every empty
 * state and the server guards all inherit.
 */

const facts = (over: Partial<DayFacts> = {}): DayFacts => ({
  date: "2026-10-17",
  leg: "PM",
  started: true,
  vans: 3,
  vansCheckedToday: 0,
  setupSource: "YESTERDAY",
  setupFromDate: "2026-10-16",
  planSavedAt: null,
  planSavedBy: null,
  unassigned: 9,
  vansOut: 0,
  approvalsWaiting: 0,
  ...over,
});

describe("van setup is soft, and says which day it is standing on (conflict C5)", () => {
  it("is Needed until every van has been confirmed today, and never Locked", () => {
    expect(deriveReadiness(facts()).setup).toMatchObject({ state: "NEEDED", checked: 0, total: 3 });
    expect(deriveReadiness(facts({ vansCheckedToday: 1 })).setup.state).toBe("NEEDED");
    expect(deriveReadiness(facts({ vansCheckedToday: 3 })).setup.state).toBe("DONE");
  });

  it("names the day a carried-forward setup was confirmed on, in three letters", () => {
    expect(deriveReadiness(facts()).setup.fromDay).toBe("Fri");
    expect(weekdayLabel("2026-10-17")).toBe("Sat");
    expect(weekdayLabel("not a date")).toBe("");
  });

  it("has no day to name when it is standing on the configured defaults", () => {
    const readiness = deriveReadiness(facts({ setupSource: "DEFAULT", setupFromDate: undefined }));
    expect(readiness.setup.source).toBe("DEFAULT");
    expect(readiness.setup.fromDay).toBeUndefined();
  });

  it("is Needed when there is no van at all, rather than Done over nothing", () => {
    expect(deriveReadiness(facts({ vans: 0, vansCheckedToday: 0 })).setup.state).toBe("NEEDED");
  });
});

describe("a plan is the hard step", () => {
  it("is Locked only while the day has not been started", () => {
    expect(deriveReadiness(facts({ started: false })).plan.state).toBe("LOCKED");
    expect(deriveReadiness(facts({ started: true })).plan.state).toBe("NEEDED");
  });

  it("is Done once one is saved, and carries when and by whom", () => {
    const readiness = deriveReadiness(
      facts({ planSavedAt: "2026-10-17T18:41:00.000Z", planSavedBy: "Dana M.", unassigned: 0 }),
    );
    expect(readiness.plan).toEqual({
      state: "DONE",
      savedAt: "2026-10-17T18:41:00.000Z",
      savedBy: "Dana M.",
      unassigned: 0,
    });
  });

  it("still says how many riders are in no van on a saved plan", () => {
    expect(deriveReadiness(facts({ planSavedAt: "2026-10-17T18:41:00.000Z", unassigned: 2 })).plan.unassigned).toBe(2);
  });
});

describe("live needs a plan, and says what is missing", () => {
  it("is locked by the day itself before anything else", () => {
    expect(deriveReadiness(facts({ started: false, planSavedAt: "2026-10-17T18:41:00.000Z" })).live).toEqual({
      state: "LOCKED",
      vansOut: 0,
      blockedBy: "START",
    });
  });

  it("is locked by the missing plan once the day is started", () => {
    expect(deriveReadiness(facts()).live).toEqual({ state: "LOCKED", vansOut: 0, blockedBy: "PLAN" });
  });

  it("is Not started with a plan and nothing moving, and Running once a van moves", () => {
    const saved = { planSavedAt: "2026-10-17T18:41:00.000Z" };
    expect(deriveReadiness(facts(saved)).live).toEqual({ state: "NEEDED", vansOut: 0 });
    expect(deriveReadiness(facts({ ...saved, vansOut: 2 })).live).toEqual({ state: "RUNNING", vansOut: 2 });
  });
});

describe("the rest of the object", () => {
  it("carries the date, the leg and the approvals waiting through unchanged", () => {
    const readiness = deriveReadiness(facts({ leg: "AM", approvalsWaiting: 2 }));
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
