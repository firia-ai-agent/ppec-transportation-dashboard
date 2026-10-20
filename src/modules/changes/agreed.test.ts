import { describe, expect, it } from "vitest";
import { departuresOf, hhmmOf, plannedStopTimes } from "@/domain/plan/arrivals";
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
