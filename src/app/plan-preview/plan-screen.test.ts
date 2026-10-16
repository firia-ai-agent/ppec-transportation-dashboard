import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { pageOutcome } from "@/auth/access";
import { notCheckedYet, planLanes, planRiders, reportedByProvider, vehicleByKey, asMeasured } from "@/domain/plan/day";
import { planAssignment, planRoutes, routePlan, type PlanInput, type RoutePlan } from "@/domain/solver";
import { places, planRoutes as copy, securement } from "@/ui/copy";
import { capabilityStates, reservationStates } from "@/ui/states";
import {
  equipmentChips,
  laneLines,
  laneState,
  needChips,
  needsADecision,
  reasonLine,
  refusalLine,
  setUpAsLine,
  stopLine,
  summaryLine,
  unplacedState,
} from "./lanes";

/**
 * The Plan routes screen's contracts.
 *
 * Two kinds of assertion. The words and the state chips are pure functions over a real plan of
 * the demo scenario, so they are checked here against the solver's own verdicts. The screen
 * itself is a client component with its own state and vitest runs in node with no DOM, so what
 * is asserted about it is that its rules are written: the guard is on the route, there is one
 * primary action, and nothing is drag-only. That the browser then lays it out is
 * e2e/plan-routes.spec.ts's job — it measures the real screen and takes the pictures.
 */
const HERE = __dirname;

function read(file: string): string {
  return readFileSync(path.join(HERE, file), "utf8");
}

function inputFor(lanes = planLanes(), riders = planRiders("AM")): PlanInput {
  return { direction: "AM", centerLabel: places.center, lanes, riders };
}

function laneIn(plan: RoutePlan, laneId: string) {
  const lane = plan.lanes.find((l) => l.lane.id === laneId);
  if (!lane) throw new Error(`no lane ${laneId}`);
  return lane;
}

