import { describe, expect, it } from "vitest";
import { availabilityConfig, notifyGateConfig } from "@/config/live";
import { departuresOf, hhmmOf, minuteOfDay, plannedStopTimes } from "@/domain/plan/arrivals";
import { ridersInVan, type BoardPlan } from "@/domain/plan/board";
import type { BoardView } from "@/modules/plan/store";
import { scenarioPlan, testDay } from "@/test/board-day";
import { bestRouteFor, routesFor } from "./agreed";

/**
 * A TIME AGREED WITH A FAMILY IS A TIME THE VAN KEEPS (ledger #79): the route that honours it, and
 * the one rule a van on the road imposes — nobody moves out of it or into it.
 */
async function board(): Promise<BoardView> {
  const day = await testDay("PM");
  return { day, plan: scenarioPlan(day), departs: departuresOf(day), version: 1 } as unknown as BoardView;
}
const eta = (view: BoardView, plan: BoardPlan, token: string) => plannedStopTimes(view.day, plan, view.departs).get(token)!.arrivesAtMinute;

/** A rider with somebody after them in the same van, so a wait has someone to delay. */
async function riderWithCompany() {
  const view = await board();
  const van = view.day.vans.find((v) => ridersInVan(view.day, view.plan, v.id).length >= 2)!;
  const [first] = ridersInVan(view.day, view.plan, van.id);
  return { view, van, child: first };
}

describe("the engine keeps an agreed time", () => {
  it("drives their stop in the agreed order, drops them no earlier, and every stop after waits too", async () => {
    const { view, van, child } = await riderWithCompany();
    const agreed = Math.round(eta(view, view.plan, child.token)) + 40;
    const held: BoardPlan = { ...view.plan, [child.token]: { ...view.plan[child.token], notBefore: hhmmOf(agreed) } };
    expect(eta(view, held, child.token)).toBeGreaterThanOrEqual(agreed);
    const order = ridersInVan(view.day, held, van.id).map((r) => r.token);
    for (const after of order.slice(order.indexOf(child.token) + 1)) {
      expect(eta(view, held, after)).toBeGreaterThanOrEqual(agreed);
    }
  });
});

describe("the route for an agreed time (ledger #79)", () => {
  it("chooses a route that keeps the promise, and says so on the card", async () => {
    const { view, child } = await riderWithCompany();
    const agreed = hhmmOf(Math.round(eta(view, view.plan, child.token)) + 34);
    const route = bestRouteFor(view, child.token, agreed)!;
    expect(route).not.toBeNull();
    expect(eta(view, route.preview.next, child.token)).toBeGreaterThanOrEqual(Math.round(eta(view, view.plan, child.token)) + 34);
    expect(route.preview.lines.join(" ")).toContain(child.name);
    expect(route.preview.moves.find((m) => m.child_token === child.token)?.not_before).toBe(agreed);
  });

  it("never offers another van to a child already aboard theirs", async () => {
    const { view, van, child } = await riderWithCompany();
    // Aboard is the leg's own state (machines.ABOARD), read onto the rider by the day source.
    const onBoard = { ...view, day: { ...view.day, riders: view.day.riders.map((r) => (r.token === child.token ? { ...r, aboard: true } : r)) } } as BoardView;
    const agreed = hhmmOf(Math.round(eta(onBoard, onBoard.plan, child.token)) + 34);
    for (const route of routesFor(onBoard, child.token, agreed)) {
      expect(route.preview.next[child.token].vanId).toBe(van.id);
    }
  });
});

/**
 * NEVER LATE, EARLY IS FINE, FEWEST MINUTES ADDED (ledger #90). Prod: Theo's family asked for 4:00
 * and the card parked a van at his stop with Liam and Zoe aboard (+17, +18). A route is offered only
 * if nobody else gets home late; of those, the fewest minutes added wins.
 */
