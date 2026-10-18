import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  boardRiders,
  checkPlan,
  childrenInBucket,
  emptyPlan,
  namesOnlyThisDay,
  ridersInVan,
  type BoardPlan,
} from "@/domain/plan/board";
import { eligibility } from "@/domain/plan/eligibility";
import { applyPending, enqueue, movesToSave, NO_PENDING, type PendingQueue } from "@/domain/plan/pending";
import { childTokenOf } from "@/modules/demo/fixtures/standard";
import { testDay, vanIdOfSlot } from "@/test/board-day";
import { planBoard } from "@/ui/copy";
import { dropOutcome } from "./drop";
import { UnassignedColumn } from "./UnassignedColumn";

/**
 * THE FAMILY DRIVES LANE — Firia's bug report of 2026-10-18.
 *
 * What was on the board was one collapsed line reading "3". Ana S., Beni A. and Cleo M. are the
 * three children the centre does not drive, and they arrived as `day.others`: no needs, no card,
 * nothing to lift. So the lane could not be opened onto anything useful, a family who could not
 * drive today had no way into a van, and — the part nobody would have seen — a drop on a van
 * would not have been counted against that van's seats, because `eligibility` did not know they
 * were children of the day at all.
 *
 * What these assertions hold, end to end on the one roster:
 *  - the lane is **open** the first time the board draws it, with a full `RiderCard` each, and
 *    Absent is still a count row (founder 6:49 — Absent does not change);
 *  - a card moves onto a van through the one drop rule and the one eligibility function, which
 *    answers with their approved needs — nothing approved means a seat and nothing else;
 *  - the same card moves back into Family drives;
 *  - the plan that results passes the two checks a save runs, `checkPlan` and `namesOnlyThisDay`,
 *    and survives the pending queue (`movesToSave`), which is what the server is sent.
 *
 * The lane is rendered for real with `renderToStaticMarkup`, so "it is a card" is the markup and
 * not a claim about a prop.
 */

/** The three children the centre does not drive: the pad of the twelve-child roster. */
const ANA = childTokenOf("C10");
const BENI = childTokenOf("C11");
const CLEO = childTokenOf("C12");

const COLUMNS = [{ id: null as string | null, name: planBoard.unassigned }];

function lane(day: Awaited<ReturnType<typeof testDay>>, plan: BoardPlan): string {
  return renderToStaticMarkup(
    createElement(UnassignedColumn, {
      day,
      plan,
      shown: true,
      columns: COLUMNS,
      onMove: () => undefined,
      onMoveToBucket: () => undefined,
      onOpenChild: () => undefined,
      canEdit: true,
      overBucket: null,
    }),
  );
}

describe("the Family drives lane is open, with a card each", () => {
  it("draws Ana S., Beni A. and Cleo M. as RiderCards without anybody opening anything", async () => {
    const day = await testDay("PM");
    const markup = lane(day, emptyPlan(day));

    // The lane itself: open, and its list in the markup rather than behind a toggle.
    expect(markup).toContain('data-bucket-list="FAMILY_DRIVES"');
    for (const [token, name] of [[ANA, "Ana S."], [BENI, "Beni A."], [CLEO, "Cleo M."]] as const) {
      // `data-rider` is the card's own attribute: a name in a `<li>` would not carry it.
      expect(markup, name).toContain(`data-rider="${token}"`);
      expect(markup, name).toContain(name);
      // And the card is draggable and openable, which is what the grip and the `Move to…`
      // control are: the same two a waiting child's card has.
      expect(markup, name).toContain(`data-move-to="${token}"`);
    }
    // No kerb of ours: the card's second line is the lane's own label (Vera, 2026-10-18 — it
    // used to read "No pickup stop", which named a thing that was missing).
    expect(markup).toContain(planBoard.familyDrives);
  });

  it("leaves Absent exactly as it was: a count row, closed (founder 6:49)", async () => {
    const day = await testDay("PM");
    const markup = lane(day, emptyPlan(day));

    expect(markup).toContain('data-bucket-count="ABSENT"');
    // Closed: no list, and the toggle says so for a screen reader.
    expect(markup).not.toContain('data-bucket-list="ABSENT"');
    const absent = markup.slice(markup.indexOf('data-bucket="ABSENT"'));
    expect(absent).toContain('aria-expanded="false"');
    const family = markup.slice(
      markup.indexOf('data-bucket="FAMILY_DRIVES"'),
      markup.indexOf('data-bucket="ABSENT"'),
    );
    expect(family).toContain('aria-expanded="true"');
  });

  it("counts the three in the lane's badge and not in Unassigned", async () => {
    const day = await testDay("PM");
    const plan = emptyPlan(day);
    expect(childrenInBucket(day, plan, "FAMILY_DRIVES").map((child) => child.name)).toEqual([
      "Ana S.",
      "Beni A.",
      "Cleo M.",
    ]);
    expect(childrenInBucket(day, plan, "ABSENT")).toEqual([]);
  });
});

