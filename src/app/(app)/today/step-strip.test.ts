import { describe, expect, it } from "vitest";
import { flow } from "@/ui/copy";
import type { DayReadiness } from "@/domain/day/readiness";
import { currentStep, stepsOf } from "./step-strip";

/**
 * The step strip's words and states (redesign spec §9.2, §9.5; Vera's interim rules).
 *
 * The component draws whatever this says, so this is where the rules are held: three steps in the
 * order of the day, every state with a word as well as a tone, and every card carrying the day
 * and the leg in its address so a click keeps the view a person was looking at.
 */

const readiness = (over: Partial<DayReadiness> = {}): DayReadiness => ({
  date: "2026-10-17",
  leg: "PM",
  started: true,
  setup: { state: "NEEDED", checked: 0, total: 3, source: "YESTERDAY", fromDay: "Fri" },
  plan: { state: "NEEDED", unassigned: 9 },
  live: { state: "LOCKED", vansOut: 0, blockedBy: "PLAN" },
  approvals: { waiting: 0 },
  ...over,
});

describe("§9.2: three steps, in the order of the day", () => {
  it("is Van setup, Plan routes, Live map — each carrying the date and the leg", () => {
    const steps = stepsOf(readiness());
    expect(steps.map((step) => step.key)).toEqual(["setup", "plan", "live"]);
    expect(steps.map((step) => step.name)).toEqual([
      flow.steps.setup,
      flow.steps.plan,
      flow.steps.live,
    ]);
    for (const step of steps) {
      expect(step.href).toMatch(/\?date=2026-10-17&leg=pm$/);
    }
    expect(steps[0].href).toContain("/ramp-ipad");
    expect(steps[1].href).toContain("/plan-routes");
    expect(steps[2].href).toContain("/live-map");
  });

  it("gives every state a word and an icon, never a tone on its own", () => {
    const steps = stepsOf(readiness());
    for (const step of steps) {
      expect(step.label.length, step.key).toBeGreaterThan(0);
      // A lucide icon is a forwardRef object rather than a plain function component.
      expect(step.icon, step.key).toBeTruthy();
    }
    expect(steps.map((step) => step.label)).toEqual([
      flow.state.needed,
      flow.state.needed,
      flow.state.locked,
    ]);
  });
});

describe("§9.5: what each step says about itself", () => {
  it("names the day the van setups came from until one is confirmed today", () => {
    expect(stepsOf(readiness())[0].detail).toBe("From Fri");
    // One Confirm on the ramp and the count is the more useful fact, even while the other two
    // vans are still on yesterday's numbers (§9.6 #5).
    expect(
      stepsOf(
        readiness({ setup: { state: "NEEDED", checked: 1, total: 3, source: "YESTERDAY", fromDay: "Fri" } }),
      )[0].detail,
    ).toBe("1/3 checked");
    expect(
      stepsOf(readiness({ setup: { state: "NEEDED", checked: 1, total: 3, source: "TODAY" } }))[0].detail,
    ).toBe("1/3 checked");
    expect(
      stepsOf(readiness({ setup: { state: "DONE", checked: 3, total: 3, source: "TODAY" } }))[0],
    ).toMatchObject({ detail: "3/3 checked", label: flow.state.done, state: "DONE" });
  });

  it("says when the plan was saved, and says so in centre time", () => {
    const done = stepsOf(
      readiness({ plan: { state: "DONE", savedAt: "2026-10-17T18:41:00.000Z", unassigned: 0 } }),
    )[1];
    expect(done).toMatchObject({ detail: "Saved 2:41 PM", label: flow.state.done });
    expect(stepsOf(readiness())[1].detail).toBe(flow.plan.detailNone);
  });

  it("says a day nobody has started has to be started first", () => {
    const steps = stepsOf(
      readiness({
        started: false,
        plan: { state: "LOCKED", unassigned: 9 },
        live: { state: "LOCKED", vansOut: 0, blockedBy: "START" },
      }),
    );
    expect(steps[1]).toMatchObject({ detail: flow.plan.detailNotStarted, label: flow.state.locked });
    expect(steps[2].detail).toBe(flow.plan.detailNotStarted);
  });

  it("says the live map needs a plan, then that nothing is moving, then how many are", () => {
    expect(stepsOf(readiness())[2].detail).toBe(flow.live.detailLocked);
    expect(stepsOf(readiness({ live: { state: "NEEDED", vansOut: 0 } }))[2].detail).toBe(
      flow.live.detailNeeded,
    );
    expect(stepsOf(readiness({ live: { state: "RUNNING", vansOut: 2 } }))[2]).toMatchObject({
      detail: "2 vans out",
      label: flow.state.running,
    });
  });
});

describe("§9.2: which card is the current step", () => {
  it("is the first one that is not done", () => {
    expect(currentStep(stepsOf(readiness()))?.key).toBe("setup");
    expect(
      currentStep(
        stepsOf(readiness({ setup: { state: "DONE", checked: 3, total: 3, source: "TODAY" } })),
      )?.key,
    ).toBe("plan");
  });

  it("marks nothing on a day that is done and running", () => {
    const steps = stepsOf(
      readiness({
        setup: { state: "DONE", checked: 3, total: 3, source: "TODAY" },
        plan: { state: "DONE", savedAt: "2026-10-17T18:41:00.000Z", unassigned: 0 },
        live: { state: "RUNNING", vansOut: 3 },
      }),
    );
    expect(currentStep(steps)).toBeNull();
  });
});
