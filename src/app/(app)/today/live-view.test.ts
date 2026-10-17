/**
 * The board's own half of the live surface: the merge, the regrouping, and the link between a
 * row and a marker.
 *
 * The values themselves are src/domain/board/live.test.ts's; what is tested here is that the
 * screen folds them in without changing anything else, and that the client's grouping of an
 * un-merged board is byte-identical to the server's — otherwise the first stream event would
 * silently re-order a board nobody asked to re-order.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { buildBoard, demoDay, serviceDayFor, BOARD_SCENARIO_TICK } from "@/domain/board/board";
import { liveSnapshotAt } from "@/domain/board/live";
import { tickAtScenarioSeconds } from "@/domain/eta/scenario-clock";
import { board as boardCopy, liveUpdates } from "@/ui/copy";
import {
  groupsOf,
  liveLegs,
  mergeLiveRide,
  needsActionCountOf,
  streamsLiveUpdates,
  vanIdOf,
} from "./live-view";

const board = buildBoard();
const here = path.dirname(new URL(import.meta.url).pathname);
const read = (file: string): string => readFileSync(path.join(here, file), "utf8");

describe("the client groups a board exactly as the server does", () => {
  it("gives the same groups, in the same order, with the same rows", () => {
    expect(groupsOf(board.legs)).toEqual(board.groups);
    expect(needsActionCountOf(board.legs)).toBe(board.needsActionCount);
  });
});

describe("a row and its marker find each other", () => {
  it("every van on the board is a van in the snapshot (or one with no position)", () => {
    const snapshot = liveSnapshotAt(BOARD_SCENARIO_TICK);
    const known = new Set([
      ...snapshot.vehicles.map((v) => v.id),
      ...snapshot.silent.map((v) => v.id),
    ]);
    const onBoard = new Set(
      board.legs.map(vanIdOf).filter((id): id is string => id !== null),
    );
    expect(onBoard.size).toBeGreaterThan(0);
    for (const van of onBoard) expect(known, `${van} is on the board`).toContain(van);
  });

  it("a ride the family drives has no van to point at", () => {
    const family = board.legs.find((leg) => leg.ride.mode === "FAMILY");
    expect(family).toBeDefined();
    expect(vanIdOf(family!)).toBeNull();
  });
});

describe("the merge", () => {
  const snapshot = liveSnapshotAt(tickAtScenarioSeconds(780));

  it("leaves a row alone when the tick says nothing about it", () => {
    const leg = board.legs[0];
    expect(mergeLiveRide(leg, undefined)).toBe(leg);
  });

  it("replaces what telemetry owns and nothing else", () => {
    const live = snapshot.rides.find((ride) => ride.gpsFreshness === "LOST");
    expect(live).toBeDefined();
    const leg = board.legs.find((l) => l.key === live!.key);
    expect(leg).toBeDefined();
    const merged = mergeLiveRide(leg!, live!);

    // The live half.
    expect(merged.ride.gpsFreshness).toBe("LOST");
    expect(merged.ride.etaPaused).toBe(true);
    expect(merged.needsActionReasons).toContain("LOCATION_LOST");
    expect(merged.group).toBe("NEEDS_ACTION");
    expect(merged.nextStep).toBe("FIND_VAN");

    // The day's half, untouched: the child, their needs, the van, the receiver, the plan.
    expect(merged.child).toBe(leg!.child);
    expect(merged.ride.vehicleLabel).toBe(leg!.ride.vehicleLabel);
    expect(merged.ride.plannedWindow).toBe(leg!.ride.plannedWindow);
    expect(merged.ride.stop).toBe(leg!.ride.stop);
    expect(merged.ride.capability).toBe(leg!.ride.capability);
    expect(merged.key).toBe(leg!.key);
  });

  it("keeps the board's row order and count whatever the tick says", () => {
    const merged = liveLegs(board.legs, snapshot);
    expect(merged.map((leg) => leg.key)).toEqual(board.legs.map((leg) => leg.key));
  });

  it("moves a van's rides into needs action, which is why the rows are grouped again", () => {
    const merged = liveLegs(board.legs, snapshot);
    expect(needsActionCountOf(merged)).toBeGreaterThan(board.needsActionCount);
    const lost = merged.filter((leg) => leg.ride.gpsFreshness === "LOST");
    expect(lost.length).toBeGreaterThan(0);
    for (const leg of lost) {
      const group = groupsOf(merged).find((g) => g.legs.includes(leg));
      expect(group?.group).toBe("NEEDS_ACTION");
    }
  });

  it("is a no-op with no snapshot at all, so the server's board is what a browser gets first", () => {
    expect(liveLegs(board.legs, null)).toBe(board.legs);
  });
});

describe("which days are streamed", () => {
  it("the demo day is", () => {
    expect(streamsLiveUpdates(demoDay())).toBe(true);
  });

  it("a finished day and an unstarted one are not: they have no van on the road", () => {
    const finished = serviceDayFor(demoDay().previousIso);
    expect(finished.phase).toBe("ENDED");
    expect(streamsLiveUpdates(finished)).toBe(false);
    expect(streamsLiveUpdates({ phase: "PLANNED", scheduled: true })).toBe(false);
  });

  it("a day with no rides on it is not", () => {
    expect(streamsLiveUpdates({ phase: "LIVE", scheduled: false })).toBe(false);
  });
});

/**
 * The parts of the surface that only exist as markup. Read as source, the way the other
 * screen checks in this repo do (src/ui/shell.test.ts, src/components/map/pane.test.ts): the
 * map pane imports MapLibre, which needs a browser, so the rendered proof is the Playwright
 * spec and this is the proof that the wiring is there to render.
 */
