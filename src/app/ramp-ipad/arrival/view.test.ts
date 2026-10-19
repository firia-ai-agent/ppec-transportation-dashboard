import { describe, expect, it } from "vitest";
import { departuresOf } from "@/domain/plan/arrivals";
import { emptyPlan, moveTo } from "@/domain/plan/board";
import { usedBy } from "@/domain/plan/fit";
import { demoDaySource } from "@/modules/demo/day-source";
import { childTokenOf } from "@/modules/demo/fixtures/standard";
import { boardHref } from "@/modules/plan/when";
import { defaultsOfSlot, testDay, vanIdOfSlot, TEST_DATE } from "@/test/board-day";
import { flow, vanArrival } from "@/ui/copy";
import { arrivalVans, noPlanView, plannedUse, selectedVan, underPlanned } from "./view";

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
    const vans = arrivalVans(day, emptyPlan(day), departuresOf(day));

    expect(vans.map((arrival) => arrival.van.name)).toEqual(["Van 1", "Van 2", "Van 3"]);
    expect(vans.map((arrival) => arrival.van.slot)).toEqual([1, 2, 3]);

    // The point of the rule: Van 3 leaving first does not move its tab.
    const early = arrivalVans(day, emptyPlan(day), departuresOf(day, { [vanIdOfSlot(3)]: "05:00" }));
    expect(early.map((arrival) => arrival.van.slot)).toEqual([1, 2, 3]);
    expect(early[2].leaves).toBe("05:00");
  });

  it("lists the riders the given plan puts on each van, and nobody else", async () => {
    const day = await testDay("AM");
    const liam = childTokenOf("C3");
    const plan = moveTo(emptyPlan(day), liam, vanIdOfSlot(2));

    const vans = arrivalVans(day, plan, departuresOf(day));
    expect(vans[0].riders).toEqual([]);
    expect(vans[1].riders.map((rider) => rider.token)).toEqual([liam]);
    expect(vans[2].riders).toEqual([]);
  });

  it("never invents a plan: an empty plan is three empty vans", async () => {
    const day = await testDay("AM");
    const vans = arrivalVans(day, emptyPlan(day), departuresOf(day));
    expect(vans).toHaveLength(3);
    expect(vans.flatMap((arrival) => arrival.riders)).toEqual([]);
  });

  it("selects the van the address names, and the first one when it names none", async () => {
    const day = await testDay("AM");
    const vans = arrivalVans(day, emptyPlan(day), departuresOf(day));
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

describe("what the plan needs of a van, under each counter", () => {
  it("is fit.ts's own sums over the riders the plan put on it", async () => {
    const day = await testDay("AM");
    const liam = day.riders.find((rider) => rider.needs.carSeat)!;
    const plan = moveTo(emptyPlan(day), liam.token, vanIdOfSlot(1));
    const vans = arrivalVans(day, plan, departuresOf(day));

    const planned = plannedUse(vans[0].riders);
    expect(planned).toEqual(usedBy(vans[0].riders));
    expect(planned.carSeats).toBe(1);
    // Seats are the riders aboard who are not in their own chair, plus any nurse riding along.
    expect(planned.seats).toBe(liam.needs.wheelchair ? 0 : 1);

    // A van the plan put nobody on needs nothing, so nothing under it is amber.
    expect(plannedUse(vans[1].riders)).toEqual(usedBy([]));
  });

  it("is amber only when the count in front of the front desk is BELOW it", async () => {
    const day = await testDay("AM");
    const withCarSeat = day.riders.filter((rider) => rider.needs.carSeat).slice(0, 2);
    expect(withCarSeat).toHaveLength(2);
    let plan = emptyPlan(day);
    for (const rider of withCarSeat) plan = moveTo(plan, rider.token, vanIdOfSlot(1));
    const planned = plannedUse(arrivalVans(day, plan, departuresOf(day))[0].riders);
    expect(planned.carSeats).toBe(2);

    const defaults = defaultsOfSlot(1);
    expect(underPlanned(defaults, planned, "carSeats")).toBe(false);
    expect(underPlanned({ ...defaults, carSeats: 2 }, planned, "carSeats")).toBe(false);
    expect(underPlanned({ ...defaults, carSeats: 1 }, planned, "carSeats")).toBe(true);
    // Lowering a different counter says nothing about this one.
    expect(underPlanned({ ...defaults, seats: 0 }, planned, "carSeats")).toBe(false);
  });
});
