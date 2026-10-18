import { describe, expect, it } from "vitest";
import { closestCenter, type ClientRect } from "@dnd-kit/core";
import { childTokenOf } from "@/modules/demo/fixtures/standard";
import { TEST_DATE, testDay, vanIdOfSlot } from "@/test/board-day";
import { emptyPlan } from "@/domain/plan/board";
import { eligibility } from "@/domain/plan/eligibility";
import { UNASSIGNED_ID } from "./UnassignedColumn";
import { dropTarget, resolveDrop, type DropRects } from "./collision";

/**
 * WHERE A DROP LANDS — the S1 bug Firia hit on prod, as arithmetic.
 *
 * The report: after Start, dragging Zoe B. onto Van 1 bounced her back to Unassigned, with no
 * refusal anywhere — only the toast "Zoe B. → Unassigned". That toast is the **success** path
 * (PlanBoard `applyPlacement` → `movedLine(name, planBoard.unassigned)`), and a fit rejection
 * returns with no toast at all, so the drop did not fail a rule: it *landed on the Unassigned
 * column*, which is where the card already was.
 *
 * Why, in one line: `closestCenter` compares the dragged card's **translated rect centre** with
 * each column's centre, and the pointer is nowhere in that comparison. Every column on this
 * board is the same height (`.columns` is a stretch flex row and `.column` is `max-height:
 * 100%`), so the vertical term is identical for all of them and the whole decision is the
 * horizontal one: the midpoint between the Unassigned column's centre and Van 1's centre lands
 * on Van 1's left edge. Grab a 158 px card anywhere right of its middle — the name, the need
 * icons — drop it on the left half of Van 1, and the card's centre is still left of that
 * midpoint. The nearest centre is the column the card came from.
 *
 * So the fix is hit detection, not the fit rule, and it is unit-testable: `resolveDrop` is the
 * same decision over plain rectangles, and `dropTarget` is the `CollisionDetection` the board
 * hands dnd-kit. Both layouts the design is reviewed at are measured here, because the failure
 * is made of geometry and the two geometries are different screens.
 */

/* ───────────────────────────── the two layouts, measured ───────────────────────────── */

/** A rect the way the browser hands one over, from its corner and its size. */
function rect(left: number, top: number, width: number, height: number): ClientRect {
  return { left, top, width, height, right: left + width, bottom: top + height };
}

/**
 * 1440 × 900, the wide review width (png/plan-board.png).
 *
 * The 232 px rail, then the board's own 16 px padding (`--space-5`), then the columns: the
 * Unassigned column is 176 px wide and each van 196 px, with 8 px (`--space-3`) between them,
 * which is board.module.css's `.columns` / `.column` exactly. Every column is as tall as the
 * board, so they share a centre line — which is what makes this failure horizontal.
 */
const WIDE: DropRects = {
  [UNASSIGNED_ID]: rect(248, 168, 176, 712),
  VAN_1: rect(432, 168, 196, 712),
  VAN_2: rect(636, 168, 196, 712),
  VAN_3: rect(840, 168, 196, 712),
  // The two groups at the foot of the Unassigned column, which are droppables of their own.
  FAMILY_DRIVES: rect(257, 792, 158, 40),
  ABSENT: rect(257, 836, 158, 40),
};

/**
 * 390 × 844, the phone (png/plan-board-390.png), where **one column is on screen at a time**:
 * `.column[data-shown="false"]` is `display: none`, and a node with no box measures as a zero
 * rect at the origin. dnd-kit keeps those droppables registered, so the origin is a candidate.
 */
const PHONE: DropRects = {
  VAN_1: rect(8, 148, 374, 412),
  [UNASSIGNED_ID]: rect(0, 0, 0, 0),
  VAN_2: rect(0, 0, 0, 0),
  VAN_3: rect(0, 0, 0, 0),
  FAMILY_DRIVES: rect(0, 0, 0, 0),
  ABSENT: rect(0, 0, 0, 0),
};

/** Zoe B.'s card where the Unassigned list draws it at 1440: 158 px wide, near the top. */
const ZOE_CARD = rect(257, 240, 158, 52);

/** The same card translated by a drag, which is the rect dnd-kit compares. */
function dragged(card: ClientRect, grab: { x: number; y: number }, pointer: { x: number; y: number }) {
  const dx = pointer.x - grab.x;
  const dy = pointer.y - grab.y;
  return {
    collisionRect: rect(card.left + dx, card.top + dy, card.width, card.height),
    pointer,
  };
}

/* ───────────────────────────── 1. the bug, with the seeded day ───────────────────────────── */

