import {
  closestCenter,
  pointerWithin,
  rectIntersection,
  type ClientRect,
  type CollisionDetection,
} from "@dnd-kit/core";

/**
 * WHICH COLUMN A DROP LANDS ON.
 *
 * The board used `closestCenter`, which compares the **dragged card's translated rect centre**
 * with each column's centre and never looks at the pointer. Every column here is the same height
 * (`.columns` is a stretch flex row, `.column` is `max-height: 100%`), so the vertical term is
 * the same for all of them and the whole decision is horizontal: the midpoint between the
 * Unassigned column's centre and Van 1's centre falls on Van 1's left edge. A card grabbed right
 * of its own middle and let go over the left half of Van 1 therefore resolved to **the column it
 * came from** — the S1 bug, where Zoe B. bounced back to Unassigned with no refusal anywhere,
 * because landing on Unassigned is the success path and not a refusal at all. At 390 it was
 * worse: the columns a phone hides measure as a zero rect at the origin, and the origin can be
 * nearer the top of the one visible column than that column's own centre.
 *
 * So the rule is the pointer, in three rungs:
 *
 *  1. **The droppable under the pointer** (`pointerWithin`). A drop whose pointer is over Van 1
 *     is Van 1, wherever the card's own box ended up. Where boxes nest — the Absent and Family
 *     drives groups sit *inside* the Unassigned column — dnd-kit ranks by distance to the
 *     corners, so the small box the person is aiming at wins over the column holding it.
 *  2. **The greatest overlap** (`rectIntersection`), for the keyboard sensor, which translates
 *     the card by a key press and produces no pointer at all (§1.7 #4).
 *  3. **The nearest centre** (`closestCenter`), so a card held clear of every column still names
 *     one rather than nothing — which is the behaviour the keyboard walk already had.
 *
 * Exported as a function rather than written into the `DndContext` so it can be measured:
 * src/app/plan-routes/board/collision.test.ts runs real 1440 and 390 rectangles through it.
 */

/** Every droppable on the board and the box the browser laid it out in, by droppable id. */
export type DropRects = Readonly<Record<string, ClientRect>>;

/** The `collisionDetection` the board hands dnd-kit (§1.3's drag). */
export const dropTarget: CollisionDetection = (args) => {
  const underPointer = pointerWithin(args);
  if (underPointer.length > 0) return underPointer;
  const overlapping = rectIntersection(args);
  if (overlapping.length > 0) return overlapping;
  return closestCenter(args);
};

/**
 * The same decision over plain rectangles: the droppable a drop lands on, or `null` when there
 * is nothing on the board to land on.
 *
 * This is what the test drives, and it is the real function — `dropTarget` above is this one
 * wearing dnd-kit's argument shape.
 */
export function resolveDrop(
  rects: DropRects,
  collisionRect: ClientRect,
  pointer: { x: number; y: number } | null,
): string | null {
  const entries = Object.entries(rects);
  const found = dropTarget({
    active: { id: "card" } as never,
    collisionRect,
    droppableRects: new Map(entries),
    droppableContainers: entries.map(([id]) => ({ id })) as never,
    pointerCoordinates: pointer,
  });
  return found[0] ? String(found[0].id) : null;
}
