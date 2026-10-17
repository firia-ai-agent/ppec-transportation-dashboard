import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildBoard } from "@/domain/board/board";
import { adapterHealth } from "@/domain/health/adapters";
import { dayCounts, ridesBehind } from "@/domain/health/metrics";
import {
  arrivedAsPlanned,
  boardArrival,
  rampArrivals,
  replanForArrival,
  type RampArrival,
  type RampFinding,
} from "@/domain/plan/arrival";
import { DATA_CLASS_ENV_VAR, SYNTHETIC_DATA_CLASS } from "@/lib/env";
import {
  adapterDegraded,
  adapterDoing,
  adapterMockedBecause,
  adapterModeChip,
  adapterName,
  metricLabel,
  metricLine,
  metricValue,
  metricWhy,
  ridesHeading,
} from "@/app/(app)/health/lines";
import { nextStepCellText, stateValues } from "@/app/(app)/today/next-step";
import { needChips, positionDetail, positionLabel } from "@/app/ramp-ipad/capability";
import {
  arrivalBannerLines,
  holdLines,
  laneVanName,
  moveLines,
  rideChangeLine,
  rideChangeState,
  screenArrival,
  stayLines,
} from "./arrival-lines";
import {
  board as boardCopy,
  fill,
  health,
  layoutName,
  nav,
  rampIpad,
  serviceDate,
  vanName,
} from "./copy";
import { legStates, type StateDescriptor } from "./states";

/**
 * The two screens a founder is walked through, rendered from the seed: no van key, no layout
 * shorthand, no synthetic-name prefix, no provider id.
 *
 * `no-codes.test.ts` holds the same rule for the strings a screen can hold *statically* — the
 * copy table, the literals in a component, the fixture fields that are rendered as words. This
 * is the half neither of those nets can see: a code that reaches a screen by being *interpolated
 * out of the day* at render time. The scenario files a van under "V2", its configuration under
 * "1WC/3A", its owner under "Provider P1" and every synthetic person under a "SYN" prefix, and
 * all four are one `${}` away from any sentence on either screen — which is how "V1" was in the
 * Health screen's own van column until the commit that added this file.
 *
 * So the two screens' view models are *run*, over the seed day and over every ramp finding the
 * day can produce, and everything they return is scanned:
 *
 *  - the ramp re-plan (src/ui/arrival-lines.ts), which is one check in sentences and is read on
 *    three screens — the iPad that took it, the plan it changes and the board's row notes;
 *  - the words the iPad puts round that check (src/app/ramp-ipad/capability.ts): the van in the
 *    heading, the configuration buttons and the places on them, which is the one screen a
 *    layout shorthand could reach at all;
 *  - Health & ROI (src/app/(app)/health/lines.ts and the cells HealthScreen renders around it),
 *    including the rides behind each number, which is where the drill-down names a van.
 *
 * The child drawer (src/app/(app)/today/LegDrawer.tsx) and the board's own van column used to be
 * out of scope here, on the grounds that printing the van's key beside its provider was a §4.1
 * density decision rather than a leak. Vera's prod walk settled it the other way (2026-10-17
 * 2:48 PM ET): the drawer the Health screen opens read "V4 · SYN Coastal Car Service" and the
 * board's column read "V2" on every row, and a density argument does not make a key readable.
 * Both say the van's name now, through the same `vanTitle` every other screen uses — and because
 * both are *rendered* rather than returned as strings, the net over them is the markup one in
 * src/ui/rendered-no-codes.test.ts.
 */
const PATTERNS: ReadonlyArray<{ name: string; re: RegExp }> = [
  /** The key the scenario files a van under: "V1" … "V4". The name is "the convertible van". */
  { name: "a fixture van key", re: /\bV\d\b/g },
  /** The trade's seat-layout shorthand. The screens say "1 wheelchair · 3 seats" (`layoutName`). */
  { name: "a layout shorthand", re: /\d+WC\/\d+A/g },
  /** The prefix every synthetic person, site and provider carries, so none is mistaken for real. */
  { name: "a synthetic-name prefix", re: /\bSYN\b/g },
  /** The provider as the fleet fixture ids it, rather than as anybody says it. */
  { name: "a provider id", re: /Provider P\d/g },
];