describe("a Family drives child moves onto a van and back", () => {
  it("goes through the one drop rule and the one eligibility function", async () => {
    const day = await testDay("PM");
    const vanOne = vanIdOfSlot(1);
    const before = emptyPlan(day);

    // Eligibility knows her, which is the whole fix: she is a child of the day, she needs
    // nothing approved, so Van 1 takes her on a seat.
    expect(eligibility(day, before, ANA, vanOne)).toEqual({ ok: true });

    const onto = dropOutcome(day, before, ANA, "VAN", vanOne);
    expect(onto).toMatchObject({ kind: "MOVE", bucket: "VAN", vanId: vanOne });

    const queue: PendingQueue = enqueue(NO_PENDING, { childToken: ANA, bucket: "VAN", vanId: vanOne });
    const inVan = applyPending(before, queue);
    expect(inVan[ANA]).toEqual({ bucket: "VAN", vanId: vanOne, pinned: true });
    // She is in the van the board draws, and she is counted there.
    expect(ridersInVan(day, inVan, vanOne).map((rider) => rider.token)).toContain(ANA);
    expect(childrenInBucket(day, inVan, "FAMILY_DRIVES").map((child) => child.token)).toEqual([
      BENI,
      CLEO,
    ]);

    // And back. The drop on the lane is a placement with no van, and it says the lane's name.
    const back = dropOutcome(day, inVan, ANA, "FAMILY_DRIVES", null);
    expect(back).toMatchObject({ kind: "MOVE", bucket: "FAMILY_DRIVES", vanId: null });
    const home = applyPending(inVan, enqueue(NO_PENDING, {
      childToken: ANA,
      bucket: "FAMILY_DRIVES",
      vanId: null,
    }));
    expect(home[ANA]).toEqual({ bucket: "FAMILY_DRIVES", vanId: null, pinned: true });
    expect(ridersInVan(day, home, vanOne).map((rider) => rider.token)).not.toContain(ANA);
    expect(childrenInBucket(day, home, "FAMILY_DRIVES").map((child) => child.token)).toEqual([
      ANA,
      BENI,
      CLEO,
    ]);
  });

  it("is refused by the same rule when the van has no seat left", async () => {
    // One seat on Van 1, and a rider already in it: the honest answer for a child who needs a
    // seat and nothing else is "Van 1 seats full", not a silent yes.
    const day = await testDay("PM", { 1: { seats: 1 } });
    const vanOne = vanIdOfSlot(1);
    const taken = applyPending(
      emptyPlan(day),
      enqueue(NO_PENDING, { childToken: day.riders[0].token, bucket: "VAN", vanId: vanOne }),
    );

    expect(eligibility(day, taken, ANA, vanOne)).toEqual({ ok: false, reason: "SEAT" });
    expect(dropOutcome(day, taken, ANA, "VAN", vanOne)).toMatchObject({
      kind: "REFUSED",
      reason: "SEAT",
      vanId: vanOne,
    });
  });

  it("is a child of the board like any other: one roster, not two", async () => {
    const day = await testDay("PM");
    const tokens = boardRiders(day).map((rider) => rider.token);
    for (const token of [ANA, BENI, CLEO]) expect(tokens).toContain(token);
    expect(tokens.length).toBe(day.riders.length + day.others.length);
  });
});

describe("the move a Save would send", () => {
  it("passes checkPlan and namesOnlyThisDay, and is one move on the queue", async () => {
    const day = await testDay("PM");
    const vanOne = vanIdOfSlot(1);
    const saved = emptyPlan(day);
    const queue = enqueue(NO_PENDING, { childToken: ANA, bucket: "VAN", vanId: vanOne });

    expect(movesToSave(saved, queue)).toEqual([
      { childToken: ANA, bucket: "VAN", vanId: vanOne },
    ]);

    const next = applyPending(saved, queue);
    expect(namesOnlyThisDay(day, next)).toBe(true);
    expect(checkPlan(day, next)).toEqual({ ok: true });

    // And the way back is one move too, with no van on it.
    const home = enqueue(NO_PENDING, { childToken: ANA, bucket: "FAMILY_DRIVES", vanId: null });
    expect(movesToSave(next, home)).toEqual([
      { childToken: ANA, bucket: "FAMILY_DRIVES", vanId: null },
    ]);
    expect(namesOnlyThisDay(day, applyPending(next, home))).toBe(true);
  });

  it("refuses a plan that puts her in a van with no seat for her", async () => {
    // The server's own replay, not the screen's: a plan posted with seven children in a van
    // that seats six is refused by `checkPlan`, and she is counted among the seven.
    const day = await testDay("PM", { 1: { seats: 1 } });
    const vanOne = vanIdOfSlot(1);
    const over = applyPending(emptyPlan(day), [
      { childToken: day.riders[0].token, bucket: "VAN", vanId: vanOne },
      { childToken: ANA, bucket: "VAN", vanId: vanOne },
    ]);
    expect(checkPlan(day, over)).toMatchObject({ ok: false, reason: "SEAT", vanId: vanOne });
  });
});