describe("§4.1: the row and the marker are wired to each other", () => {
  const screen = read("TodayBoard.tsx");
  const pane = read("BoardMap.tsx");

  it("a row publishes its van on the pointer and on focus, so the link is not mouse-only", () => {
    expect(screen).toMatch(/onMouseEnter=\{\(\) => onPoint\(ride\.vehicleLabel\)\}/);
    expect(screen).toMatch(/onMouseLeave=\{\(\) => onPoint\(null\)\}/);
    expect(screen).toMatch(/onFocus=\{\(\) => onPoint\(ride\.vehicleLabel\)\}/);
    expect(screen).toMatch(/onBlur=\{\(\) => onPoint\(null\)\}/);
    // And the row carries the van as data, which is what the browser check reads.
    expect(screen).toMatch(/data-van=\{ride\.vehicleLabel \?\? undefined\}/);
  });

  it("the pane is told which van to ring and which to fly to, and they are different things", () => {
    expect(pane).toMatch(/selectedVehicleId=\{selectedVanId\}/);
    expect(pane).toMatch(/highlightVehicleId=\{highlightVanId\}/);
  });

  it("selecting a marker opens that van's ride, so the two halves stay one screen", () => {
    expect(screen).toMatch(/onSelectVan=\{\(id\) => \{/);
    expect(screen).toMatch(/legs\.find\(\(l\) => vanIdOf\(l\) === id\)/);
  });

  it("the pane folds away, and the rows keep their own column when it does", () => {
    expect(pane).toContain("copy.hideMap");
    expect(pane).toContain("copy.showMap");
    expect(pane).toMatch(/aria-expanded=\{shown\}/);
    const css = read("today.module.css");
    expect(css).toMatch(
      /\.split\[data-with-map="true"\] \{\s*grid-template-columns: minmax\(0, 1fr\) clamp\(/,
    );
    // Below the width the split was decided at, the rows take everything and the pane is gone.
    expect(css).toMatch(/@media \(max-width: 1279px\) \{[\s\S]*?\.mapPane \{\s*display: none;/);
    expect(css).toMatch(/@media \(max-width: 1279px\)/);
  });

  it("the pane says what ingest dropped and which van is not on the map at all", () => {
    expect(pane).toContain("copy.pointsUsed");
    expect(pane).toContain("copy.pointsDropped");
    expect(pane).toContain("copy.mapSilent");
    expect(boardCopy.mapSilent).toContain("not linked");
  });

  it("the §2 bar's words are the design's, and the board never hides a row behind them", () => {
    expect(liveUpdates.downBody).toBe(
      "Live updates paused. Reconnecting… Board may be up to 40 s old.",
    );
    const bar = readFileSync(path.join(here, "..", "..", "..", "ui", "LiveUpdatesBar.tsx"), "utf8");
    expect(bar).toContain("WifiOff");
    expect(bar).toMatch(/role="status"/);
  });
});
