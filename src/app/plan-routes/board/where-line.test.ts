import { describe, expect, it } from "vitest";
import { emptyPlan } from "@/domain/plan/board";
import { applyPending, enqueue, NO_PENDING } from "@/domain/plan/pending";
import { childTokenOf } from "@/modules/demo/fixtures/standard";
import { testDay, vanIdOfSlot } from "@/test/board-day";
import { fill, planBoard } from "@/ui/copy";
import { whereLine } from "./ChildPanel";

/**
 * WHERE THE CHILD PANEL SAYS A CHILD IS — Veri's S2 of 2026-10-18.
 *
 * With a Family drives child's panel open the subline read "Unassigned · Afternoon": the line
 * was built from the child's *van* alone, and a child in no van was Unassigned by elimination.
 * They are not waiting for anything — their family drives them — so the line now comes from the
 * child's **bucket on this leg's plan**, in the lane's own words (copy.ts `familyDrives`).
 *
 * The plans here are built the way the board builds them (`emptyPlan` plus the pending queue),
 * so the bucket asserted against is one a drop would really leave behind.
 */

/** Ana S. is one of the three the centre does not drive; Eli M. rides a van. */
const ANA = childTokenOf("C10");

describe("whereLine names the lane a child is actually in", () => {
  it("says the van when they are in one", async () => {
    const day = await testDay("PM");
    const rider = day.riders[0];
    const vanOne = vanIdOfSlot(1);
    const plan = applyPending(
      emptyPlan(day),
      enqueue(NO_PENDING, { childToken: rider.token, bucket: "VAN", vanId: vanOne }),
    );
    const van = day.vans.find((candidate) => candidate.id === vanOne);

    expect(whereLine(van?.name ?? null, plan[rider.token].bucket, "PM")).toBe(
      fill(planBoard.child.where, { van: van?.name ?? "", leg: planBoard.afternoon }),
    );
  });

  it("says Unassigned for a child waiting to be placed", async () => {
    const day = await testDay("PM");
    const rider = day.riders[0];
    const plan = emptyPlan(day);

    expect(plan[rider.token].bucket).toBe("UNASSIGNED");
    expect(whereLine(null, plan[rider.token].bucket, "PM")).toBe(
      fill(planBoard.child.whereUnassigned, { leg: planBoard.afternoon }),
    );
  });

  it("says Family drives for a family-drives child, morning and afternoon", async () => {
    const day = await testDay("PM");
    const plan = emptyPlan(day);

    expect(plan[ANA].bucket).toBe("FAMILY_DRIVES");
    expect(whereLine(null, plan[ANA].bucket, "PM")).toBe(
      fill(planBoard.child.where, { van: planBoard.familyDrives, leg: planBoard.afternoon }),
    );
    expect(whereLine(null, plan[ANA].bucket, "AM")).toBe(
      fill(planBoard.child.where, { van: planBoard.familyDrives, leg: planBoard.morning }),
    );
    // The line a coordinator reads, in full: the lane, then the leg — and never "Unassigned".
    expect(whereLine(null, plan[ANA].bucket, "PM")).toContain(planBoard.familyDrives);
    expect(whereLine(null, plan[ANA].bucket, "PM")).not.toContain(planBoard.unassigned);
  });

  it("says Absent for a child nobody is driving today", async () => {
    const day = await testDay("PM");
    const rider = day.riders[0];
    const plan = applyPending(
      emptyPlan(day),
      enqueue(NO_PENDING, { childToken: rider.token, bucket: "ABSENT", vanId: null }),
    );

    expect(whereLine(null, plan[rider.token].bucket, "PM")).toBe(
      fill(planBoard.child.where, { van: planBoard.absent, leg: planBoard.afternoon }),
    );
  });

  it("follows the child out of the lane and into a van", async () => {
    const day = await testDay("PM");
    const vanThree = vanIdOfSlot(3);
    const van = day.vans.find((candidate) => candidate.id === vanThree);
    const plan = applyPending(
      emptyPlan(day),
      enqueue(NO_PENDING, { childToken: ANA, bucket: "VAN", vanId: vanThree }),
    );

    expect(whereLine(van?.name ?? null, plan[ANA].bucket, "PM")).toBe(
      fill(planBoard.child.where, { van: van?.name ?? "", leg: planBoard.afternoon }),
    );
  });
});
