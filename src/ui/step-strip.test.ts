import { describe, expect, it } from "vitest";
import { canOpenPage, pageRow, rolesWhoCanOpen, ROLE_LADDER } from "@/auth/access";
import { deriveReadiness, unreadFacts, type DayFacts } from "@/domain/day/readiness";
import { flow } from "./copy";
import { siteTimeLabel } from "./service-date";
import { stepItems, stepsFor, type StepKey, type StripStep } from "./step-strip";

/**
 * TODAY'S STEP STRIP — three cards, their states, and who gets a link to what.
 *
 * The states are injected rather than seeded (REDESIGN-SPEC §9.4's pure core is what makes that
 * possible), so every cell of role × state is a line here: what each card says, where it opens,
 * and whether it opens at all. The browser then walks the same strip for the three roles
 * (e2e/rework-frame.spec.ts).
 */
const DATE = "2026-10-17";

function day(over: Partial<DayFacts> = {}) {
  return deriveReadiness({
    date: DATE,
    leg: "PM",
    read: true,
    vans: 3,
    vansChecked: 0,
    planSavedAt: null,
    planUnplaced: null,
    ...over,
  });
}

/** A day with nothing done on it — the fresh day, and what a shell with no database shows. */
const FRESH = deriveReadiness(unreadFacts(DATE, "PM"));
/** A day whose plan is saved, so the live map is unlocked and opens itself. */
const PLANNED = day({
  vansChecked: 3,
  planSavedAt: new Date("2026-10-17T18:41:00Z"),
  planUnplaced: 0,
});
/** The same day, saved with two children still on the bench: saved, and not finished. */
const PLANNED_WITH_UNPLACED = day({
  vansChecked: 3,
  planSavedAt: new Date("2026-10-17T18:41:00Z"),
  planUnplaced: 2,
});

const byKey = (steps: readonly StripStep[], key: StepKey): StripStep =>
  steps.find((step) => step.key === key)!;

describe("the three steps", () => {
  it("lists the day's three steps in order, each pointing at a real page", () => {
    expect(stepItems.map((s) => s.href)).toEqual(["/ramp-ipad", "/plan-routes", "/live-map"]);
    for (const item of stepItems) expect(pageRow(item.href)).toBeDefined();
  });

  it("shows all three to every role, whatever they can open", () => {
    for (const role of [...ROLE_LADDER, null]) {
      expect(stepsFor(role, FRESH).map((s) => s.key)).toEqual(["setup", "plan", "live"]);
    }
  });
});

