import { describe, expect, it } from "vitest";
import { emptyPlan, moveTo } from "@/domain/plan/board";
import { demoDaySource } from "@/modules/demo/day-source";
import { childTokenOf } from "@/modules/demo/fixtures/standard";
import { boardHref } from "@/modules/plan/when";
import { testDay, vanIdOfSlot, TEST_DATE } from "@/test/board-day";
import { flow, vanArrival } from "@/ui/copy";
import { arrivalVans, noPlanView, selectedVan } from "./view";

/**
 * WHAT THE RAMP DRAWS, AND WHAT IT REFUSES TO INVENT.
 *
 * Two rules, both of them S1 rulings and both of them changes to what this file used to do:
 *
 *  - the tabs are in **van order** — Van 1, Van 2, Van 3 — and not in the order the vans leave,
 *    which put them on screen as 1, 3, 2 (png/ramp-arrival.png draws three tabs in door order);
 *  - with no saved plan there is **no plan**: `arrivalVans` reports the empty vans it was given
 *    and never runs Auto-plan to have something to show (Firia's S1 ruling removing the
 *    `planSaved ? plan : autoPlan(day, plan)` fallback). The screen for that leg is
 *    {@link noPlanView}: one line and one button.
 */

const source = demoDaySource();

describe("the vans at the ramp", () => {
  it("is Van 1, Van 2, Van 3, whatever order they leave in", async () => {
    const day = await testDay("AM");
    const vans = arrivalVans(day, emptyPlan(day), source);

    expect(vans.map((arrival) => arrival.van.name)).toEqual(["Van 1", "Van 2", "Van 3"]);
    expect(vans.map((arrival) => arrival.van.slot)).toEqual([1, 2, 3]);

    // The point of the rule: leaving-time order is a different order, and is not this one.
    const byLeaving = [...vans].sort((a, b) => a.leavesMs - b.leavesMs);
    expect(byLeaving.map((arrival) => arrival.van.slot)).not.toEqual([1, 2, 3]);
  });

  it("lists the riders the given plan puts on each van, and nobody else", async () => {
    const day = await testDay("AM");
    const liam = childTokenOf("C3");
    const plan = moveTo(emptyPlan(day), liam, vanIdOfSlot(2));

    const vans = arrivalVans(day, plan, source);
    expect(vans[0].riders).toEqual([]);
    expect(vans[1].riders.map((rider) => rider.token)).toEqual([liam]);
    expect(vans[2].riders).toEqual([]);
  });

  it("never invents a plan: an empty plan is three empty vans", async () => {
    const day = await testDay("AM");
    const vans = arrivalVans(day, emptyPlan(day), source);
    expect(vans).toHaveLength(3);
    expect(vans.flatMap((arrival) => arrival.riders)).toEqual([]);
  });

  it("selects the van the address names, and the first one when it names none", async () => {
    const day = await testDay("AM");
    const vans = arrivalVans(day, emptyPlan(day), source);
    expect(selectedVan(vans, vanIdOfSlot(3))?.van.slot).toBe(3);
    expect(selectedVan(vans, undefined)?.van.slot).toBe(1);
    expect(selectedVan(vans, "not-a-van")?.van.slot).toBe(1);
    expect(selectedVan([], undefined)).toBeNull();
  });
});

describe("no plan saved for this leg", () => {
  it("is one line and one button to the board for that leg", () => {
    expect(noPlanView(TEST_DATE, "AM")).toEqual({
      line: "No plan saved",
      action: "Plan routes",
      href: `/plan-routes?date=${TEST_DATE}&leg=am`,
    });
  });

  it("says it in copy.ts's words, and keeps the leg it was asked about", () => {
    const pm = noPlanView(TEST_DATE, "PM");
    expect(pm.line).toBe(vanArrival.noPlanSaved);
    expect(pm.action).toBe(flow.action.planRoutes);
    expect(pm.href).toBe(boardHref("/plan-routes", { date: TEST_DATE, leg: "PM" }));
  });
});
