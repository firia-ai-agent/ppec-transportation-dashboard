import { describe, expect, it } from "vitest";
import { departuresOf, hhmmOf, plannedStopTimes } from "./arrivals";
import { ridersInVan, type BoardDay, type BoardPlan } from "./board";
import { brokenSlot, minutesOutside, outsideSlots, totalOutside } from "./slots";
import { scenarioPlan, testDay } from "@/test/board-day";
import { previewPlanChange } from "@/modules/changes/plan-change";
import { routesFor } from "@/modules/changes/agreed";
import type { BoardView } from "@/modules/plan/store";
import { clockLabel } from "@/ui/service-date";

/** A day where one rider with company in their van has an approved slot around their current time. */
async function dayWithSlot(width = 30) {
  const base = await testDay("PM");
  const plan = scenarioPlan(base);
  const departs = departuresOf(base);
  const van = base.vans.find((v) => ridersInVan(base, plan, v.id).length >= 2)!;
  const [child] = ridersInVan(base, plan, van.id);
  const at = Math.round(plannedStopTimes(base, plan, departs).get(child.token)!.arrivesAtMinute);
  const slot = { start: hhmmOf(at - 5), end: hhmmOf(at - 5 + width) };
  const day: BoardDay = { ...base, riders: base.riders.map((r) => (r.token === child.token ? { ...r, slots: [slot] } : r)) };
  return { day, plan, departs, van, child, at, slot };
}

describe("minutes outside an approved slot (ledger #84)", () => {
  it("is 0 inside, the distance to the nearest edge outside, and null with no slot", () => {
    const slots = [{ start: "16:50", end: "17:20" }];
    expect(minutesOutside(17 * 60, slots)).toBe(0);
    expect(minutesOutside(17 * 60 + 40, slots)).toBe(20);
    expect(minutesOutside(16 * 60 + 40, slots)).toBe(10);
    expect(minutesOutside(17 * 60 + 40, [...slots, { start: "17:30", end: "18:00" }])).toBe(0);
    expect(minutesOutside(17 * 60, undefined)).toBeNull();
    expect(minutesOutside(17 * 60, [])).toBeNull();
  });

  it("reads every child with a slot against the plan's own times", async () => {
    const { day, plan, departs, child } = await dayWithSlot();
    expect(outsideSlots(day, plan, departs)).toEqual(new Map([[child.token, 0]]));
    expect(totalOutside(outsideSlots(day, plan, departs))).toBe(0);
  });
});

describe("the change that breaks an agreed time (ledger #84)", () => {
  it("is a later departure that puts the child past the end of their slot", async () => {
    const { day, plan, departs, van, child } = await dayWithSlot();
    const later = { ...departs, [van.id]: departs[van.id] + 60 };
    expect(brokenSlot(day, { plan, departs }, { plan, departs: later })).toMatchObject({ childToken: child.token, vanId: van.id });
  });

  it("is nothing when the child stays inside", async () => {
    const { day, plan, departs, van } = await dayWithSlot();
    const nudged = { ...departs, [van.id]: departs[van.id] + 2 };
    expect(brokenSlot(day, { plan, departs }, { plan, departs: nudged })).toBeNull();
  });

  it("does not hold a save hostage to a child already outside and no worse for it", async () => {
    const { day, plan, departs, van } = await dayWithSlot();
    const late = { ...departs, [van.id]: departs[van.id] + 60 };
    expect(brokenSlot(day, { plan, departs: late }, { plan, departs: late })).toBeNull();
  });
});

describe("the preview and the route ranking read the same rule (ledger #84)", () => {
  const view = (day: BoardDay, plan: BoardPlan, departs: Record<string, number>) =>
    ({ day, plan, departs, version: 1 }) as unknown as BoardView;

  it("says so on the card when a departure would put a child outside their family's time", async () => {
    const { day, plan, departs, van, child, slot } = await dayWithSlot();
    const preview = previewPlanChange(view(day, plan, departs), { departures: { [van.id]: hhmmOf(departs[van.id] + 60) } });
    if (!preview.ok) throw new Error(preview.reason);
    expect(preview.outsideMinutes).toBeGreaterThan(0);
    expect(preview.lines.some((line) => line.startsWith(`${child.name} ≈`) && line.includes("outside the family's"))).toBe(true);
    expect(preview.lines.join(" ")).toContain(clockLabel(slot.end));
  });

  it("never offers a van that has already left", async () => {
    const { day, plan, departs, van, child } = await dayWithSlot();
    const other = day.vans.find((v) => v.id !== van.id && ridersInVan(day, plan, v.id).length > 0)!;
    const someoneAboard = ridersInVan(day, plan, other.id)[0];
    const leftDay: BoardDay = { ...day, riders: day.riders.map((r) => (r.token === someoneAboard.token ? { ...r, aboard: true } : r)) };
    const routes = routesFor(view(leftDay, plan, departs), child.token, hhmmOf(Math.round(plannedStopTimes(day, plan, departs).get(child.token)!.arrivesAtMinute) + 20));
    expect(routes.every((r) => r.preview.next[child.token]?.vanId !== other.id)).toBe(true);
  });
});