/** The single pattern the four above are, so the scan is one regex a reviewer can read. */
const ANY_CODE = /\bV\d\b|\d+WC\/\d+A|\bSYN\b|Provider P\d/;

function codesIn(text: string): string[] {
  return PATTERNS.flatMap(({ re }) => [...text.matchAll(re)].map((m) => m[0]));
}

/** Every string the §3 chip puts on a screen, placeholders filled as the chip fills them. */
function chipLabel(state: StateDescriptor, values?: Record<string, string | number>): string {
  return values ? fill(state.label, values) : state.label;
}

/* ───────────────────────── the ramp check, in every shape the day makes one ───────────────────────── */

/**
 * Every finding the ramp can hand the re-planner about one van: it arrived as planned, it
 * arrived in each of its other configurations, a place is out of service, nobody could answer
 * for one, the lift or the anchors are out, and a chair was measured bigger than the file said
 * (AT-04). One of these per van the day runs, which is what makes the set worth scanning: the
 * sentences differ by van, by rider and by which half of the count is zero.
 */
function findings(arrival: RampArrival): RampFinding[] {
  const planned = arrivedAsPlanned(arrival);
  const riders = arrival.riders.map((rider) => rider.child.token);
  const places = arrival.vehicle.layouts.flatMap((layout) =>
    layout.code === planned.layoutCode ? layout.positions.map((_, i) => i + 1) : [],
  );
  return [
    planned,
    ...arrival.vehicle.layouts.map((layout) => ({ ...planned, layoutCode: layout.code })),
    ...places.map((place) => ({ ...planned, outOfService: [place] })),
    { ...planned, outOfService: places },
    { ...planned, unanswered: places.slice(0, 1) },
    { ...planned, liftOk: false },
    { ...planned, liftOk: null },
    { ...planned, latchOk: false },
    { ...planned, latchOk: null },
    { ...planned, measured: riders },
  ];
}

/** Everything the three screens say about one ramp check. */
function replanStrings(finding: RampFinding): string[] {
  const replan = replanForArrival(finding);
  const lines = [...stayLines(replan), ...moveLines(replan), ...holdLines(replan)];
  const changes = [...boardArrival(replan).changes.values()];
  return [
    laneVanName(finding.laneId),
    ...arrivalBannerLines(replan),
    ...screenArrival(replan).lines,
    ...lines.map((line) => line.text),
    ...lines.flatMap((line) => (line.state ? [chipLabel(line.state)] : [])),
    ...changes.map((change) => rideChangeLine(change)),
    ...changes.flatMap((change) => {
      const state = rideChangeState(change);
      return state ? [chipLabel(state)] : [];
    }),
  ];
}

/**
 * The words the ramp iPad puts round the check itself, which is where a layout shorthand would
 * reach a screen if one ever did: the configuration buttons, the places on them and what each
 * rider needs. The van in the heading comes through `vanName`, the configuration through
 * `layoutName`, and a place is named by its ordinal rather than by the id the projection files
 * it under ("V1/1WC/3A/W1").
 */
function rampCheckStrings(arrival: RampArrival): string[] {
  const out = [fill(rampIpad.checklistHeading, { vehicle: vanName(arrival.vehicle.description) })];
  for (const layout of arrival.vehicle.layouts) {
    out.push(layoutName(layout.code));
    layout.positions.forEach((position, index) => {
      out.push(positionLabel(position, index + 1), positionDetail(position));
    });
  }
  for (const rider of arrival.riders) out.push(...needChips(rider.child));
  return out.filter((text) => text.length > 0);
}

/* ───────────────────────────── Health & ROI, on the seed day ───────────────────────────── */

