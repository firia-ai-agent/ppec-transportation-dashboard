import { describe, expect, it } from "vitest";
import { flow, planBoard } from "@/ui/copy";
import type { BoardVan } from "@/domain/plan/board";
import type { DayReadiness } from "@/domain/day/readiness";
import {
  boardBanner,
  checkedChip,
  fitPreview,
  footerLines,
  initialsOf,
  meterSr,
  movedLine,
  overConfirm,
  placedLine,
  rejectChip,
  rejectSr,
  saveLine,
  setupFromLine,
  stopLine,
} from "./lines";

/**
 * The board's words, keyed by the facts behind them (redesign spec §1.3, §1.5, §9.5).
 *
 * The components render whatever this module returns, so this is where "what does the screen say
 * when a van is over its counts" is actually answered — and where the §0 rules are held: a state
 * has a word as well as a tone, a count reads `4/6`, and no sentence is longer than the spec's.
 */

const van = (over: Partial<BoardVan> = {}): BoardVan => ({
  id: "van-id",
  slot: 3,
  name: "Van 3",
  driverName: "Marco D.",
  setup: { seats: 3, wheelchairSpots: 0, carSeats: 1, oxygenMounts: 0, hasLift: false },
  setupState: "DEFAULT",
  setupSource: "YESTERDAY",
  setupFromDate: "2026-10-16",
  setupBy: "Ana P.",
  ...over,
});

const readiness = (over: Partial<DayReadiness> = {}): DayReadiness => ({
  date: "2026-10-17",
  leg: "PM",
  started: true,
  setup: { state: "NEEDED", checked: 0, total: 3, source: "YESTERDAY", fromDay: "Fri" },
  plan: { state: "NEEDED", unassigned: 9 },
  live: { state: "LOCKED", vansOut: 0, blockedBy: "PLAN" },
  approvals: { waiting: 0 },
  ...over,
});

describe("§1.5: the toolbar and the cards", () => {
  it("counts what is placed out of the whole leg", () => {
    expect(placedLine(10, 12)).toBe("10 of 12 placed");
  });

  it("reads a meter out as a number of a named thing", () => {
    expect(meterSr(4, 6, "seats")).toBe("4 of 6 Seats");
    expect(meterSr(0, 0, "wheelchairSpots")).toBe("0 of 0 Wheelchair");
  });

  it("says a rider's time and place in one line, in 12-hour time", () => {
    expect(stopLine("15:55", "Okeeheelee Park")).toBe("3:55 PM · Okeeheelee Park");
  });

  it("names a van's stops and its driving time", () => {
    expect(footerLines(3, 38)).toEqual({ stops: "3 stops", minutes: "38 min" });
  });

  it("takes a driver's initials from their own name, never from a code", () => {
    expect(initialsOf("Marco D.")).toBe("MD");
    expect(initialsOf("Ana")).toBe("A");
    expect(initialsOf("")).toBe("");
  });

  it("names the child and the van in a move and in a refusal", () => {
    expect(movedLine("Mia R.", "Van 2")).toBe("Mia R. → Van 2");
    expect(rejectChip("WHEELCHAIR")).toBe("Wheelchair");
    expect(rejectSr("Noah O.", "Van 3", "WHEELCHAIR")).toBe("Noah O. won’t fit Van 3: no wheelchair spot");
    expect(rejectSr("Mia R.", "Van 3", "CAR_SEAT")).toBe("Mia R. won’t fit Van 3: no car seat");
  });

  it("asks before saving a van that is over its own counts", () => {
    expect(overConfirm("Van 3")).toBe("Van 3 is over. Save anyway?");
  });

  it("previews one child against a changed setup, both ways", () => {
    expect(fitPreview("Noah O.", true)).toBe("Noah O. fits");
    expect(fitPreview("Noah O.", false)).toBe("Noah O. won’t fit");
  });
});

describe("§1.3: the save state is a word, not a dot", () => {
  it("says nothing has been saved, then that it is saving, then when it was", () => {
    expect(saveLine({ kind: "DIRTY" })).toEqual({ label: "Not saved", tone: "neutral" });
    expect(saveLine({ kind: "SAVING" })).toEqual({ label: "Saving…", tone: "neutral" });
    const saved = saveLine({ kind: "SAVED", at: "2026-10-17T18:41:00.000Z" });
    expect(saved).toEqual({ label: "Saved 2:41 PM", tone: "ok" });
  });

  it("says a save failed without claiming what was kept", () => {
    expect(saveLine({ kind: "FAILED" })).toEqual({ label: "Couldn’t save · Retry", tone: "crit" });
  });

  it("names whoever saved over it, and names nobody when the server has no name", () => {
    expect(saveLine({ kind: "CHANGED", by: "Dana M." })).toEqual({
      label: "Changed by Dana M. · Reload",
      tone: "warn",
    });
    expect(saveLine({ kind: "CHANGED", by: null })).toEqual({
      label: planBoard.changedAnon,
      tone: "warn",
    });
  });
});

describe("§1.3 / §9.3: what a van and a day say about themselves", () => {
  it("says whether the ramp has checked this van today, in a word", () => {
    expect(checkedChip(van({ setupState: "CHECKED" }))).toEqual({ label: "Checked", tone: "ok" });
    expect(checkedChip(van({ setupState: "DEFAULT" }))).toEqual({ label: "Not checked", tone: "warn" });
    expect(checkedChip(van({ setupState: "PLANNED" }))).toEqual({ label: "Not checked", tone: "warn" });
  });

  it("names the day a carried-forward setup came from, and who counted it", () => {
    expect(setupFromLine(van())).toBe("From Fri · Ana P.");
    // Nobody recorded: the front desk is who counts a van, and no person is invented.
    expect(setupFromLine(van({ setupBy: null }))).toBe("From Fri · Ramp staff");
    // Set today: there is no earlier day to name, so the line is not drawn at all.
    expect(setupFromLine(van({ setupFromDate: undefined }))).toBeNull();
  });

  it("says which step is missing, and offers the one link that fixes it", () => {
    expect(boardBanner(readiness(), "/ramp-ipad?van=1")).toEqual({
      text: flow.banner.usingYesterday,
      tone: "info",
      action: { label: flow.action.checkVans, href: "/ramp-ipad?van=1" },
    });
    expect(
      boardBanner(readiness({ setup: { state: "NEEDED", checked: 0, total: 3, source: "DEFAULT" } }), "/ramp-ipad?van=1")?.text,
    ).toBe(flow.banner.usingDefaults);
    // A day nobody has started is said first, and the DEMO bar is the only thing that starts one.
    expect(boardBanner(readiness({ started: false }), "/ramp-ipad?van=1")).toEqual({
      text: flow.banner.notStarted,
      tone: "warn",
      action: null,
    });
    // Every van counted today: nothing to say, so nothing is said.
    expect(
      boardBanner(readiness({ setup: { state: "DONE", checked: 3, total: 3, source: "TODAY" } }), null),
    ).toBeNull();
  });
});
