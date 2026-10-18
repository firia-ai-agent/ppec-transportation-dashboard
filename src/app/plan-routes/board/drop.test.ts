import { describe, expect, it } from "vitest";
import { REJECT_REASONS, type RejectReason } from "@/config/equipment";
import { childTokenOf } from "@/modules/demo/fixtures/standard";
import { testDay, vanIdOfSlot } from "@/test/board-day";
import { applyPending, enqueue, NO_PENDING } from "@/domain/plan/pending";
import { autoPlan, emptyPlan, ridersInVan, type BoardPlan } from "@/domain/plan/board";
import { planBoard } from "@/ui/copy";
import { dropOutcome } from "./drop";
import { movedLine, rejectCardLine, rejectSr } from "./lines";

/**
 * WHAT A DROP DOES — the three outcomes, and the one that used to lie.
 *
 * The S1 report was a card that bounced to Unassigned with no reason anywhere and the toast
 * "Zoe B. → Unassigned". That toast is the *success* line, so the question these assertions
 * answer is: can any refused or impossible drop still reach it? It cannot — a refusal is
 * `REFUSED` with no toast and the card left where it was, and a target this board does not have
 * is `NOTHING`.
 */

const ZOE = childTokenOf("C6");
const NOAH = childTokenOf("C2");

/** The plan as the screen would show it after this drop was queued (option A: a draft). */
function afterDrop(
  plan: BoardPlan,
  childToken: string,
  bucket: "VAN" | "UNASSIGNED" | "ABSENT" | "FAMILY_DRIVES",
  vanId: string | null,
): BoardPlan {
  return applyPending(plan, enqueue(NO_PENDING, { childToken, bucket, vanId }));
}

describe("a drop that lands", () => {
  it("queues the move and leaves the van's own toast behind", async () => {
    const day = await testDay("AM");
    const vanOne = vanIdOfSlot(1);
    const outcome = dropOutcome(day, emptyPlan(day), ZOE, "VAN", vanOne);

    expect(outcome).toEqual({
      kind: "MOVE",
      bucket: "VAN",
      vanId: vanOne,
      toast: movedLine("Zoe B.", "Van 1"),
      announce: movedLine("Zoe B.", "Van 1"),
    });
    // "Zoe B. → Van 1 · Undo" — the existing toast, unchanged (Vera: a successful drop keeps it).
    expect(outcome.kind === "MOVE" && outcome.toast).toBe("Zoe B. → Van 1");
  });

  /** "→ Unassigned" is the answer to a drop **on** Unassigned, and to nothing else. */
  it("says Unassigned only for a drop on the Unassigned column", async () => {
    const day = await testDay("AM");
    const planned = autoPlan(day, emptyPlan(day));
    expect(dropOutcome(day, planned, ZOE, "UNASSIGNED", null)).toMatchObject({
      kind: "MOVE",
      vanId: null,
      toast: movedLine("Zoe B.", planBoard.unassigned),
    });
    // And the two groups say their own names rather than falling through to it.
    expect(dropOutcome(day, planned, ZOE, "ABSENT", null)).toMatchObject({
      toast: movedLine("Zoe B.", planBoard.absent),
    });
    expect(dropOutcome(day, planned, ZOE, "FAMILY_DRIVES", null)).toMatchObject({
      toast: movedLine("Zoe B.", planBoard.familyDrives),
    });
  });
});

/* ───────────────────────── 5. a refused drop leaves the card alone ───────────────────────── */