const BOARD = buildBoard();
const COUNTS = dayCounts(BOARD);
const ADAPTERS = adapterHealth(BOARD, {
  [DATA_CLASS_ENV_VAR]: SYNTHETIC_DATA_CLASS,
  DEMO_MODE: "1",
});

/**
 * Every word the Health screen puts on the page: its own headings, the four numbers with their
 * labels and sentences, the two rows with no number, the adapter panel — and the rides behind
 * each number, cell by cell, because the drill-down is the one part of this screen that renders
 * a van at all.
 */
function healthStrings(): string[] {
  const out: string[] = [
    nav.health,
    serviceDate.groupLabel,
    BOARD.day.label,
    serviceDate.phases[BOARD.day.phase],
    health.intro,
    health.roiHeading,
    health.watermark,
    fill(health.sampleNote, { children: COUNTS.children, rides: COUNTS.rides }),
    health.showRides,
    health.hideRides,
    health.noRides,
    health.baseline.heading,
    health.baseline.intro,
    health.baseline.noNumber,
    ...Object.values(health.baseline.columns),
    ...Object.values(health.baseline.rows).flatMap((row) => [row.label, row.detail]),
    ...Object.values(health.rideColumns),
    health.adapterPanel.heading,
    health.adapterPanel.allMockedIntro,
    health.adapterPanel.someLiveIntro,
    ...Object.values(health.adapterPanel.columns),
  ];
  for (const metric of COUNTS.metrics) {
    out.push(
      metricValue(metric),
      metricLabel(metric.key),
      metricLine(metric),
      metricWhy(metric.key),
      ridesHeading(metric),
    );
    // The rides behind the number, as the five columns render them.
    for (const leg of ridesBehind(BOARD, metric)) {
      out.push(
        fill(boardCopy.openRow, {
          child: leg.child.childLabel,
          ride: leg.ride.direction === "AM" ? boardCopy.amSpoken : boardCopy.pmSpoken,
        }),
        leg.child.childLabel,
        leg.ride.direction === "AM" ? boardCopy.am : boardCopy.pm,
        chipLabel(legStates[leg.ride.state], stateValues(leg)),
        leg.ride.vehicleDescription === null
          ? boardCopy.familyDrives
          : vanName(leg.ride.vehicleDescription),
        nextStepCellText(leg),
      );
    }
  }
  for (const row of ADAPTERS.rows) {
    out.push(
      adapterName(row.key),
      chipLabel(adapterModeChip(row)),
      adapterDoing(row),
      adapterMockedBecause(row) ?? "",
      adapterDegraded(row.key),
    );
  }
  return out;
}

/**
 * The Health screen's own markup, for the one assertion no rendered string can make: that the
 * van cell is built out of the van's description and not out of the row's key. Comments are
 * stripped where the file is read as code — a code named in a note to the next engineer is
 * exactly where it belongs.
 */
const SCREEN = readFileSync(
  path.resolve(__dirname, "..", "app", "(app)", "health", "HealthScreen.tsx"),
  "utf8",
);

function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/* ───────────────────────────── the scan, and the two screens ───────────────────────────── */

