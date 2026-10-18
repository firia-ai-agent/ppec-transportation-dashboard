import { describe, expect, it } from "vitest";
import { deriveReadiness, unreadFacts, type DayFacts, type Leg } from "./readiness";
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
  return {
    date: DATE,
    leg: "PM",
    read: true,
    vans: 3,
    vansChecked: 0,
    planSavedAt: null,
    planUnplaced: null,
    ...over,
  };
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

/**
 * PLAN ROUTES, and the rule Vera added on 2026-10-17 at 8:46 PM ET: a board that is saved is
 * not a board that is *finished*. A child still in the `UNASSIGNED` bucket has no ride, so the
 * step stays Needed and says how many — which is the amber card rather than the tick.
 */
describe("plan routes", () => {
  const SAVED_AT = new Date("2026-10-17T18:41:00Z");

  it("is Needed with no saved plan for this leg, and counts nobody", () => {
    const day = deriveReadiness(facts({ planSavedAt: null, planUnplaced: 0 }));
    expect(day.plan.state).toBe("NEEDED");
    expect(day.plan.savedAt).toBeNull();
    // No plan, no count: `unplaced` is about the children on a board that exists.
    expect(day.plan.unplaced).toBeNull();
  });

  it("is Done once a plan is saved with everybody placed, and carries the minute", () => {
    const day = deriveReadiness(facts({ planSavedAt: SAVED_AT, planUnplaced: 0 }));
    expect(day.plan.state).toBe("DONE");
    expect(day.plan.savedAt).toEqual(SAVED_AT);
    expect(day.plan.unplaced).toBe(0);
  });

  it.each([1, 2, 7])("is Needed when the saved plan left %i on the bench", (unplaced) => {
    const day = deriveReadiness(facts({ planSavedAt: SAVED_AT, planUnplaced: unplaced }));
    expect(day.plan.state).toBe("NEEDED");
    // ...and it still knows the plan is there, and how many are not on it.
    expect(day.plan.savedAt).toEqual(SAVED_AT);
    expect(day.plan.unplaced).toBe(unplaced);
  });

  /**
   * THE FAIL-SAFE ON THE COUNT. A bench count that could not be read is `null`, and `null` is
   * not zero: the one answer that must never fall out of a failed read is "everybody is
   * placed", because that is the one that ticks the card.
   */
  it("is Needed when the plan is saved and the bench could not be counted", () => {
    const day = deriveReadiness(facts({ planSavedAt: SAVED_AT, planUnplaced: null }));
    expect(day.plan.state).toBe("NEEDED");
    expect(day.plan.savedAt).toEqual(SAVED_AT);
    expect(day.plan.unplaced).toBeNull();
  });

  it("is Done for exactly one of the four, and it is the one with an empty bench", () => {
    const states = [null, 0, 2, undefined].map((unplaced) =>
      deriveReadiness(
        facts({
          planSavedAt: unplaced === undefined ? null : SAVED_AT,
          planUnplaced: unplaced === undefined ? null : unplaced,
        }),
      ).plan.state,
    );
    expect(states).toEqual(["NEEDED", "DONE", "NEEDED", "NEEDED"]);
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
    const day = deriveReadiness(facts({ vansChecked: 0, planSavedAt: new Date(), planUnplaced: 0 }));
    expect(day.live.state).toBe("NEEDED");
    expect(day.live.blockedBy).toBeNull();
  });

  /**
   * IT UNLOCKS ON SAVED, NOT ON DONE (Vera, 2026-10-17 8:46 PM ET). A board with one child on
   * the bench still has routes, ETAs and vans on the road: locking the map over it would hide
   * the day from the person running it, and the thing that is unfinished is said on the card
   * that is unfinished.
   */
  it.each([1, 5, null] as const)(
    "unlocks with a saved plan even when the bench reads %s",
    (unplaced) => {
      const day = deriveReadiness(facts({ planSavedAt: new Date(), planUnplaced: unplaced }));
      expect(day.plan.state, "the plan card is the one that says it is unfinished").toBe("NEEDED");
      expect(day.live.state).toBe("NEEDED");
      expect(day.live.blockedBy).toBeNull();
    },
  );

  /**
   * §9.2 draws a fourth state, `Running`, for a live map with vans moving on it. Nothing in this
   * build records that a van has left the depot — the positions the map draws are the scenario's
   * replay, not a report from a van — so the derivation cannot produce it and the type does not
   * have it. It lands with the fact that would back it.
   */
  it("is never Running, because no fact in this build says a van has moved", () => {
    const every = [
      facts(),
      facts({ planSavedAt: new Date(), planUnplaced: 0 }),
      facts({ planSavedAt: new Date(), planUnplaced: 3 }),
      unreadFacts(DATE, "PM"),
    ];
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
    expect(unread.plan.unplaced).toBeNull();
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
      planUnplaced: 0,
    });
    expect(day.setup).toMatchObject({ state: "NEEDED", checked: 0, total: 0 });
    expect(day.plan).toMatchObject({ state: "NEEDED", savedAt: null, unplaced: null });
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
