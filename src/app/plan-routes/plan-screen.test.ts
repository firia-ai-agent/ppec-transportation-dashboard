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
import {
  canTake,
  planAssignment,
  planRoutes,
  routePlan,
  type PlanInput,
  type RoutePlan,
} from "@/domain/solver";
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
    expect(page).toMatch(/requirePage\("\/plan-routes"\)/);
    expect(page).toMatch(/from "@\/auth\/page-guard"/);
    // A session read means the route can never be answered from a static render.
    expect(page).toMatch(/export const dynamic = "force-dynamic"/);
  });

  it("leaves the screen itself a plain client component with no guard of its own", () => {
    expect(screen).toMatch(/^"use client"/);
    expect(screen).not.toMatch(/redirect|requirePage|getCaller|auth\(\)/);
  });

  it("is the two console roles', and not the front desk's", () => {
    expect(pageOutcome({ kind: "ANONYMOUS" }, "/plan-routes")).toBe("SIGN_IN");
    expect(pageOutcome({ kind: "STAFF", role: "DIRECTOR" }, "/plan-routes")).toBe("ALLOW");
    expect(pageOutcome({ kind: "STAFF", role: "COORDINATOR" }, "/plan-routes")).toBe("ALLOW");
    // The ramp iPad is the front desk's surface; deciding which van a child rides in is not.
    expect(pageOutcome({ kind: "STAFF", role: "FRONT_DESK" }, "/plan-routes")).toBe("NO_ACCESS");
  });

  it("is reachable from the live map, so it is not URL-only", () => {
    const mapPage = readFileSync(path.resolve(HERE, "..", "live-map", "page.tsx"), "utf8");
    expect(mapPage).toMatch(/href="\/plan-routes"/);
    // ...and offered only to a role whose own row opens it, which is the table's answer again.
    expect(mapPage).toMatch(/canOpenPage\(caller, "\/plan-routes"\)/);
  });

  it("reads no database, calls no endpoint and loads no map tiles", () => {
    const screenAndHelpers = screen + read("lanes.ts");
    expect(screenAndHelpers).not.toMatch(/fetch\(|EventSource|maplibre|@\/db\//);
  });
});