describe("a later time never makes another family late (ledger #90)", () => {
  const LATE = notifyGateConfig.shiftSeconds / 60;
  const theo = (view: BoardView) => view.day.riders.find((r) => r.name.startsWith("Theo"))!;

  it("Theo at 4:00: stays in his van, dropped last, nobody later, nothing added", async () => {
    const view = await board();
    const child = theo(view);
    const vanId = view.plan[child.token].vanId!;
    const route = bestRouteFor(view, child.token, "16:00")!;
    expect(route).not.toBeNull();
    expect(route.preview.next[child.token].vanId).toBe(vanId);
    expect(ridersInVan(view.day, route.preview.next, vanId).at(-1)?.token).toBe(child.token);
    expect(route.preview.madeLate).toBe(0);
    expect(route.preview.addedMinutes).toBe(0);
    expect(eta(view, route.preview.next, child.token)).toBeGreaterThanOrEqual(16 * 60);
    // Before: a 33-minute wait at Theo's stop with Liam and Noah still aboard.
    for (const other of ridersInVan(view.day, view.plan, vanId).filter((r) => r.token !== child.token)) {
      expect(eta(view, route.preview.next, other.token)).toBeLessThanOrEqual(eta(view, view.plan, other.token) + 0.01);
    }
  });

  it("whoever asks, for whatever later time: every route offered keeps every other child on time and the asker in their range", async () => {
    const view = await board();
    for (const child of view.day.riders.filter((r) => view.plan[r.token]?.bucket === "VAN")) {
      for (const later of [10, 25, 40, 60]) {
        const asked = Math.round(eta(view, view.plan, child.token)) + later;
        const routes = routesFor(view, child.token, hhmmOf(asked));
        routes.forEach((route, i) => {
          const at = eta(view, route.preview.next, child.token);
          expect(at, `${child.name} +${later}`).toBeGreaterThanOrEqual(asked - 0.01);
          expect(at, `${child.name} +${later}`).toBeLessThanOrEqual(asked + availabilityConfig.slotMinutes);
          for (const other of view.day.riders.filter((r) => r.token !== child.token && route.preview.next[r.token]?.bucket === "VAN")) {
            const now = eta(view, route.preview.next, other.token);
            const was = eta(view, view.plan, other.token);
            const pastWindow = now - minuteOfDay(other.window)!;
            // Late is past the window by the threshold *and* later than it was: early is fine.
            expect(pastWindow >= LATE && now - was >= LATE, `${other.name} made late by ${child.name} +${later}`).toBe(false);
          }
          if (i > 0) expect(route.preview.addedMinutes).toBeGreaterThanOrEqual(routes[i - 1].preview.addedMinutes - 0.05);
        });
      }
    }
  });

  it("a van that has left is never joined and never reordered", async () => {
    const view = await board();
    const child = theo(view);
    const other = view.day.vans.find((v) => v.id !== view.plan[child.token].vanId && ridersInVan(view.day, view.plan, v.id).length > 0)!;
    const someone = ridersInVan(view.day, view.plan, other.id)[0];
    const left = { ...view, day: { ...view.day, riders: view.day.riders.map((r) => (r.token === someone.token ? { ...r, aboard: true } : r)) } } as BoardView;
    const order = ridersInVan(left.day, left.plan, other.id).map((r) => r.token);
    const routes = routesFor(left, child.token, "16:00");
    expect(routes.length).toBeGreaterThan(0);
    for (const route of routes) {
      expect(route.preview.next[child.token].vanId).not.toBe(other.id);
      expect(ridersInVan(left.day, route.preview.next, other.id).map((r) => r.token)).toEqual(order);
    }
  });

  it("offers nothing when no van can get there in the asked range — a person decides", async () => {
    const view = await board();
    // Before any van has even left the centre: no route lands inside 2:00–2:30.
    expect(routesFor(view, theo(view).token, "14:00")).toEqual([]);
  });
});
