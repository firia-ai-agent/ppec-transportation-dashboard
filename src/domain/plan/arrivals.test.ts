import { describe, expect, it } from "vitest";
import { DWELL_SECONDS } from "@/domain/location/route";
import { autoPlan, boardMap, emptyPlan, ridersInVan } from "./board";
import { serviceSchedule } from "@/config/schedule";
import { trafficBandAtMinute } from "@/domain/eta/traffic";
import { departuresOf, hhmmOf, minuteOfDay, plannedDropoffs, plannedStopTimes } from "./arrivals";
import { centreLeadSec } from "./map";
import { testDay } from "@/test/board-day";

/**
 * Every child's time is the §8 formula run forward from their van's departure (ledger #76). These
 * cases hold its shape — the departure, the order, the dwell, the two legs — rather than a minute
 * any scenario happens to produce, so a change to the fixtures moves the numbers and not the rules.
 */
describe("plannedStopTimes", () => {
  it("starts every van at its departure: the first stop is the drive out from the centre after it", async () => {
    for (const leg of ["AM", "PM"] as const) {
      const day = await testDay(leg);
      const plan = autoPlan(day, emptyPlan(day));
      const departs = departuresOf(day);
      const times = plannedStopTimes(day, plan, departs);
      for (const van of day.vans) {
        const riders = ridersInVan(day, plan, van.id);
        if (riders.length === 0) continue;
        const first = times.get(riders[0].token)!.arrivesAtMinute;
        const lead = centreLeadSec(riders[0].stopLabel)! / 60;
        expect(first, `${leg} ${van.name}`).toBeCloseTo(departs[van.id] + lead * trafficBandAtMinute(departs[van.id]).multiplier, 6);
        const all = riders.map((rider) => times.get(rider.token)!.arrivesAtMinute);
        for (let i = 1; i < all.length; i += 1) expect(all[i]).toBeGreaterThanOrEqual(all[i - 1]);
      }
    }
  });

  it("moves every child on a van with its departure", async () => {
    const day = await testDay("PM");
    const plan = autoPlan(day, emptyPlan(day));
    const base = departuresOf(day);
    const van = day.vans.find((v) => ridersInVan(day, plan, v.id).length > 0)!;
    // Ten minutes later, inside the same traffic band, so the drive itself does not change.
    const later = { ...base, [van.id]: base[van.id] + 10 };
    expect(trafficBandAtMinute(later[van.id]).multiplier).toBe(trafficBandAtMinute(base[van.id]).multiplier);
    const before = plannedStopTimes(day, plan, base);
    const after = plannedStopTimes(day, plan, later);
    for (const rider of ridersInVan(day, plan, van.id)) {
      expect(after.get(rider.token)!.arrivesAtMinute - before.get(rider.token)!.arrivesAtMinute).toBeCloseTo(10, 6);
    }
  });

  it("uses a planner's time for today over the schedule's default", async () => {
    const day = await testDay("AM");
    const [van] = day.vans;
    expect(departuresOf(day)[van.id]).toBe(minuteOfDay(serviceSchedule.departs.AM));
    expect(departuresOf(day, { [van.id]: "07:05" })[van.id]).toBe(425);
  });

  it("puts at least the drive and the §8 dwell between two kerbs of one van", async () => {
    const day = await testDay("PM");
    const plan = autoPlan(day, emptyPlan(day));
    const times = plannedStopTimes(day, plan, departuresOf(day));
    const route = boardMap(day, plan).routes.find((r) => r.stops.length >= 2)!;
    const riders = ridersInVan(day, plan, route.laneId);
    const at = (label: string) => times.get(riders.find((r) => r.stopLabel === label)!.token)!.arrivesAtMinute;
    const gap = at(route.stops[1].label) - at(route.stops[0].label);
    expect(gap).toBeGreaterThanOrEqual(route.segments[1].durationSec / 60 + DWELL_SECONDS / 60 - 1e-9);
  });

  it("answers for every rider in a van, on both legs, and for nobody who is not in one", async () => {
    for (const leg of ["AM", "PM"] as const) {
      const day = await testDay(leg);
      const times = plannedStopTimes(day, autoPlan(day, emptyPlan(day)), departuresOf(day));
      for (const rider of day.riders) expect(times.has(rider.token), `${leg} ${rider.name}`).toBe(true);
      expect(plannedStopTimes(day, emptyPlan(day), departuresOf(day)).size).toBe(0);
    }
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

  it("tells drop-offs only on an afternoon: a morning's times are pickups", async () => {
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
