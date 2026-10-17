import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { pageOutcome } from "@/auth/access";
import {
  DEMO_SCENARIOS,
  PLAN_SERVICE_DATE,
  asMeasured,
  checkedAtRamp,
  notCheckedYet,
  planLanes,
  planRiders,
  reportedByProvider,
  spareVehicleKeys,
  vehicleByKey,
} from "@/domain/plan/day";
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
  seatLines,
  setUpAsLine,
  setUpChangeLine,
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

  /**
   * The drag is pointer events and not the browser's own drag-and-drop, which is the whole
   * reason a real mouse now moves a child: a platform drag session never starts for a touch, a
   * synthetic gesture or a headless browser, so the old `dragstart` / `drop` pair worked in
   * none of the ways the screen was actually tried. e2e/plan-routes.spec.ts drives the real
   * thing with `page.mouse`; this is the assertion that the mechanism cannot quietly go back.
   */
  it("moves a child with pointer events, so a real mouse and a finger both work", () => {
    for (const handler of ["onPointerDown", "onPointerMove", "onPointerUp", "onPointerCancel"]) {
      expect(screen, handler).toContain(handler);
    }
    expect(screen).toMatch(/setPointerCapture/);
    expect(screen).not.toMatch(/onDragStart|onDragOver|onDrop\b|dataTransfer/);
    // A finger's first millimetres belong to the row, not to the scroller.
    expect(css).toMatch(/\.draggable \{[^}]*touch-action: none/);
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
    // Every colour is a token custom property; the violet belongs to the DEMO bar, the
    // Simulated chip and the shared demo control, and the browser check measures that on the
    // real screen too. This screen's own stylesheet never names it, including through the
    // scenario toggle — that control brings its own (src/ui/DemoControls.module.css).
    expect(css).not.toMatch(/#[0-9a-fA-F]{3}|rgb|demo-bg|demo-fg|src-sim/);
  });

  /**
   * Vera's review, 2026-10-17: the scenario toggle is a demo control and has to look like one.
   *
   * It used to be two of the screen's own outlined buttons in the header, beside the run
   * switcher and above "Plan routes" — so a switch that exists only to steer the demo sat among
   * the day's real decisions. It now renders in the DEMO bar's own styling, which is shared
   * chrome in src/ui rather than something this screen paints: a screen cannot grant itself the
   * violet (src/ui/tokens.test.ts holds the reservation).
   */
  it("renders the scenario toggle as a demo control in the DEMO bar's styling", () => {
    expect(screen).toMatch(/import \{ DemoControls \} from "@\/ui\/DemoControls"/);
    expect(screen).toMatch(/<DemoControls[\s\S]{0,300}legend=\{planRoutes\.demoScenarioLegend\}/);
    expect(screen).toMatch(/options=\{DEMO_SCENARIOS\.map\(/);
    expect(screen).toMatch(/note=\{planRoutes\.demoScenarioNote\[scenario\]\}/);
    // Not the screen's own button, and not the screen's own date-shaped words any more.
    expect(screen).not.toMatch(/demoDay/);
    expect(screen).not.toMatch(/styles\.actionRow[\s\S]{0,120}demoScenario/);
  });

  /**
   * The other half of the same review: the screen replays one demo day. The toggle picks which
   * run of that day is on screen, so the date beside the heading is a constant computed once —
   * nothing maps a scenario to a date, and no scenario can be read as tomorrow.
   */
  it("replays one demo day under both scenarios", () => {
    const dates = DEMO_SCENARIOS.flatMap((scenario) =>
      planLanes(scenario).map((lane) => lane.capability.serviceDate),
    );
    expect([...new Set(dates)]).toEqual([PLAN_SERVICE_DATE]);
    expect(screen.match(/serviceDateLabel\(/g)).toHaveLength(1);
    expect(screen).toMatch(/const SERVICE_DATE_LABEL = serviceDateLabel\(/);
    expect(screen).toMatch(/date: SERVICE_DATE_LABEL/);
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

  /**
   * Vera's review, 2026-10-17: a lane says how full it is as "3 of 6 seats used", used first.
   * The line it replaced ("Seats: 3 needed, 6 free") asked the reader to subtract to find out
   * whether anybody else could get on.
   */
  it("counts places as used of available, with the noun on the count", () => {
    expect(
      seatLines({
        wcUsed: 1,
        wcAvailable: 1,
        ambUsed: 3,
        ambAvailable: 6,
        tetherUsed: 0,
        tetherAvailable: 2,
      }),
    ).toEqual([
      "1 of 1 wheelchair place used",
      "3 of 6 seats used",
      "0 of 2 anchored seats used",
    ]);
  });

  it("says in words when a run asks for more places than the van has", () => {
    const seats = {
      wcUsed: 2,
      wcAvailable: 1,
      ambUsed: 4,
      ambAvailable: 3,
      tetherUsed: 1,
      tetherAvailable: 1,
    };
    expect(seatLines(seats)[0]).toBe("2 of 1 wheelchair place used · more than this van has");
    expect(seatLines(seats)[1]).toBe("4 of 3 seats used · more than this van has");
    // Not over: the equal case is a full van, which is not a fault and says nothing extra.
    expect(seatLines(seats)[2]).toBe("1 of 1 anchored seat used");
  });

  /**
   * A convertible van's setup line changes between renders, because planning chooses the
   * configuration — so the lane says why, in words, rather than appearing to contradict itself.
   */
  it("explains a convertible van's setup line, and says nothing on a van with one setup", () => {
    const empty = routePlan(inputFor(), {});
    const convertible = laneIn(empty, "V1");
    expect(setUpChangeLine(convertible)).toBe(copy.setUpChanges.BEFORE);
    // The sedan is built one way: there is nothing to explain, and no line is added.
    expect(setUpChangeLine(laneIn(empty, "V4"))).toBeNull();

    const planned = planRoutes(inputFor());
    expect(setUpChangeLine(laneIn(planned, "V1"))).toBe(copy.setUpChanges.PLANNED);
    // Once somebody has seen the van, the configuration is the one that arrived (ASM-17).
    const seen = planLanes().map((lane) =>
      lane.id === "V1"
        ? { ...lane, capability: checkedAtRamp(lane.vehicle.id, lane.vehicle.layouts[1].id, "Dana K.") }
        : lane,
    );
    const atRamp = routePlan(inputFor(seen), planAssignment(inputFor(seen)));
    expect(setUpChangeLine(laneIn(atRamp, "V1"))).toBe(copy.setUpChanges.SEEN);
    // Plain words about the van, never the provider's shorthand for a configuration.
    for (const line of Object.values(copy.setUpChanges)) expect(line).not.toMatch(/\d+WC\/\d+A/);
  });
});

/**
 * The second demo day (AT-12).
 *
 * The scenario's own day places all nine riders, which is the right default and means the group
 * at the top of the screen — a child with no van, the reason, and the options a coordinator
 * chooses between — is never reached by walking the screen. The second day is that walk: the
 * convertible van is off the road, the provider sent the small substitute, and no van left today
 * holds a four-point strap.
 */
describe("the day one child has no van", () => {
  const hard = () => inputFor(planLanes("ONE_RIDER_HAS_NO_VAN"), planRiders("AM"));

  it("still runs three lanes, with the substitute in the convertible's place", () => {
    expect(planLanes("ONE_RIDER_HAS_NO_VAN").map((lane) => lane.vehicle.label)).toEqual([
      "V3",
      "V2",
      "V4",
    ]);
    // The first day is untouched, which is what keeps the feasible-plan check honest.
    expect(planLanes().map((lane) => lane.vehicle.label)).toEqual(["V1", "V2", "V4"]);
  });

  it("leaves exactly one child out, for a reason that names her and the missing hardware", () => {
    for (const direction of ["AM", "PM"] as const) {
      const input = inputFor(planLanes("ONE_RIDER_HAS_NO_VAN"), planRiders(direction));
      const plan = planRoutes({ ...input, direction });
      expect(plan.unplaced.map((u) => u.rider.child.displayName), direction).toEqual(["Zoe B."]);
      const [zoe] = plan.unplaced;
      expect(reasonLine(zoe, ""), direction).toBe("No van with four-point straps for Zoe B.");
      // Every other rider is in a van, and every lane the solver called a fit.
      const placed = plan.lanes.flatMap((lane) => lane.riders.length);
      expect(placed.reduce((a, b) => a + b, 0), direction).toBe(planRiders(direction).length - 1);
      for (const lane of plan.lanes) expect(lane.verdict.status, lane.lane.id).toBe("FEASIBLE");
    }
  });

  it("asks for a human, and has the convertible van to offer as a substitution", () => {
    const plan = planRoutes(hard());
    expect(needsADecision(plan.lanes, plan.unplaced)).toBe(true);
    // Every way out is a proposal: nothing is assigned, and no family has been told (AT-12).
    expect(plan.unplaced[0].options.length).toBeGreaterThan(0);
    expect(plan.unplaced[0].options.every((option) => option.requiresApproval)).toBe(true);
    // The van that fits her chair is the one that is off the road, so it is what a substitution
    // can bring back — and the lanes' own vans are never offered as their own replacement.
    expect(spareVehicleKeys("ONE_RIDER_HAS_NO_VAN")).toEqual(["V1"]);
    expect(spareVehicleKeys()).toEqual(["V3"]);
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