describe("5. a refused drop", () => {
  /** Van 1 counted down to one seat and no spot: the one way a generic van refuses a chair. */
  async function refusingDay() {
    return testDay("AM", {
      1: { seats: 1, wheelchairSpots: 0, carSeats: 0, oxygenMounts: 0, hasLift: false },
    });
  }

  it("does not move the card, and never to Unassigned", async () => {
    const day = await refusingDay();
    const vanOne = vanIdOfSlot(1);
    const before = emptyPlan(day);
    const outcome = dropOutcome(day, before, ZOE, "VAN", vanOne);

    expect(outcome.kind).toBe("REFUSED");
    // The board returns before it queues anything, so the plan on screen is the plan it was.
    expect(before[ZOE]).toMatchObject({ bucket: "UNASSIGNED", vanId: null });
    expect(ridersInVan(day, before, vanOne)).toEqual([]);

    // And a child already in a van stays in **that** van: a refusal is not an unassignment.
    const inVanTwo = afterDrop(before, ZOE, "VAN", vanIdOfSlot(2));
    expect(inVanTwo[ZOE]).toMatchObject({ bucket: "VAN", vanId: vanIdOfSlot(2) });
    expect(dropOutcome(day, inVanTwo, ZOE, "VAN", vanOne).kind).toBe("REFUSED");
    expect(inVanTwo[ZOE]).toMatchObject({ bucket: "VAN", vanId: vanIdOfSlot(2) });
  });

  it("leaves no toast at all — the reason is on the card (Vera)", async () => {
    const day = await refusingDay();
    const outcome = dropOutcome(day, emptyPlan(day), ZOE, "VAN", vanIdOfSlot(1));
    expect(outcome).toEqual({
      kind: "REFUSED",
      vanId: vanIdOfSlot(1),
      reason: "WHEELCHAIR",
      line: rejectCardLine("Van 1", "WHEELCHAIR"),
      announce: rejectSr("Zoe B.", "Van 1", "WHEELCHAIR"),
    });
    expect(outcome).not.toHaveProperty("toast");
    // The sentence for the ear is kept, which is the §1.3 rule a refusal has always obeyed.
    expect(outcome.kind === "REFUSED" && outcome.announce).toContain("Zoe B.");
  });

  /** Every refusal the day can produce names the van it is about, in four words. */
  it("names the van, for every reason the day can give", async () => {
    const day = await testDay("AM", {
      1: { seats: 0, wheelchairSpots: 0, carSeats: 0, oxygenMounts: 0, hasLift: false },
      2: { seats: 6, wheelchairSpots: 1, carSeats: 0, oxygenMounts: 0, hasLift: true },
      3: { seats: 6, wheelchairSpots: 1, carSeats: 3, oxygenMounts: 1, hasLift: false },
    });
    const seen = new Set<RejectReason>();
    for (const van of day.vans) {
      for (const rider of day.riders) {
        const outcome = dropOutcome(day, emptyPlan(day), rider.token, "VAN", van.id);
        if (outcome.kind !== "REFUSED") continue;
        seen.add(outcome.reason);
        expect(outcome.line).toContain(van.name);
        expect(outcome.line).toBe(rejectCardLine(van.name, outcome.reason));
      }
    }
    // The day really does exercise more than one of them.
    expect(seen.size).toBeGreaterThan(1);
    for (const reason of seen) expect(REJECT_REASONS).toContain(reason);
  });
});

/* ───────────────────────── nothing to do, and nothing claimed ───────────────────────── */

describe("a drop with nothing to do", () => {
  it("is NOTHING for a van this board is not drawing", async () => {
    const day = await testDay("AM");
    // The exact shape that used to reach `movedLine(name, planBoard.unassigned)` — a non-null
    // van id the day has no van for — and so produced "Zoe B. → Unassigned" out of thin air.
    expect(dropOutcome(day, emptyPlan(day), ZOE, "VAN", "not-a-van")).toEqual({ kind: "NOTHING" });
    expect(dropOutcome(day, emptyPlan(day), ZOE, "VAN", null)).toEqual({ kind: "NOTHING" });
  });

  it("is NOTHING for a child this day does not have", async () => {
    const day = await testDay("AM");
    expect(dropOutcome(day, emptyPlan(day), "not-a-child", "VAN", vanIdOfSlot(1))).toEqual({
      kind: "NOTHING",
    });
  });

  it("still moves a child who is not a rider on this leg", async () => {
    const day = await testDay("AM");
    const other = day.others[0];
    expect(other, "the day has a child the centre does not drive").toBeTruthy();
    expect(dropOutcome(day, emptyPlan(day), other.token, "UNASSIGNED", null)).toMatchObject({
      kind: "MOVE",
      toast: movedLine(other.name, planBoard.unassigned),
    });
  });

  /** A second chair rider, for the record: the refusal is the van's counts and not who she is. */
  it("refuses the second chair into a van whose one spot is taken", async () => {
    const day = await testDay("AM");
    const vanOne = vanIdOfSlot(1);
    const withZoe = afterDrop(emptyPlan(day), ZOE, "VAN", vanOne);
    expect(dropOutcome(day, withZoe, NOAH, "VAN", vanOne)).toMatchObject({
      kind: "REFUSED",
      reason: "WHEELCHAIR",
      line: rejectCardLine("Van 1", "WHEELCHAIR"),
    });
  });
});