describe("the van-code scan itself works", () => {
  it("catches each of the four codes, as the day writes them", () => {
    expect(codesIn("V2 · SYN Greenacres center fleet")).toEqual(["V2", "SYN"]);
    expect(codesIn("Checked as 1WC/3A.")).toEqual(["1WC/3A"]);
    expect(codesIn("V1 · Provider P1")).toEqual(["V1", "Provider P1"]);
    expect(codesIn("Reported by Hal B. at SYN Palm Lift Transport.")).toEqual(["SYN"]);
    // And the one regex the review asked for says the same of each of them.
    for (const text of ["V2", "1WC/3A", "SYN Org", "Provider P1"]) {
      expect(ANY_CODE.test(text), text).toBe(true);
    }
  });

  it("passes the words that merely look like one", () => {
    expect(codesIn("the convertible van moves Owen C. to the center van.")).toEqual([]);
    expect(codesIn("1 wheelchair · 3 seats")).toEqual([]);
    // The watermark and the confidence note: "SYN" bounded at both ends is the code, not a word
    // that happens to start with it.
    expect(codesIn("SYNTHETIC")).toEqual([]);
    expect(codesIn("Synthetic data from a seeded demo day. Not a real result.")).toEqual([]);
    expect(codesIn("Simulated")).toEqual([]);
    for (const text of ["SYNTHETIC", "Simulated", "the center van"]) {
      expect(ANY_CODE.test(text), text).toBe(false);
    }
  });

  it("is scanning the two screens over a day that has something to say", () => {
    // Enough findings to reach every branch of the re-plan, and four numbers with rides behind
    // them: a net over an empty list passes for the wrong reason.
    const arrivals = rampArrivals();
    expect(arrivals.length).toBeGreaterThan(2);
    expect(arrivals.flatMap(findings).length).toBeGreaterThan(20);
    expect(arrivals.flatMap(rampCheckStrings).length).toBeGreaterThan(20);
    expect(COUNTS.metrics).toHaveLength(4);
    expect(COUNTS.metrics.flatMap((m) => ridesBehind(BOARD, m)).length).toBeGreaterThan(10);
    expect(healthStrings().filter((s) => s.length > 0).length).toBeGreaterThan(60);
  });
});

describe("the ramp re-plan names vans and never codes them", () => {
  for (const arrival of rampArrivals()) {
    // The lane is named by the van on it, which is the assertion this suite is about — so the
    // case name cannot be the lane id either.
    it(`says nothing but words about ${laneVanName(arrival.laneId)}`, () => {
      for (const text of rampCheckStrings(arrival)) {
        expect(codesIn(text), text).toEqual([]);
      }
      for (const finding of findings(arrival)) {
        for (const text of replanStrings(finding)) {
          expect(codesIn(text), `${JSON.stringify(finding)}\n${text}`).toEqual([]);
        }
      }
    });
  }
});

describe("Health & ROI names vans and never codes them", () => {
  it("puts no van key, layout shorthand, synthetic prefix or provider id on the screen", () => {
    for (const text of healthStrings()) {
      expect(codesIn(text), text).toEqual([]);
    }
  });

  /**
   * The column the fix is about, pinned to what it says rather than to what it does not: the
   * drill-down names the van, and the name is the one every other screen uses for it.
   */
  /**
   * And the markup really does render that, which the suite above cannot see: the van cell is
   * built at render time out of a board row, so a column that went back to printing the row's
   * `vehicleLabel` would be a code on the screen with every string in this file still clean.
   * The same net `no-codes.test.ts` keeps over the map's vehicle cards, for the same reason.
   */
  it("builds that cell out of the van's description, never out of the row's label", () => {
    const cell = /className=\{styles\.vanCell\}>([\s\S]*?)<\/td>/.exec(SCREEN);
    expect(cell).not.toBeNull();
    const [, children] = cell!;
    expect(children).toMatch(/vanName\(leg\.ride\.vehicleDescription\)/);
    expect(children).not.toMatch(/vehicleLabel/);
    // Nowhere else either: this screen has no other use for the key, and the drawer it opens is
    // the board's component with the board's own rule (see this file's header).
    expect(withoutComments(SCREEN)).not.toMatch(/vehicleLabel/);
  });

  it("names the van in the rides behind a number, as the plan and the ramp name it", () => {
    const cells = COUNTS.metrics
      .flatMap((metric) => ridesBehind(BOARD, metric))
      .flatMap((leg) =>
        leg.ride.vehicleLabel === null || leg.ride.vehicleDescription === null
          ? []
          : [[leg.ride.vehicleLabel, vanName(leg.ride.vehicleDescription)] as const],
      );
    expect(cells.length).toBeGreaterThan(0);
    for (const [key, cell] of cells) {
      // The same string the ramp iPad's heading and the plan's banner put on that van, off the
      // same key — one name per van, not a second one written for this column.
      expect(cell, key).toBe(laneVanName(key));
      expect(cell, key).not.toBe(key);
    }
  });
});