describe("what each card says", () => {
  it.each([
    [0, 3, "0/3 checked"],
    [2, 3, "2/3 checked"],
    [3, 3, "3/3 checked"],
  ] as const)("van setup with %i of %i checked reads %s", (vansChecked, vans, detail) => {
    const setup = byKey(stepsFor("DIRECTOR", day({ vans, vansChecked })), "setup");
    expect(setup.detail).toBe(detail);
    expect(setup.state).toBe(vansChecked === vans ? "DONE" : "NEEDED");
  });

  it("says 'Not saved' with no plan, and the minute it was saved at with one", () => {
    expect(byKey(stepsFor("DIRECTOR", FRESH), "plan").detail).toBe(flow.detail.planNone);
    const saved = byKey(stepsFor("DIRECTOR", PLANNED), "plan");
    expect(saved.state).toBe("DONE");
    // The minute in centre time, the way every other time on the console is written.
    expect(saved.detail).toBe(`Saved ${siteTimeLabel(new Date("2026-10-17T18:41:00Z"))}`);
    expect(saved.detail).toMatch(/^Saved \d{1,2}:\d{2} (AM|PM)$/);
  });

  /**
   * A BOARD SAVED WITH SOMEBODY ON THE BENCH (Vera, 2026-10-17 8:46 PM ET): the card says how
   * many and stays Needed, which is the amber chip — `STATE_MARKS` in src/ui/StepStrip.tsx maps
   * Needed to the warn tone, and src/ui/tokens.ts is the only place that amber is written down.
   */
  it("says how many are unplaced when a saved plan left somebody off it", () => {
    const plan = byKey(stepsFor("DIRECTOR", PLANNED_WITH_UNPLACED), "plan");
    expect(plan.detail).toBe("Saved · 2 unplaced");
    expect(plan.state).toBe("NEEDED");
    // Not a tick, and not the minute either: the number is the work left.
    expect(plan.detail).not.toMatch(/\d{1,2}:\d{2}/);
  });

  it("says one of them for one, with no sentence built around it", () => {
    const one = day({ planSavedAt: new Date("2026-10-17T18:41:00Z"), planUnplaced: 1 });
    expect(byKey(stepsFor("DIRECTOR", one), "plan").detail).toBe("Saved · 1 unplaced");
  });

  /**
   * And when the bench could not be counted: the card says the one thing that is known — the
   * minute it was saved at — and the chip still says Needed. A count that failed must never be
   * allowed to look like a board with everybody placed.
   */
  it("falls back to the minute, still Needed, when the bench is unreadable", () => {
    const unknown = day({ planSavedAt: new Date("2026-10-17T18:41:00Z"), planUnplaced: null });
    const plan = byKey(stepsFor("DIRECTOR", unknown), "plan");
    expect(plan.state).toBe("NEEDED");
    expect(plan.detail).toBe(`Saved ${siteTimeLabel(new Date("2026-10-17T18:41:00Z"))}`);
  });

  /**
   * THE LIVE MAP UNLOCKS ANYWAY. §9.1's hard arrow is about a plan *existing*; a child on the
   * bench does not take the vans off the road, so the map opens and the plan card is the one
   * carrying the unfinished work.
   */
  it("unlocks the live map on a saved plan that still has children unplaced", () => {
    const live = byKey(stepsFor("DIRECTOR", PLANNED_WITH_UNPLACED), "live");
    expect(live.state).toBe("NEEDED");
    expect(live.detail).toBe(flow.detail.liveNeeded);
    expect(live.href).toBe("/live-map");
    expect(live.linked).toBe(true);
  });

  /** The step to do next is then the plan, not the map: the first card that is not Done. */
  it("marks the plan as the step to do next while somebody is unplaced", () => {
    expect(
      stepsFor("DIRECTOR", PLANNED_WITH_UNPLACED)
        .filter((step) => step.current)
        .map((step) => step.key),
    ).toEqual(["plan"]);
  });

  it("says what the live map is waiting for, and what it is waiting at", () => {
    expect(byKey(stepsFor("DIRECTOR", FRESH), "live").detail).toBe(flow.detail.liveLocked);
    expect(byKey(stepsFor("DIRECTOR", PLANNED), "live").detail).toBe(flow.detail.liveNeeded);
  });

  /** §9.2: every state is an icon **and** a word, so the word is in the announcement too. */
  it("announces the step, its state and its detail in one line", () => {
    const setup = byKey(stepsFor("DIRECTOR", FRESH), "setup");
    expect(setup.ariaLabel).toBe(`${flow.steps.setup}: ${flow.state.needed}, ${setup.detail}`);
  });
});

/**
 * THE FIRST THING TO DO — `aria-current="step"` and the brand ring, on one card (§9.2).
 */
describe("the step to do next", () => {
  it("is the first card that is not Done", () => {
    expect(stepsFor("DIRECTOR", FRESH).filter((s) => s.current).map((s) => s.key)).toEqual([
      "setup",
    ]);
    expect(
      stepsFor("DIRECTOR", day({ vans: 3, vansChecked: 3 }))
        .filter((s) => s.current)
        .map((s) => s.key),
    ).toEqual(["plan"]);
    expect(stepsFor("DIRECTOR", PLANNED).filter((s) => s.current).map((s) => s.key)).toEqual([
      "live",
    ]);
  });

  it("is marked on exactly one card, for every role and both days", () => {
    for (const role of ROLE_LADDER) {
      for (const readiness of [FRESH, PLANNED]) {
        expect(stepsFor(role, readiness).filter((s) => s.current)).toHaveLength(1);
      }
    }
  });
});

/**
 * A LOCKED CARD OPENS THE STEP THAT IS MISSING (§9.2: a locked card is still a link, and the
 * clearer form of that is for the link to go to the thing that would unlock it).
 */
