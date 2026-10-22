import { describe, expect, it } from "vitest";
import {
  applyPending,
  childrenMoved,
  clearPending,
  enqueue,
  hasPending,
  movesToSave,
  undoLast,
  NO_PENDING,
  type PendingQueue,
} from "./pending";
import type { BoardPlan } from "./board";

/**
 * The unsaved half of the board (Firia's option A, 2026-10-17 10:29 PM ET).
 *
 * Everything here is about one promise: a drag changes what you see and **writes nothing**, so
 * the queue has to be able to say what the board looks like, what the server should be asked
 * for, and what "take that back" means — without a request in sight.
 */

const SAVED: BoardPlan = {
  "child-1": { bucket: "UNASSIGNED", vanId: null, pinned: false },
  "child-2": { bucket: "VAN", vanId: "van-1", pinned: false },
  "child-3": { bucket: "FAMILY_DRIVES", vanId: null, pinned: false },
};

const toVan = (childToken: string, vanId: string) => ({ childToken, bucket: "VAN" as const, vanId });

describe("a queue of unsaved moves", () => {
  it("starts empty, and says so", () => {
    expect(NO_PENDING).toEqual([]);
    expect(hasPending(NO_PENDING)).toBe(false);
    expect(applyPending(SAVED, NO_PENDING)).toEqual(SAVED);
  });

  it("keeps every move in the order they were made", () => {
    const queue = enqueue(enqueue(NO_PENDING, toVan("child-1", "van-1")), toVan("child-1", "van-2"));
    expect(queue).toHaveLength(2);
    expect(hasPending(queue)).toBe(true);
    // Applying is last-wins, which is what the board shows.
    expect(applyPending(SAVED, queue)["child-1"]).toEqual({ bucket: "VAN", vanId: "van-2", pinned: true });
  });

  it("drops the van on a move that is not into a van", () => {
    const queue = enqueue(NO_PENDING, { childToken: "child-2", bucket: "ABSENT", vanId: "van-1" });
    expect(queue[0].vanId).toBeNull();
    expect(applyPending(SAVED, queue)["child-2"]).toEqual({ bucket: "ABSENT", vanId: null, pinned: true });
  });

  it("marks a moved child pinned, so a re-plan leaves them where a person put them", () => {
    const queue = enqueue(NO_PENDING, toVan("child-1", "van-2"));
    expect(applyPending(SAVED, queue)["child-1"].pinned).toBe(true);
  });

  it("ignores a move for a child the day does not have", () => {
    const queue = enqueue(NO_PENDING, toVan("nobody", "van-1"));
    expect(applyPending(SAVED, queue)).toEqual(SAVED);
  });

  describe("undo", () => {
    it("takes back the most recent move and nothing else", () => {
      const queue = enqueue(enqueue(NO_PENDING, toVan("child-1", "van-1")), toVan("child-2", "van-2"));
      const after = undoLast(queue);
      expect(after).toHaveLength(1);
      expect(applyPending(SAVED, after)["child-1"]).toMatchObject({ vanId: "van-1" });
      // …and the child whose move was undone is back where the **saved** plan has them.
      expect(applyPending(SAVED, after)["child-2"]).toEqual(SAVED["child-2"]);
    });

    it("never touches the saved plan, however many times it is pressed", () => {
      let queue: PendingQueue = enqueue(NO_PENDING, toVan("child-1", "van-1"));
      queue = undoLast(queue);
      queue = undoLast(queue);
      expect(queue).toEqual([]);
      expect(applyPending(SAVED, queue)).toEqual(SAVED);
    });
  });

  it("clears to nothing after a save", () => {
    expect(clearPending()).toEqual([]);
  });

  describe("what Save sends", () => {
    it("is one move per child whose place actually changed", () => {
      const queue = enqueue(
        enqueue(enqueue(NO_PENDING, toVan("child-1", "van-1")), toVan("child-1", "van-2")),
        { childToken: "child-3", bucket: "ABSENT", vanId: null },
      );
      const moves = movesToSave(SAVED, queue);
      expect(moves).toEqual([
        { childToken: "child-1", bucket: "VAN", vanId: "van-2" },
        { childToken: "child-3", bucket: "ABSENT", vanId: null },
      ]);
    });

    it("sends nothing for a move that puts a child back where they already were", () => {
      const queue = enqueue(enqueue(NO_PENDING, toVan("child-2", "van-2")), toVan("child-2", "van-1"));
      expect(movesToSave(SAVED, queue)).toEqual([]);
    });

    it("names every child the queue touches, for the server's own bucket rule", () => {
      const queue = enqueue(enqueue(NO_PENDING, toVan("child-1", "van-1")), toVan("child-1", "van-2"));
      expect(childrenMoved(queue)).toEqual(["child-1"]);
    });
  });
});

/**
 * §1.4's pin belongs to a person's move. Auto-plan's answer is saved unpinned, so the next
 * Auto-plan — the ramp's Re-plan around a van that arrived short — may move it again.
 */
describe("who pins a child: a person, not Auto-plan", () => {
  it("pins a person's move and leaves Auto-plan's unpinned", () => {
    const planned = { ...toVan("child-1", "van-1"), planned: true };
    const plan = applyPending(SAVED, enqueue(enqueue(NO_PENDING, planned), toVan("child-3", "van-2")));
    expect(plan["child-1"]).toEqual({ bucket: "VAN", vanId: "van-1", pinned: false });
    expect(plan["child-3"]).toEqual({ bucket: "VAN", vanId: "van-2", pinned: true });
  });

  it("sends the server which moves were Auto-plan's, and a later drag of the same child wins", () => {
    const planned = { ...toVan("child-1", "van-1"), planned: true };
    expect(movesToSave(SAVED, enqueue(NO_PENDING, planned))).toEqual([{ ...toVan("child-1", "van-1"), planned: true }]);
    const dragged = enqueue(enqueue(NO_PENDING, planned), toVan("child-1", "van-2"));
    expect(movesToSave(SAVED, dragged)).toEqual([toVan("child-1", "van-2")]);
  });
});

describe("where a route put a stop travels with the van it was put in (ledger #90)", () => {
  const PLACED: BoardPlan = { ...SAVED, "child-2": { bucket: "VAN", vanId: "van-1", pinned: false, dropAfter: "child-9" } };

  it("stays while the child stays in that van, and is gone once they move to another", () => {
    expect(applyPending(PLACED, [toVan("child-2", "van-1")])["child-2"].dropAfter).toBe("child-9");
    expect(applyPending(PLACED, [toVan("child-2", "van-2")])["child-2"].dropAfter).toBeUndefined();
    expect(applyPending(PLACED, [{ childToken: "child-2", bucket: "UNASSIGNED", vanId: null }])["child-2"].dropAfter).toBeUndefined();
  });

  it("Save carries a stop put back in window order, and one a route placed", () => {
    expect(movesToSave(PLACED, [toVan("child-2", "van-2")])).toContainEqual(expect.objectContaining({ childToken: "child-2", dropAfter: null }));
    expect(movesToSave(SAVED, [{ ...toVan("child-2", "van-1"), dropAfter: "first" }])).toContainEqual(
      expect.objectContaining({ childToken: "child-2", dropAfter: "first" }),
    );
    // Nothing changed: nothing to send.
    expect(movesToSave(PLACED, [toVan("child-2", "van-1")]).filter((m) => m.childToken === "child-2")).toEqual([]);
  });
});