describe("1. Zoe B. dropped on Van 1 (the S1 bounce)", () => {
  /**
   * The drop Firia made: Zoe B.'s card is grabbed on its right-hand half — her need icons sit
   * there — and let go over the left third of Van 1, which is where an empty column draws its
   * "Drop here" target.
   */
  const GRAB = { x: 400, y: 266 };
  const POINTER = { x: 470, y: 300 };

  it("resolves to Van 1, not to the column she came from", async () => {
    const day = await testDay("AM");
    const vanOne = vanIdOfSlot(1);
    const { collisionRect, pointer } = dragged(ZOE_CARD, GRAB, POINTER);

    // The pointer is genuinely inside Van 1's column, which is the whole of the user's intent.
    expect(pointer.x).toBeGreaterThan(WIDE.VAN_1.left);
    expect(pointer.x).toBeLessThan(WIDE.VAN_1.right);
    expect(pointer.y).toBeGreaterThan(WIDE.VAN_1.top);
    expect(pointer.y).toBeLessThan(WIDE.VAN_1.bottom);

    expect(resolveDrop(WIDE, collisionRect, pointer)).toBe("VAN_1");
    // And the same drop through the collision function the board actually hands dnd-kit.
    expect(idsOf(dropTarget(argsFor(WIDE, collisionRect, pointer)))[0]).toBe("VAN_1");

    // The day's rules are not what refused her: Van 1, empty, can take her — so the only
    // honest outcome of this drop is that she lands. (Recorded here so a future reading of
    // this test cannot mistake the bug for a capacity refusal.)
    expect(eligibility(day, emptyPlan(day), childTokenOf("C6"), vanOne)).toEqual({ ok: true });
    expect(day.date).toBe(TEST_DATE);
  });

  /** The old behaviour, written down: this is what produced "Zoe B. → Unassigned". */
  it("is a drop closestCenter gave to the Unassigned column", () => {
    const { collisionRect, pointer } = dragged(ZOE_CARD, GRAB, POINTER);
    expect(idsOf(closestCenter(argsFor(WIDE, collisionRect, pointer)))[0]).toBe(UNASSIGNED_ID);
  });
});

/* ───────────────────────────── 2. hit detection, both widths ───────────────────────────── */

describe("2. a drop goes where the pointer is", () => {
  it("at 1440, anywhere inside Van 1's column is Van 1", () => {
    for (const pointer of [
      { x: 440, y: 180 }, // just inside the top-left corner
      { x: 530, y: 524 }, // dead centre
      { x: 620, y: 870 }, // bottom-right corner
    ]) {
      const { collisionRect } = dragged(ZOE_CARD, { x: 400, y: 266 }, pointer);
      expect(resolveDrop(WIDE, collisionRect, pointer), `pointer ${pointer.x},${pointer.y}`).toBe(
        "VAN_1",
      );
    }
  });

  /**
   * At 390 the hidden columns measure as a zero rect at the origin, and the origin is closer to
   * the top-left of the one column on screen than that column's own centre is. So a drop at the
   * top of the shown column used to resolve to a column the phone is not even drawing — the same
   * bounce, with the card landing somewhere nobody can see.
   */
  it("at 390, a column the phone has hidden never wins", () => {
    const card = rect(17, 274, 356, 52);
    const pointer = { x: 30, y: 155 };
    const { collisionRect } = dragged(card, { x: 195, y: 300 }, pointer);

    expect(resolveDrop(PHONE, collisionRect, pointer)).toBe("VAN_1");
    expect(idsOf(dropTarget(argsFor(PHONE, collisionRect, pointer)))[0]).toBe("VAN_1");
    // What it did before, so the reason this case is here is on the record.
    expect(idsOf(closestCenter(argsFor(PHONE, collisionRect, pointer)))[0]).toBe(UNASSIGNED_ID);
  });

  it("at 390, the centre of the one shown column is that column", () => {
    const card = rect(17, 274, 356, 52);
    const pointer = { x: 195, y: 354 };
    const { collisionRect } = dragged(card, { x: 195, y: 300 }, pointer);
    expect(resolveDrop(PHONE, collisionRect, pointer)).toBe("VAN_1");
  });

  /**
   * The two groups at the foot of the Unassigned column are inside it, so a pointer over
   * "Absent" is over both. The smaller box is the one the person is aiming at.
   */
  it("prefers the group under the pointer to the column it sits in", () => {
    const pointer = { x: 336, y: 856 };
    const { collisionRect } = dragged(ZOE_CARD, { x: 336, y: 266 }, pointer);
    expect(resolveDrop(WIDE, collisionRect, pointer)).toBe("ABSENT");
  });

  /**
   * No pointer at all is the keyboard sensor (§1.7 #4): it translates the card by a key press
   * and never produces coordinates, so the card's own rect has to decide. The overlap it has
   * with a column is the answer, and the nearest centre is the backstop — which is what the
   * keyboard walk had before and must keep.
   */
  it("falls back to the card's own rect when there is no pointer", () => {
    // Twelve ArrowRights from the Unassigned column: 25 px a press, so 300 px right — which
    // is two columns over, and the card is more inside Van 2 than inside Van 1.
    const collisionRect = rect(ZOE_CARD.left + 300, ZOE_CARD.top, ZOE_CARD.width, ZOE_CARD.height);
    expect(resolveDrop(WIDE, collisionRect, null)).toBe("VAN_2");
    // And a card nowhere near a column still names the nearest one rather than nothing.
    expect(resolveDrop(WIDE, rect(430, -400, 158, 52), null)).toBe("VAN_1");
  });
});

/* ───────────────────────────── the dnd-kit shim these tests use ───────────────────────────── */

/** The argument object dnd-kit builds for a `CollisionDetection`, from plain rectangles. */
function argsFor(rects: DropRects, collisionRect: ClientRect, pointer: { x: number; y: number } | null) {
  const entries = Object.entries(rects);
  return {
    active: { id: "card" } as never,
    collisionRect,
    droppableRects: new Map(entries.map(([id, box]) => [id, box])),
    droppableContainers: entries.map(([id]) => ({ id })) as never,
    pointerCoordinates: pointer,
  };
}

const idsOf = (collisions: readonly { id: string | number }[]): string[] =>
  collisions.map((collision) => String(collision.id));
