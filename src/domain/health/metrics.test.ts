import { describe, expect, it } from "vitest";
import { buildBoard, serviceDayFor } from "@/domain/board/board";
import { demoDay } from "@/domain/board/day";
import { BOARD_CENSUS } from "@/modules/demo/fixtures/standard";
import { BASELINE_ROWS, ROI_METRICS, dayCounts, metricByKey, ridesBehind } from "./metrics";

/**
 * SURF-07's numbers, over the committed demo day and over the finished day before it.
 *
 * Two days, because a count that cannot change is not a count. The demo day is read twelve
 * minutes into its morning runs, so every number on it is about a day in progress; the day
 * before it was driven to the end, and on that one the capacity solver refused a van — which is
 * the only way to see the placement number move off "every child".
 *
 * Nothing in here writes an expected figure out of thin air: each assertion re-derives its
 * number from the same board the screen renders, except the handful that pin the *story* of the
 * committed scenario (nine children ride with us; one ride ends holding a child).
 */

const LIVE = buildBoard();
/** The day before the demo day: the vans are in and every ride on it has an outcome. */
const FINISHED = buildBoard(serviceDayFor(demoDay().previousIso));

describe("the four numbers", () => {
  it("counts every metric exactly once, in the order they are read", () => {
    expect(dayCounts(LIVE).metrics.map((m) => m.key)).toEqual([...ROI_METRICS]);
  });

  /**
   * The ceiling, and the reason it is a test rather than a convention.
   *
   * Every other assertion on this screen — the tile count, the drill-down count, the number of
   * `aria-expanded` controls — is written against `ROI_METRICS.length`, so a fifth number added
   * to the list would make all of them agree with it on the way past. The thing that must not
   * happen is a fifth number, and nothing above would notice one. §4.6 asks for a panel a
   * person reads at a glance; the glance is what the ceiling protects.
   */
  it("is at most four, on the board as on the screen", () => {
    expect(ROI_METRICS.length).toBeLessThanOrEqual(4);
    expect(new Set(ROI_METRICS).size).toBe(ROI_METRICS.length);
    for (const board of [LIVE, FINISHED]) {
      expect(dayCounts(board).metrics.length).toBeLessThanOrEqual(4);
    }
  });

  /**
   * Four numbers and two rows with no number: the whole screen, and no sixth place a figure
   * could appear from. The two sets never overlap, so "hours saved" can never arrive as a
   * counted headline by being added to both lists.
   */
  it("keeps the counted numbers and the unmeasured rows apart", () => {
    for (const key of BASELINE_ROWS) {
      expect(ROI_METRICS as readonly string[], key).not.toContain(key);
    }
  });

  it("names the cohort it counted over: the board's own children and rides", () => {
    const counts = dayCounts(LIVE);
    expect(counts.children).toBe(LIVE.rows.length);
    expect(counts.rides).toBe(LIVE.legs.length);
    // PRD §18.1: the census pads the board to 28 children, each with a morning and an afternoon.
    expect(counts.children).toBe(BOARD_CENSUS);
    expect(counts.rides).toBe(BOARD_CENSUS * 2);
  });

  it("is about the day the board was read, at the instant it was read", () => {
    expect(dayCounts(LIVE).dayIso).toBe(LIVE.day.iso);
    expect(dayCounts(LIVE).nowMs).toBe(LIVE.nowMs);
  });

  it("gives every number the rides it was counted from, and they are the board's own rows", () => {
    const keys = new Set(LIVE.legs.map((leg) => leg.key));
    for (const metric of dayCounts(LIVE).metrics) {
      for (const key of metric.legKeys) expect(keys, metric.key).toContain(key);
      expect(ridesBehind(LIVE, metric).map((leg) => leg.key)).toEqual([...metric.legKeys]);
    }
  });

  it("names the children behind a number once each, in board order", () => {
    for (const metric of dayCounts(LIVE).metrics) {
      const expected = [
        ...new Set(ridesBehind(LIVE, metric).map((leg) => leg.child.childLabel)),
      ];
      expect(metric.children, metric.key).toEqual(expected);
    }
  });

  it("carries the extra minute count on the one metric that needs it and no other", () => {
    for (const metric of dayCounts(LIVE).metrics) {
      if (metric.key === "ARRIVING_LATE") continue;
      expect(metric.minutes, metric.key).toBeNull();
    }
  });
});

describe("children with a seat (MET-07, asked of the plan)", () => {
  it("is every child the scenario drives: nine, each with a morning and an afternoon", () => {
    const metric = metricByKey(dayCounts(LIVE), "CHILDREN_PLACED");
    expect(metric.outOf).toBe(9);
    expect(metric.count).toBe(9);
    // The rides behind it are those children's own rides, both halves of each day.
    expect(metric.legKeys).toHaveLength(18);
  });

  it("drops a child the solver could not seat, and keeps the rest", () => {
    const metric = metricByKey(dayCounts(FINISHED), "CHILDREN_PLACED");
    const refused = new Set(
      FINISHED.legs
        .filter(
          (leg) =>
            leg.ride.solver === "INFEASIBLE" || leg.ride.solver === "VEHICLE_UNAVAILABLE",
        )
        .map((leg) => leg.child.childLabel),
    );
    // The finished day is the one where a sedan could not hold three anchored seats (AT-12).
    expect(refused.size).toBeGreaterThan(0);
    expect(metric.outOf).toBe(9);
    expect(metric.count).toBe(9 - refused.size);
    for (const child of refused) expect(metric.children).not.toContain(child);
  });

  it("counts a child out on the strength of either ride, not both", () => {
    const metric = metricByKey(dayCounts(FINISHED), "CHILDREN_PLACED");
    const placed = new Set(metric.children);
    for (const leg of FINISHED.legs) {
      if (leg.ride.solver !== "INFEASIBLE" && leg.ride.solver !== "VEHICLE_UNAVAILABLE") continue;
      // Neither half of that child's day is in the placed list: the day did not hold together.
      expect(placed).not.toContain(leg.child.childLabel);
      expect(metric.legKeys).not.toContain(leg.key);
    }
  });

  it("counts a ride nobody has reported on yet as placed, because it has not been refused", () => {
    const metric = metricByKey(dayCounts(LIVE), "CHILDREN_PLACED");
    const pending = LIVE.legs.filter((leg) => leg.ride.solver === "CAPABILITY_PENDING");
    expect(pending.length).toBeGreaterThan(0);
    for (const leg of pending) expect(metric.legKeys).toContain(leg.key);
  });
});