describe("the screen's own rules", () => {
  const screen = read("PlanRoutes.tsx");
  const css = read("plan.module.css");

  /**
   * Vera's review, 2026-10-17: the one button says the same thing every time it is read.
   *
   * It used to become "Plan routes again" as soon as anybody was in a van — a second label for
   * one control, and the one it changed to read as "start over" to a coordinator who had just
   * moved two children by hand. There is one label, there is no `planAgain` left to print, and
   * what makes that honest is the behaviour below: planning keeps those moves.
   */
  it("has one primary action, it is Plan routes, and it is never relabelled", () => {
    expect(screen.match(/styles\.primary/g)).toHaveLength(1);
    expect(screen).toMatch(/className=\{styles\.primary\}[\s\S]{0,120}\{planRoutes\.plan\}/);
    expect(screen).not.toMatch(/planAgain/);
    expect(copy).not.toHaveProperty("planAgain");
  });

  /**
   * The other half of the same review: re-planning may not throw away a coordinator's own
   * placements without asking, and this screen keeps them rather than asking. The keeping is the
   * planner's (`planAssignment`'s `manual` argument, checked over a real plan below); what is
   * asserted here is that the screen hands it over and clears it when it stops being true.
   */
  it("plans around the children a coordinator placed by hand", () => {
    expect(screen).toMatch(/planAssignment\(input, pinned\)/);
    /*
     * Every accepted move records where it put them, and exactly once: `laneId` is the lane the
     * solver granted, or null for a child taken out of every van, so one line records both. It
     * was two lines until the move handler became a single call to `tryMove` — and a refusal
     * never reaches either, because it returns above them with no assignment to record.
     */
    const pinned = screen.match(/setPinned\(\(prev\) => \(\{ \.\.\.prev, \[childToken\]: laneId \}\)\)/g);
    expect(pinned, "an accepted move records the lane it was granted").toHaveLength(1);
    expect(screen).not.toMatch(/setPinned[\s\S]{0,60}\[childToken\]: null/);
    // A placement is about one fleet on one run, so a change of either drops it.
    const dropped = screen.match(/setPinned\(\{\}\)/g);
    expect(dropped, "the run switcher and the scenario toggle both clear it").toHaveLength(2);
  });

  /**
   * No vehicle code reaches the screen (Vera's review, 2026-10-17): a van is named by what it
   * is. The browser check reads the rendered text for a stray "V3"; this is the rule in the
   * source, which is where it can actually be kept — nothing here may print `vehicle.label`.
   */
  it("names a van by what it is, never by the code the fixtures file it under", () => {
    expect(screen + read("lanes.ts")).not.toMatch(/vehicle\.label/);
    expect(screen).toMatch(/const van = vanName\(lane\.vehicle\.description\)/);
  });

  /**
   * The same rule over the words the *planner* writes, which is where it was actually broken.
   *
   * The rule above reads the screen's own source, and the screen was clean: every van it names
   * goes through `vanName`. But a lane's options are the solver's sentences, built in
   * src/domain/solver/feasible.ts, and two of them interpolated `vehicle.label` — so "Run Zoe B.
   * separately on V3" reached the screen through copy the screen never touches, and only the
   * browser check caught it. A source rule cannot see that; a real plan can, so this asks a real
   * one. The state is the ramp measuring a chair larger than filed, which is the shortest way to
   * a lane that is infeasible and therefore carries options at all.
   */
  it("keeps the code out of the option sentences the planner writes, too", () => {
    const input = inputFor();
    const assignment = planAssignment(input);
    const measured = inputFor(
      planLanes(),
      input.riders.map((rider) => (rider.child.token === "C6" ? asMeasured(rider) : rider)),
    );
    const plan = routePlan(measured, assignment);

    const options = [
      ...plan.lanes.flatMap((lane) => lane.verdict.options ?? []),
      ...plan.unplaced.flatMap((row) => row.options),
    ];
    expect(options.length, "an infeasible lane offers a way out").toBeGreaterThan(0);
    for (const option of options) {
      expect(option.label, option.id).not.toMatch(/\bV\d{1,2}\b/);
      expect(option.detail, option.id).not.toMatch(/\bV\d{1,2}\b/);
    }
  });

  /**
   * Vera's review, 2026-10-17: the arrival answers and the substitution row are folded away.
   *
   * They are two real questions and neither is the one a lane is open for, so three answer
   * buttons and a substitution row under every lane — under the stops, on all three lanes — was
   * most of what the screen was. One disclosure now, and it opens itself while the van has
   * changed, because that is where the next step of the VEH-05 chain lives.
   */
  it("puts what arrived and the substitution behind one collapsed control", () => {
    expect(screen).toMatch(/aria-expanded=\{changesOpen\}/);
    expect(screen).toMatch(/\{planRoutes\.changeVan\}/);
    expect(screen).toMatch(/hidden=\{!changesOpen\}/);
    expect(screen).toMatch(
      /changing === lane\.id \|\| stage\.arrival === "CHANGED" \|\| stage\.arrival === "ASKED"/,
    );
  });

  /**
   * The repeated lines Vera counted: the intake caption was under every rider card and the
   * approval chip was beside every option. Each is said once now — the caption over the lanes,
   * the approval in the note under each option list.
   */
  it("says the intake caption once, and approval once per list rather than per option", () => {
    expect(screen.match(/planRoutes\.needsCaption/g)).toHaveLength(1);
    expect(screen).toMatch(/\{planRoutes\.optionsNote\}/);
    expect(screen).not.toMatch(/needsApproval/);
    expect(copy).not.toHaveProperty("needsApproval");
  });

  /**
   * D-6 / §4.1, at the review's own widths: the map is beside the lanes at 1024 as well as at
   * 1280, and when the columns stack it is directly under the header rather than after the last
   * lane. e2e/screens.spec.ts measures the boxes; this is the breakpoint that decides them.
   */
  it("keeps the map beside the lanes at 1024, and under the header when it cannot", () => {
    expect(css).toMatch(/@media \(min-width: 1024px\) \{\s*\.split \{\s*grid-template-columns:/);
    expect(css).toMatch(/@media \(max-width: 1023px\) \{\s*\.mapPane \{\s*order: -1/);
  });

  it("never makes a drag the only way to move a child (§9)", () => {
    // Every rider row is draggable *and* carries a Move menu that names the lanes in words.
    expect(screen).toMatch(/draggable/);
    expect(screen).toMatch(/const moveMenu = /);
    expect(screen).toMatch(/planRoutes\.moveTo/);
  });

  /**
   * Veri's finding, 2026-10-17: every move goes through the solver, and the screen has no way
   * left to skip it.
   *
   * The handler used to ask `canTake` and then call `withMove` as two separate steps, so the
   * check was one deletable line — and deleting it passed every test in the suite. Both are gone
   * from this file: the one mover is `tryMove`, which answers with the new assignment or with a
   * refusal that has no assignment in it, and the assignment is set from nothing else. The
   * behaviour is tested over a real plan in src/domain/solver/plan.test.ts and in the browser;
   * this is the part a reader of this screen can check at a glance.
   */
  it("moves a child only through tryMove, which is the check and the edit at once", () => {
    expect(screen).toMatch(/tryMove\(input, assignment, childToken, laneId\)/);
    // The drag's release and the Move menu both call the one handler, and it is the one above.
    expect(screen).toMatch(/move\(current\.childToken, zone\)/);
    expect(screen).toMatch(/onClick=\{\(\) => move\(token, lane\.id\)\}/);
    expect(screen).toMatch(/onClick=\{\(\) => move\(token, null\)\}/);
    // Nothing here asks the solver and then decides for itself what to do about the answer.
    expect(screen).not.toMatch(/canTake|withMove/);
    // And the assignment is only ever set from a move the solver granted.
    const assignments = screen.match(/setAssignment\(/g) ?? [];
    expect(assignments).toHaveLength(4);
    expect(screen).toMatch(/setAssignment\(result\.assignment\)/);
    // The other three are the whole day, not one child: planning it, and emptying it when the
    // run or the scenario changes.
    expect(screen).toMatch(/setAssignment\(planAssignment\(input, pinned\)\)/);
    expect(screen.match(/setAssignment\(emptyAssignment\(/g)).toHaveLength(2);
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

  /**
   * Vera's review, 2026-10-17: the screen's own first second is not a failure.
   *
   * Before planning, nobody is in a van — and that was being drawn as a red-bordered group
   * headed "Not in a van yet (9)", nine rider cards with equipment chips and intake captions,
   * and nine copies of a sentence saying nobody had pressed the button yet. The opening state is
   * its own group now: a neutral box, a heading that says what it is, and the names. The red
   * group and the critical border are kept for the children planning could not place.
   */
  it("opens on a neutral list of names, and keeps the red group for real failures", () => {
    expect(screen).toMatch(/const waiting = plan\.unplaced\.filter\([\s\S]{0,60}=== "NOT_IN_A_VAN"\)/);
    expect(screen).toMatch(/const blocked = plan\.unplaced\.filter\([\s\S]{0,60}!== "NOT_IN_A_VAN"\)/);
    expect(screen).toMatch(/group: planRoutes\.waitingHeading/);
    // A name and the §9 move control, and nothing else: no chips, no caption, no reason.
    const body = /const waitingBody = \(rider: PlanRider\) => \([\s\S]*?\n  \);/.exec(screen)?.[0] ?? "";
    expect(body).toMatch(/riderName/);
    expect(body).toMatch(/moveMenu\(rider, null\)/);
    expect(body).not.toMatch(/needChips|needsCaption|reasonLine|StateChip/);
    // The critical border belongs to the blocked group alone.
    expect(css).toMatch(/\.unplaced \{[^}]*border: var\(--border-hairline\) solid var\(--color-crit-fg\)/);
    expect(css).toMatch(/\.waiting \{[^}]*border: var\(--border-hairline\) solid var\(--color-border-strong\)/);
  });

  /**
   * ...and the plan agrees with that split: on first load the normal day has nine children in
   * no van and not one reason among them, so the neutral group is the whole of it. The second
   * scenario has one real failure from the start — no van on the day holds her chair, which is
   * true before anybody plans anything — so the red group is reached by reading, not by acting.
   */
  it("has nothing to explain about the normal day before it is planned", () => {
    const opening = routePlan(inputFor(), {});
    expect(opening.unplaced).toHaveLength(planRiders("AM").length);
    expect([...new Set(opening.unplaced.map((row) => row.cause))]).toEqual(["NOT_IN_A_VAN"]);
    expect(needsADecision(opening.lanes, opening.unplaced)).toBe(false);

    const hard = routePlan(inputFor(planLanes("ONE_RIDER_HAS_NO_VAN")), {});
    const blocked = hard.unplaced.filter((row) => row.cause !== "NOT_IN_A_VAN");
    expect(blocked.map((row) => row.rider.child.displayName)).toEqual(["Zoe B."]);
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
    // The stop first and the verdict not at all: the chip beside this line already says it
    // doesn't fit (Vera's review, 2026-10-17).
    expect(missing).toMatch(/^At .+, this van has /);
    expect(missing).not.toMatch(/Doesn’t fit/);
    expect(blocked).toBe(copy.laneBlocked);
  });

  /**
   * The chips say what the van is built with; the place lines beside them say how full it is.
   * They used to say both: "3 seats" and "2 anchored seats" were chips as well as the second
   * half of two lines directly underneath ("0 of 3 seats used"), which is the same number twice
   * in two shapes (Vera's review, 2026-10-17). The chairs are what is left, because a wheelchair
   * place carries hardware and a footprint that no count can say.
   */
  it("says a van's equipment as the day has it, without repeating the place lines", () => {
    const plan = planRoutes(inputFor());
    const lane = laneIn(plan, "V1");
    const chips = equipmentChips(lane.lane.vehicle, lane.layout, lane.lane.capability);
    expect(chips[0]).toBe(copy.equipment.lift);
    expect(chips.some((c) => c.includes(securement.FOUR_POINT_STRAP))).toBe(true);
    // No bare seat counts: those are the lines' job, and the lines are read right below.
    for (const chip of chips) expect(chip, chip).not.toMatch(/^\d+ (seats?|anchored seats?)$/);
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

  /**
   * Vera's review, 2026-10-17: a kind of place the van has none of and nobody is using is left
   * out. "0 of 0 wheelchair places used" is true of the sedan and is not a fact — and it was on
   * two of the day's three lanes, directly under two chips saying the same numbers.
   */
  it("leaves out a place line that reads 0 of 0", () => {
    expect(
      seatLines({
        wcUsed: 0,
        wcAvailable: 0,
        ambUsed: 2,
        ambAvailable: 3,
        tetherUsed: 0,
        tetherAvailable: 0,
      }),
    ).toEqual(["2 of 3 seats used"]);
    // A van *asked* for a place it has none of still says so: that is the whole reason the run
    // does not fit, and the first number is not zero.
    expect(
      seatLines({ wcUsed: 1, wcAvailable: 0, ambUsed: 0, ambAvailable: 0, tetherUsed: 0, tetherAvailable: 0 }),
    ).toEqual(["1 of 0 wheelchair places used · more than this van has"]);
    // And the sedan, read off a real plan: no wheelchair place, so no wheelchair line.
    const sedan = laneIn(planRoutes(inputFor()), "V4");
    expect(sedan.seats.wcAvailable).toBe(0);
    expect(seatLines(sedan.seats).some((line) => line.includes("wheelchair"))).toBe(false);
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
 * The second demo scenario (AT-12).
 *
 * The normal day places all nine riders, which is the right default and means the group at the
 * top of the screen — a child with no van, the reason, and the options a coordinator chooses
 * between — is never reached by walking the screen. The second scenario is that walk, on the
 * same service date: the convertible van is off the road, the provider sent the small
 * substitute, and no van left today holds a four-point strap.
 */
describe("the scenario where one child has no van", () => {
  const hard = () => inputFor(planLanes("ONE_RIDER_HAS_NO_VAN"), planRiders("AM"));

  it("still runs three lanes, with the substitute in the convertible's place", () => {
    expect(planLanes("ONE_RIDER_HAS_NO_VAN").map((lane) => lane.vehicle.label)).toEqual([
      "V3",
      "V2",
      "V4",
    ]);
    // The normal scenario is untouched, which keeps the feasible-plan check honest.
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

/**
 * Re-planning keeps what a coordinator did by hand (Vera's review, 2026-10-17).
 *
 * "Plan routes" used to search from nothing every time, so the one button on the screen quietly
 * undid every drag — a coordinator who had moved two children and wanted the rest filled in had
 * no way to ask for that. The keeping lives in the planner rather than in the screen, because
 * "keep what a person decided and fill in the rest" is a property of a plan: a manual placement
 * seeds the lane, the search places everybody else around it, and every placement in the result
 * is still one the four constraints agreed with.
 */
describe("re-planning around a coordinator's own placements", () => {
  /** A rider the solver placed in one lane who another lane would also take. */
  function aMovableRider(input: PlanInput) {
    const assignment = planAssignment(input);
    for (const [laneId, tokens] of Object.entries(assignment)) {
      for (const token of tokens) {
        const other = input.lanes.find(
          (lane) => lane.id !== laneId && canTake(input, assignment, lane.id, token).ok,
        );
        if (other) return { token, from: laneId, to: other.id };
      }
    }
    throw new Error("no rider on this day can be moved to a second van");
  }

  it("leaves a child where they were put and plans the rest of the day around them", () => {
    const input = inputFor();
    const { token, from, to } = aMovableRider(input);

    const again = planAssignment(input, { [token]: to });
    expect(again[to], "the child a coordinator moved").toContain(token);
    expect(again[from]).not.toContain(token);
    // Nobody was dropped to make room: the whole day is still placed.
    expect(Object.values(again).flat().sort()).toEqual(
      input.riders.map((rider) => rider.child.token).sort(),
    );
    // And it is still the solver's plan, lane by lane.
    for (const lane of routePlan(input, again).lanes) {
      expect(lane.verdict.status, lane.lane.id).toBe("FEASIBLE");
    }
  });

  it("leaves a child a coordinator took out of a van out of every van", () => {
    const input = inputFor();
    const { token } = aMovableRider(input);
    const again = planAssignment(input, { [token]: null });
    expect(Object.values(again).flat()).not.toContain(token);
    // They are the only one, and the screen's own group says so with no reason attached.
    const plan = routePlan(input, again);
    expect(plan.unplaced.map((row) => row.rider.child.token)).toEqual([token]);
    expect(plan.unplaced[0].cause).toBe("NOT_IN_A_VAN");
  });

  it("plans a child normally when the lane they were put in is not on this day", () => {
    const input = inputFor();
    const { token } = aMovableRider(input);
    // The scenario or the run changed under the placement, so it is not theirs any more.
    const again = planAssignment(input, { [token]: "a-lane-that-is-not-here" });
    expect(Object.values(again).flat()).toContain(token);
    expect(again).toEqual(planAssignment(input));
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

  /**
   * The refusal, as Vera rewrote it: the child first, because they are who was being moved, and
   * the van by its own name. "V2 can't take Zoe B." opened on a code nobody says out loud.
   */
  it("refuses a move in one line that names the child, the van and what is missing", () => {
    const plan = planRoutes(inputFor());
    const centerVan = laneIn(plan, "V2").lane.vehicle;
    const zoe = planRiders("AM").find((r) => r.child.token === "C6");
    expect(refusalLine(centerVan, zoe!.child, "NO_SECUREMENT")).toBe(
      "Can’t put Zoe B. in the center van: no four-point straps.",
    );
    expect(refusalLine(centerVan, zoe!.child, "NO_SEAT")).toBe(
      "Can’t put Zoe B. in the center van: no free seat.",
    );
    // No vehicle code in it, whatever the cause.
    for (const cause of ["NO_SECUREMENT", "NO_SEAT", "UNKNOWN_UNTIL_ARRIVAL"] as const) {
      expect(refusalLine(centerVan, zoe!.child, cause), cause).not.toMatch(/\bV\d\b/);
    }
  });

  it("counts the plan in riders, not in rows", () => {
    expect(summaryLine(7, 9)).toBe("7 of 9 riders are in a van.");
  });
});
