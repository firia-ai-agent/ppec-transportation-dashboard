/**
 * The moves a coordinator has made and not saved yet.
 *
 * SOURCE: Firia's option A (2026-10-17 10:29 PM ET). A drag changes the board in front of you
 * and **writes nothing**: it goes on this queue, the toolbar says "Not saved", and Save sends
 * the whole queue in one transaction. Undo takes the last one back. Nothing here touches the
 * saved plan, which is the point — an unsaved board is a draft, and a draft that writes rows as
 * you drag is not a draft.
 *
 * The queue is a **list, not a map**, because Undo is "take back the last thing I did" and that
 * needs the order. Two moves of the same child both stay on it; applying the queue is last-wins,
 * so the board shows the most recent and Undo peels them off one at a time.
 *
 * Pure: no clock, no database, no React. The server applies the same moves through the one
 * placement writer (src/modules/plan/place.ts), so what a drag previews and what a Save keeps
 * are the same arithmetic.
 */
import type { Bucket, BoardPlan, Placement } from "./board";

/** One unsaved move: where a child goes, and which van when the bucket is `VAN`. */
export type PendingMove = {
  childToken: string;
  bucket: Bucket;
  /** The van, when the bucket is `VAN`. Null otherwise, which the row also stores. */
  vanId: string | null;
  /**
   * True when Auto-plan proposed this move rather than a person making it.
   *
   * §1.4's pin is "a person put them there, so planning again leaves them where they are". A
   * child Auto-plan placed was put there by nobody, so saving that placement must not pin it: a
   * later Auto-plan — the ramp's Re-plan around a van that arrived short — has to be free to move
   * them, or the first Save would freeze the whole day and every re-plan would change nothing.
   */
  planned?: boolean;
  /** A time agreed with the family (`Placement.notBefore`); null clears one, absent keeps it. */
  notBefore?: string | null;
  /**
   * Where the route puts their stop in the van's run (`Placement.dropAfter`, ledger #90); null
   * clears it. Absent keeps it while they stay in the same van — a stop's place is a place in
   * *that* van's run, so a move to another van without one leaves the window order.
   */
  dropAfter?: string | null;
};

export type PendingQueue = readonly PendingMove[];

export const NO_PENDING: PendingQueue = [];

/** The queue with one more move on the end. */
export function enqueue(queue: PendingQueue, move: PendingMove): PendingQueue {
  return [...queue, normalise(move)];
}

/** The queue without its most recent move — Undo, and nothing else (it never touches a save). */
export function undoLast(queue: PendingQueue): PendingQueue {
  return queue.slice(0, -1);
}

/** Everything taken back: what a successful Save, or a reload, leaves behind. */
export function clearPending(): PendingQueue {
  return NO_PENDING;
}

/** Is there anything to save? The one thing the toolbar's "Not saved" reads. */
export function hasPending(queue: PendingQueue): boolean {
  return queue.length > 0;
}

/**
 * The plan as the screen shows it: the saved plan with every pending move folded on, in order.
 *
 * A move for a child the day does not have is ignored rather than invented — the queue is
 * built from cards on screen, and a board that re-rendered without them has nothing to apply.
 */
export function applyPending(plan: BoardPlan, queue: PendingQueue): BoardPlan {
  let next: BoardPlan = plan;
  for (const move of queue) {
    if (!(move.childToken in next)) continue;
    // An agreed time travels with the child, whichever van they end up in.
    const notBefore = move.notBefore !== undefined ? move.notBefore : next[move.childToken]?.notBefore;
    const sameVan = move.bucket === "VAN" && next[move.childToken]?.vanId === move.vanId;
    const dropAfter = move.dropAfter !== undefined ? move.dropAfter : sameVan ? next[move.childToken]?.dropAfter : undefined;
    const placement: Placement = {
      bucket: move.bucket,
      vanId: move.bucket === "VAN" ? move.vanId : null,
      // A person's move is kept where they put it by a re-plan (§1.4); Auto-plan's is not.
      pinned: move.planned !== true,
      ...(notBefore ? { notBefore } : {}),
      ...(dropAfter && move.bucket === "VAN" ? { dropAfter } : {}),
    };
    next = { ...next, [move.childToken]: placement };
  }
  return next;
}

/**
 * The queue with the moves that no longer change anything dropped.
 *
 * Sent to the server at Save: a move that puts a child where the saved plan already has them is
 * not a change, and the fewer moves a transaction carries the less there is to refuse.
 */
export function movesToSave(plan: BoardPlan, queue: PendingQueue): PendingMove[] {
  const after = applyPending(plan, queue);
  const moves: PendingMove[] = [];
  for (const [token, placement] of Object.entries(after)) {
    const before = plan[token];
    if (
      before && before.bucket === placement.bucket && before.vanId === placement.vanId &&
      (before.notBefore ?? null) === (placement.notBefore ?? null) && (before.dropAfter ?? null) === (placement.dropAfter ?? null)
    ) continue;
    moves.push({
      childToken: token,
      bucket: placement.bucket,
      vanId: placement.vanId,
      ...(placement.pinned ? {} : { planned: true }),
      ...(placement.notBefore ? { notBefore: placement.notBefore } : {}),
      // Said either way: a stop put back in window order is a change the save has to carry.
      ...(placement.dropAfter ? { dropAfter: placement.dropAfter } : before?.dropAfter ? { dropAfter: null } : {}),
    });
  }
  return moves;
}

/** Every child the queue touches, for the announcement and for the server's own bucket rule. */
export function childrenMoved(queue: PendingQueue): string[] {
  return [...new Set(queue.map((move) => move.childToken))];
}

function normalise(move: PendingMove): PendingMove {
  return {
    childToken: move.childToken,
    bucket: move.bucket,
    vanId: move.bucket === "VAN" ? move.vanId : null,
    ...(move.planned === true ? { planned: true } : {}),
    ...(move.notBefore !== undefined ? { notBefore: move.notBefore } : {}),
    ...(move.dropAfter !== undefined ? { dropAfter: move.dropAfter } : {}),
  };
}