describe("waiting on a van check (PRD §6.3)", () => {
  it("counts every ride whose van is not verified, out of the rides on a van", () => {
    const metric = metricByKey(dayCounts(LIVE), "VAN_UNCHECKED");
    const onAVan = LIVE.legs.filter((leg) => leg.ride.vehicleLabel !== null);
    expect(metric.outOf).toBe(onAVan.length);
    expect(metric.count).toBe(onAVan.filter((leg) => leg.ride.capability !== "VERIFIED").length);
    expect(metric.count).toBeGreaterThan(0);
  });

  it("never counts a ride the family drives: there is no van to check", () => {
    const metric = metricByKey(dayCounts(LIVE), "VAN_UNCHECKED");
    for (const leg of ridesBehind(LIVE, metric)) expect(leg.ride.vehicleLabel).not.toBeNull();
  });

  it("counts nothing on a day whose vans all went through the ramp", () => {
    // Every van on the finished day was checked — a manifest cannot be locked on an unchecked
    // vehicle, and the day was driven — so the number is zero and says so.
    expect(metricByKey(dayCounts(FINISHED), "VAN_UNCHECKED").count).toBe(0);
  });
});

describe("arriving later than planned (MET-08)", () => {
  it("counts only rides whose arrival has actually moved later", () => {
    const metric = metricByKey(dayCounts(LIVE), "ARRIVING_LATE");
    const measurable = LIVE.legs.filter((leg) => leg.ride.deltaSeconds !== null);
    expect(metric.outOf).toBe(measurable.length);
    expect(metric.count).toBe(measurable.filter((l) => (l.ride.deltaSeconds ?? 0) > 0).length);
    for (const leg of ridesBehind(LIVE, metric)) {
      expect(leg.ride.deltaSeconds ?? 0, leg.key).toBeGreaterThan(0);
    }
  });

  it("reports the furthest shift, in whole minutes", () => {
    const metric = metricByKey(dayCounts(LIVE), "ARRIVING_LATE");
    const worst = Math.max(...ridesBehind(LIVE, metric).map((l) => l.ride.deltaSeconds ?? 0));
    expect(metric.minutes).toBe(Math.round(worst / 60));
    expect(metric.minutes).toBeGreaterThan(0);
  });

  it("has nothing to report on a day where no arrival has been recalculated", () => {
    // A finished day keeps no live frame, so no ride on it carries a shift at all: the honest
    // answer is zero out of zero, and not "every ride was on time".
    const metric = metricByKey(dayCounts(FINISHED), "ARRIVING_LATE");
    expect(metric.count).toBe(0);
    expect(metric.outOf).toBe(0);
    expect(metric.minutes).toBeNull();
    expect(metric.legKeys).toEqual([]);
  });
});

describe("needs a person (MET-05)", () => {
  it("is the board's own needs-action count, out of every ride on the day", () => {
    for (const board of [LIVE, FINISHED]) {
      const metric = metricByKey(dayCounts(board), "NEEDS_A_PERSON");
      expect(metric.count, board.day.iso).toBe(board.needsActionCount);
      expect(metric.outOf, board.day.iso).toBe(board.legs.length);
    }
  });

  it("on the demo day that is the one ride ending with a child held (AT-13)", () => {
    const metric = metricByKey(dayCounts(LIVE), "NEEDS_A_PERSON");
    const legs = ridesBehind(LIVE, metric);
    expect(legs.map((l) => l.ride.state)).toContain("HELD_NO_RECEIVER");
    // And it opens on a named child, which is what makes the sentence worth reading.
    expect(metric.children).toHaveLength(1);
    expect(metric.children[0]).toMatch(/^[A-Z][a-z]+ [A-Z]\.$/);
  });
});

describe("a day the scenario does not run at all", () => {
  /** A Saturday: PRD §18.1 schedules the runs Mon–Fri, so the board has no rows. */
  const weekend = buildBoard(nextWeekend());

  it("has no rows to count, and counts nothing rather than inventing a denominator", () => {
    expect(weekend.legs).toHaveLength(0);
    const counts = dayCounts(weekend);
    expect(counts.children).toBe(0);
    expect(counts.rides).toBe(0);
    for (const metric of counts.metrics) {
      expect(metric.count, metric.key).toBe(0);
      expect(metric.outOf, metric.key).toBe(0);
      expect(metric.legKeys, metric.key).toEqual([]);
    }
  });
});

function nextWeekend() {
  for (let iso = demoDay().nextIso; iso !== null; ) {
    const day = serviceDayFor(iso);
    if (!day.scheduled) return day;
    iso = day.nextIso;
  }
  throw new Error("no unscheduled day within the board's date range");
}

describe("metricByKey", () => {
  it("throws on a key today's counts do not hold, rather than returning nothing", () => {
    const counts = dayCounts(LIVE);
    expect(() => metricByKey({ ...counts, metrics: [] }, "NEEDS_A_PERSON")).toThrow();
  });
});
