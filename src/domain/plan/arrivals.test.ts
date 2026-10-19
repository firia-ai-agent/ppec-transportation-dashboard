import { describe, expect, it } from "vitest";
import { DWELL_SECONDS } from "@/domain/location/route";
import { autoPlan, boardMap, emptyPlan, ridersInVan } from "./board";
import { hhmmOf, minuteOfDay, plannedDropoffs } from "./arrivals";
import { testDay } from "@/test/board-day";

/**
 * The planned drop-off is the §8 formula over the board's own plan. These cases hold its shape —
 * the anchor, the order, the dwell — rather than a minute any scenario happens to produce, so a
 * change to the fixtures moves the numbers and not the rules.
 */
describe("plannedDropoffs", () => {
  it("serves each van's first stop at that family's window, and every later stop after it", async () => {
    const day = await testDay("PM");
    const plan = autoPlan(day, emptyPlan(day));
    const arrivals = plannedDropoffs(day, plan);
    expect(arrivals.size).toBeGreaterThan(0);
    for (const van of day.vans) {
      const riders = ridersInVan(day, plan, van.id);
      if (riders.length === 0) continue;
      const times = riders.map((rider) => arrivals.get(rider.token)!.arrivesAtMinute);
      expect(times[0]).toBeCloseTo(minuteOfDay(riders[0].window)!, 6);
      for (let i = 1; i < times.length; i += 1) expect(times[i]).toBeGreaterThanOrEqual(times[i - 1]);
    }
  });

  it("puts at least the drive and the §8 dwell between two kerbs of one van", async () => {
    const day = await testDay("PM");
    const plan = autoPlan(day, emptyPlan(day));
    const arrivals = plannedDropoffs(day, plan);
    const route = boardMap(day, plan).routes.find((r) => r.stops.length >= 2)!;
    const riders = ridersInVan(day, plan, route.laneId);
    const at = (label: string) => arrivals.get(riders.find((r) => r.stopLabel === label)!.token)!.arrivesAtMinute;
    const gap = at(route.stops[1].label) - at(route.stops[0].label);
    expect(gap).toBeGreaterThanOrEqual(route.segments[1].durationSec / 60 + DWELL_SECONDS / 60 - 1e-9);
  });

  it("answers for every afternoon rider in a van, and for nobody who is not in one", async () => {
    const day = await testDay("PM");
    const arrivals = plannedDropoffs(day, autoPlan(day, emptyPlan(day)));
    for (const rider of day.riders) expect(arrivals.has(rider.token), rider.name).toBe(true);
    expect(plannedDropoffs(day, emptyPlan(day)).size).toBe(0);
  });

  it("makes a child later when a van arrives short and the plan is made again around it", async () => {
    // The founder's scenario: Van 1 arrives without the equipment a child needs. Whoever moves
    // pays for it in minutes — which child, and how many, is the plan's answer, not this test's.
    const normal = await testDay("PM");
    const short = await testDay("PM", { 1: { wheelchairSpots: 0, hasLift: false } });
    const before = plannedDropoffs(normal, autoPlan(normal, emptyPlan(normal)));
    const after = plannedDropoffs(short, autoPlan(short, emptyPlan(short)));
    const later = [...after].filter(([token, a]) => a.arrivesAtMinute - before.get(token)!.arrivesAtMinute >= 10);
    expect(later.length).toBeGreaterThan(0);
  });

  it("estimates nothing for a morning, which ends at the centre", async () => {
    const day = await testDay("AM");
    expect(plannedDropoffs(day, autoPlan(day, emptyPlan(day))).size).toBe(0);
  });
});

describe("minuteOfDay / hhmmOf", () => {
  it("round-trips a wall clock, and refuses what is not one", () => {
    expect(minuteOfDay("16:20")).toBe(980);
    expect(hhmmOf(980)).toBe("16:20");
    expect(hhmmOf(1007.4)).toBe("16:47");
    for (const bad of ["25:00", "4pm", "16:60", ""]) expect(minuteOfDay(bad), bad).toBeNull();
  });
});
