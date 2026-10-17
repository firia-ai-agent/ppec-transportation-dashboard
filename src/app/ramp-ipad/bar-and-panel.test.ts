import { describe, expect, it } from "vitest";
import { feasible } from "@/domain/solver";
import {
  arrivedResult,
  arrivedVerdict,
  rampArrivals,
  replanForArrival,
  type RampArrival,
} from "@/domain/plan/arrival";
import { MEASURED_AT_ARRIVAL, PLAN_SERVICE_DATE } from "@/domain/plan/day";
import { holdLines } from "@/ui/arrival-lines";
import { fill, rampIpad } from "@/ui/copy";
import {
  availableSummary,
  bannerCopy,
  defaultChecklist,
  findingOfChecklist,
  layoutOf,
  needSummary,
  toCapability,
  type Checklist,
} from "./capability";

/**
 * The sticky bar and the panel under it answer the same question, so they cannot disagree.
 *
 * Veri's review of 53423de (2026-10-17, approved by Firia): the bar read "Fits: 1 wheelchair,
 * 3 walking seats" over a panel that said Zoe B. does not fit, and the boarding lock followed
 * the bar — "Confirm boarding & securement" was live for a run the solver had already refused.
 * The cause was two computations: the bar asked `feasible()` itself, about the children's
 * *on-file* chair measurements, and the panel read the re-plan, which asks with the chair the
 * ramp measured (AT-04).
 *
 * The bar's verdict comes from the re-plan now (`arrivedResult`). What this file holds is that
 * the two really do differ for this child — so the assertion below cannot pass by both answers
 * happening to be the same — and that the one the screen shows is the panel's.
 */

/** The convertible van, which is the lane Zoe B.'s chair rides on. */
const ARRIVAL: RampArrival = rampArrivals().find((a) => a.laneId === "V1")!;
const CHAIR_CHILD = "C6";

/** The van as the e2e walk answers for it: the configuration it arrived in, everything usable. */
function fullyChecked(arrival: RampArrival): Checklist {
  const base = defaultChecklist(arrival.vehicle, arrival.plannedLayoutId);
  const layout = layoutOf(arrival.vehicle, base.layoutId);
  return {
    ...base,
    lift: "YES",
    latch: "YES",
    positions: Object.fromEntries(layout.positions.map((p) => [p.id, "FREE" as const])),
  };
}

const CHECKLIST = fullyChecked(ARRIVAL);
const NEED = needSummary(ARRIVAL.leg);
const AVAILABLE = availableSummary(ARRIVAL.vehicle, CHECKLIST);

/** What the bar says, built exactly as the screen builds it. */
function barTitle(measured: readonly string[]): string {
  const replan = replanForArrival(findingOfChecklist(ARRIVAL, CHECKLIST, measured));
  return bannerCopy(arrivedResult(replan), NEED, AVAILABLE).title;
}

describe("a chair measured bigger than the file said", () => {
  it("is a measurement the two computations disagree about, which is the whole bug", () => {
    // The van itself is fine, so the question the bar used to ask — this van, these children as
    // the file describes them — still answers "fits". That is what made the bar wrong rather
    // than merely stale, and why this test would pass vacuously without this line.
    const onFile = feasible(
      ARRIVAL.vehicle,
      ARRIVAL.leg,
      toCapability(ARRIVAL.vehicle, CHECKLIST, PLAN_SERVICE_DATE),
    );
    expect(onFile.status).toBe("FEASIBLE");
    expect(MEASURED_AT_ARRIVAL[CHAIR_CHILD].wcLengthCm).toBe(142);
    expect(MEASURED_AT_ARRIVAL[CHAIR_CHILD].wcWidthCm).toBe(74);
  });

  it("leaves the panel holding her, with no van on the day that takes the chair", () => {
    const replan = replanForArrival(findingOfChecklist(ARRIVAL, CHECKLIST, [CHAIR_CHILD]));
    expect(holdLines(replan).map((line) => line.childToken)).toContain(CHAIR_CHILD);
    expect(arrivedVerdict(replan)).toBe("INFEASIBLE");
  });

  it("and the bar says so too, in the same words it would say about the van", () => {
    const title = barTitle([CHAIR_CHILD]);
    // Never "Fits …", in any of its forms: that is the sentence Veri found over the hold.
    expect(title).not.toContain("Fits");
    expect(title).not.toBe(rampIpad.fitsNobody);
    // It says the one thing a ramp can act on: the chair is bigger than the place it has.
    expect(title).toBe(
      fill(rampIpad.doesntFit, { phrase: rampIpad.deficitFootprint }),
    );
  });

  it("agrees with the panel before the chair is measured, too", () => {
    // The same van, the same checklist, nothing measured: the run fits, and both say so.
    const replan = replanForArrival(findingOfChecklist(ARRIVAL, CHECKLIST, []));
    expect(arrivedVerdict(replan)).toBe("FEASIBLE");
    expect(barTitle([])).toContain("Fits");
    expect(holdLines(replan)).toEqual([]);
  });

  /**
   * The lock is the third reader of that one verdict (PRD §9: the solver blocks the manifest
   * lock), and the reason it has to be the same one: a bar that says "fits" over a disabled
   * button is confusing, and a bar that says "fits" over an *enabled* button on a run the
   * solver refused is a child boarded into a chair position that does not hold their chair.
   */
  it("locks boarding off the same verdict, never off a second one", () => {
    const replan = replanForArrival(findingOfChecklist(ARRIVAL, CHECKLIST, [CHAIR_CHILD]));
    const result = arrivedResult(replan);
    expect(result.status).not.toBe("FEASIBLE");
    // Which is what the screen turns into `blockedReason`, and so into `disabled`.
    expect(result.status === "CAPABILITY_PENDING"
      ? rampIpad.blockedPending
      : rampIpad.blockedInfeasible).toBe(rampIpad.blockedInfeasible);
  });
});