describe("the route is behind the same door as the rest of the console", () => {
  const page = read("page.tsx");
  const screen = read("PlanRoutes.tsx");

  it("guards on the server, through the shared guard and the one access table", () => {
    expect(page).not.toMatch(/^"use client"/m);
    expect(page).toMatch(/requirePage\("\/plan-preview"\)/);
    expect(page).toMatch(/from "@\/auth\/page-guard"/);
    // A session read means the route can never be answered from a static render.
    expect(page).toMatch(/export const dynamic = "force-dynamic"/);
  });

  it("leaves the screen itself a plain client component with no guard of its own", () => {
    expect(screen).toMatch(/^"use client"/);
    expect(screen).not.toMatch(/redirect|requirePage|getCaller|auth\(\)/);
  });

  it("is the two console roles', and not the front desk's", () => {
    expect(pageOutcome({ kind: "ANONYMOUS" }, "/plan-preview")).toBe("SIGN_IN");
    expect(pageOutcome({ kind: "STAFF", role: "DIRECTOR" }, "/plan-preview")).toBe("ALLOW");
    expect(pageOutcome({ kind: "STAFF", role: "COORDINATOR" }, "/plan-preview")).toBe("ALLOW");
    // The ramp iPad is the front desk's surface; deciding which van a child rides in is not.
    expect(pageOutcome({ kind: "STAFF", role: "FRONT_DESK" }, "/plan-preview")).toBe("NO_ACCESS");
  });

  it("is reachable from the map preview, so it is not URL-only", () => {
    const mapPage = readFileSync(path.resolve(HERE, "..", "map-preview", "page.tsx"), "utf8");
    expect(mapPage).toMatch(/href="\/plan-preview"/);
    // ...and offered only to a role whose own row opens it, which is the table's answer again.
    expect(mapPage).toMatch(/canOpenPage\(caller, "\/plan-preview"\)/);
  });

  it("reads no database, calls no endpoint and loads no map tiles", () => {
    const screenAndHelpers = screen + read("lanes.ts");
    expect(screenAndHelpers).not.toMatch(/fetch\(|EventSource|maplibre|@\/db\//);
  });
});

describe("the screen's own rules", () => {
  const screen = read("PlanRoutes.tsx");
  const css = read("plan.module.css");

  it("has one primary action, and it is Plan routes", () => {
    expect(screen.match(/styles\.primary/g)).toHaveLength(1);
    expect(screen).toMatch(/className=\{styles\.primary\}[\s\S]{0,80}planRoutes\.planAgain : planRoutes\.plan/);
  });

  it("never makes a drag the only way to move a child (§9)", () => {
    // Every rider row is draggable *and* carries a Move menu that names the lanes in words.
    expect(screen).toMatch(/draggable/);
    expect(screen).toMatch(/const moveMenu = /);
    expect(screen).toMatch(/planRoutes\.moveTo/);
  });

  it("says what happened in a line that keeps its height, so a refusal pushes nothing down", () => {
    expect(screen).toMatch(/aria-live="polite"/);
    expect(css).toMatch(/\.notice \{[^}]*min-height: var\(--target-console\)/);
  });

  it("marks a chosen answer with a fill and a check, never colour alone (§3)", () => {
    expect(screen).toMatch(/aria-pressed=\{pressed\}/);
    expect(screen).toMatch(/\{pressed \? <Check size=\{icon\.inline\}/);
    expect(css).toMatch(/\.button\[aria-pressed="true"\] \{[^}]*background: var\(--color-brand\)/);
  });

  it("holds no colour of its own and no demo violet (D-5)", () => {
    // Every colour is a token custom property; the violet belongs to the DEMO bar and the
    // Simulated chip, and the browser check measures that on the real screen too.
    expect(css).not.toMatch(/#[0-9a-fA-F]{3}|rgb|demo-bg|src-sim/);
  });

  it("keeps the DEMO bar's 32 px out of its own height", () => {
    expect(css).toMatch(/min-height: calc\(100vh - var\(--layout-demo-banner-height\)\)/);
  });
});

describe("the words a lane says", () => {
  it("says every rider fits when the solver does", () => {
    const plan = planRoutes(inputFor());
    for (const lane of plan.lanes) {
      expect(laneState(lane)).toBe(reservationStates.FEASIBLE);
      expect(laneLines(lane)).toEqual([copy.laneFits]);
    }
  });

  it("says what the day knows about a van with nobody in it, rather than calling it a fit", () => {
    const empty = routePlan(inputFor(), {});
    for (const lane of empty.lanes) {
      expect(laneState(lane)).toBe(capabilityStates.REPORTED);
      expect(laneLines(lane)).toEqual([copy.laneEmpty]);
    }
  });

  it("says nobody boards on a van nobody has checked, and why it is unknown", () => {
    const lanes = planLanes().map((lane) =>
      lane.id === "V1" ? { ...lane, capability: notCheckedYet(lane.vehicle.id) } : lane,
    );
    const input = inputFor(lanes);
    // Put somebody in the unchecked lane by hand: the planner would not, which is the point.
    const plan = routePlan(input, { V1: ["C3"], V2: [], V4: [] });
    const lane = laneIn(plan, "V1");
    expect(laneState(lane)).toBe(capabilityStates.UNKNOWN);
    expect(laneLines(lane)).toContain(copy.laneNeedsCheck);
    expect(laneLines(lane)[0]).toMatch(/unknown until arrival/);
  });

  it("names the stop and the missing thing when a run does not fit, and blocks boarding", () => {
    // The substitute van's position is L-track; the chair planned into that lane is held by
    // four-point straps.
    const spare = vehicleByKey("V3");
    const lanes = planLanes().map((lane) =>
      lane.id === "V1" ? { ...lane, vehicle: spare, capability: reportedByProvider(spare.id) } : lane,
    );
    const plan = routePlan(inputFor(lanes), planAssignment(inputFor()));
    const lane = laneIn(plan, "V1");
    expect(laneState(lane)).toBe(reservationStates.INFEASIBLE);
    const [missing, blocked] = laneLines(lane);
    expect(missing).toContain(securement.FOUR_POINT_STRAP);
    expect(missing).toMatch(/^Doesn’t fit at /);
    expect(blocked).toBe(copy.laneBlocked);
  });

  it("says a van's equipment as the day has it, and its configuration in words", () => {
    const plan = planRoutes(inputFor());
    const lane = laneIn(plan, "V1");
    const chips = equipmentChips(lane.lane.vehicle, lane.layout, lane.lane.capability, {
      wc: lane.seats.wcAvailable,
      amb: lane.seats.ambAvailable,
      tether: lane.seats.tetherAvailable,
    });
    expect(chips[0]).toBe(copy.equipment.lift);
    expect(chips.some((c) => c.includes(securement.FOUR_POINT_STRAP))).toBe(true);
    expect(chips).toContain("3 seats");
    expect(chips).toContain("2 anchored seats");
    // Never the provider's shorthand on a screen.
    expect(setUpAsLine(lane.layout)).toBe("Set up as 1 wheelchair · 3 seats");
    expect(setUpAsLine(lane.layout)).not.toMatch(/\d+WC\/\d+A/);
  });

  it("writes a stop as the place and the time, in words a person says out loud", () => {
    const rider = planRiders("AM").find((r) => r.child.token === "C2");
    expect(stopLine(rider!)).toBe("Okeeheelee Park · 6:50 AM");
  });
});

describe("the words beside a child with no van", () => {
  it("names the child and the missing hardware, as one sentence with one full stop", () => {
    const spare = vehicleByKey("V3");
    const lanes = planLanes().map((lane) =>
      lane.id === "V1" ? { ...lane, vehicle: spare, capability: reportedByProvider(spare.id) } : lane,
    );
    const plan = planRoutes(inputFor(lanes));
    const zoe = plan.unplaced.find((u) => u.rider.child.token === "C6");
    expect(zoe).toBeDefined();
    expect(reasonLine(zoe!, "")).toBe("No van with four-point straps for Zoe B.");
    expect(unplacedState(zoe!.cause)).toBe(reservationStates.INFEASIBLE);
    expect(needsADecision(plan.lanes, plan.unplaced)).toBe(true);
  });

  it("says a chair measured at the ramp is too large for any van, naming the child", () => {
    const measured = inputFor(
      planLanes(),
      planRiders("AM").map((rider) => (rider.child.token === "C6" ? asMeasured(rider) : rider)),
    );
    const plan = planRoutes(measured);
    const zoe = plan.unplaced.find((u) => u.rider.child.token === "C6");
    expect(reasonLine(zoe!, "")).toBe(
      "No van with a wheelchair place large enough for Zoe B.’s chair.",
    );
    // The chip says where the measurement came from, so the two numbers are never confused.
    expect(needChips(zoe!.rider.child, true)).toContain("Chair measured at the ramp · 142 × 74 cm");
    expect(needChips(planRiders("AM")[5].child, false)).toContain("Chair on file · 128 × 70 cm");
  });

  it("says nobody has put a child in a van yet, with nothing to approve", () => {
    const plan = routePlan(inputFor(), {});
    const row = plan.unplaced[0];
    expect(reasonLine(row, "")).toBe("Mia R. is not in a van yet. Press Plan routes, or move them into one.");
    expect(row.options).toEqual([]);
    // Nothing to decide: a plan that has not been run is not an exception.
    expect(needsADecision(plan.lanes, plan.unplaced)).toBe(false);
  });

  it("refuses a move in one line that names the child and what is missing", () => {
    const plan = planRoutes(inputFor());
    const centreVan = laneIn(plan, "V2").lane.vehicle;
    const zoe = planRiders("AM").find((r) => r.child.token === "C6");
    expect(refusalLine(centreVan, zoe!.child, "NO_SECUREMENT")).toBe(
      "V2 can’t take Zoe B.: no four-point straps.",
    );
    expect(refusalLine(centreVan, zoe!.child, "NO_SEAT")).toBe("V2 can’t take Zoe B.: no free seat.");
  });

  it("counts the plan in riders, not in rows", () => {
    expect(summaryLine(7, 9)).toBe("7 of 9 riders are in a van.");
  });
});