describe("where a locked card goes", () => {
  it("sends the live map to Plan routes, and says so in its accessible name", () => {
    const live = byKey(stepsFor("DIRECTOR", FRESH), "live");
    expect(live.state).toBe("LOCKED");
    expect(live.href).toBe("/plan-routes");
    expect(live.ariaLabel).toContain(flow.steps.plan);
    expect(live.ariaLabel).toBe(
      `${flow.steps.live}: ${flow.state.locked}, ${flow.detail.liveLocked}. Opens ${flow.steps.plan}`,
    );
  });

  it("sends it to the live map once there is a plan, with nothing extra said", () => {
    const live = byKey(stepsFor("DIRECTOR", PLANNED), "live");
    expect(live.href).toBe("/live-map");
    expect(live.ariaLabel).not.toContain(flow.steps.plan);
  });

  it("leaves the two steps that are never locked pointing at themselves", () => {
    for (const readiness of [FRESH, PLANNED]) {
      const steps = stepsFor("DIRECTOR", readiness);
      expect(byKey(steps, "setup").href).toBe("/ramp-ipad");
      expect(byKey(steps, "plan").href).toBe("/plan-routes");
    }
  });
});

/**
 * ROLE × STATE, every cell: a card is a link exactly where the access table opens the page it
 * would actually go to. Never a dead link, and never a link into a 403.
 */
describe("who gets a link to what", () => {
  it.each(ROLE_LADDER)("%s is only linked to a screen its role can open", (role) => {
    for (const readiness of [FRESH, PLANNED]) {
      for (const step of stepsFor(role, readiness)) {
        const allowed = rolesWhoCanOpen(step.href).includes(role);
        expect(canOpenPage({ kind: "STAFF", role }, step.href)).toBe(allowed);
        expect(step.linked, `${role} / ${step.key} / ${step.state}`).toBe(allowed);
      }
    }
  });

  it("gives the front desk Ramp iPad, and the live map only once it is unlocked", () => {
    /*
     * Their live-map card is Locked on a fresh day, so it would open `/plan-routes` — a console
     * page that is not theirs — and a locked card whose missing step a role cannot reach is
     * plain text rather than a link to a refusal. Once a plan exists the card opens the live
     * map itself, which they may open, so it becomes a link.
     */
    expect(
      stepsFor("FRONT_DESK", FRESH).filter((s) => s.linked).map((s) => s.href),
    ).toEqual(["/ramp-ipad"]);
    expect(
      stepsFor("FRONT_DESK", PLANNED).filter((s) => s.linked).map((s) => s.href),
    ).toEqual(["/ramp-ipad", "/live-map"]);
    // Plan routes is never theirs, in either state.
    for (const readiness of [FRESH, PLANNED]) {
      expect(byKey(stepsFor("FRONT_DESK", readiness), "plan").linked).toBe(false);
    }
  });

  it("gives a director and a coordinator all three once nothing is locked", () => {
    for (const role of ["DIRECTOR", "COORDINATOR"] as const) {
      expect(stepsFor(role, PLANNED).every((s) => s.linked)).toBe(true);
      // …and on a fresh day the locked card still opens Plan routes, which is theirs.
      expect(stepsFor(role, FRESH).every((s) => s.linked)).toBe(true);
    }
  });

  it("links nothing for a caller with no role", () => {
    for (const readiness of [FRESH, PLANNED]) {
      expect(stepsFor(null, readiness).some((s) => s.linked)).toBe(false);
    }
  });
});

/**
 * THE DAY NOBODY COULD READ — the strip a browser check with no database sees, and the strip a
 * founder sees if the query fails. Nothing on it claims anything is done.
 */
describe("a day that could not be read", () => {
  it("shows Needed, Needed and Locked, and no Done anywhere", () => {
    const steps = stepsFor("DIRECTOR", FRESH);
    expect(steps.map((s) => s.state)).toEqual(["NEEDED", "NEEDED", "LOCKED"]);
    expect(steps.map((s) => s.detail)).toEqual([
      "0/0 checked",
      flow.detail.planNone,
      flow.detail.liveLocked,
    ]);
  });
});
