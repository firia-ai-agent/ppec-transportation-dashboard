/**
 * **The** way one child's place on a day changes: `setChildPlacement`.
 *
 * SOURCE: Veri + Firia's gate (b), 2026-10-17 7:27 PM ET — "absence lives in ONE place". Every
 * way a child moves goes through this function: a drag between vans on the board, a drop on
 * Absent or on Family drives, the `Move to…` control on a phone, and marking somebody away for
 * the whole day (which is this function called twice, once for AM and once for PM, because a
 * plan is per date **and** per leg).
 *
 * **#61's agent cancel will call this same function.** When a parent texts "Mia is out today"
 * and a coordinator approves it, the approval sets `bucket: "ABSENT"` here for both legs rather
 * than writing `plan_assignment` itself or touching `ops.attendance_day` — otherwise there are
 * two ways for a child to be away and the board agrees with only one of them. That is the whole
 * reason this is a function and not four call sites.
 *
 * What it guarantees, every time:
 *  - **A new plan version.** `plan_run.version` goes up on every move, so two coordinators
 *    dragging at once get a 409 naming the other rather than one of them silently winning
 *    (founder 7:17 PM ET: "never a silent overwrite").
 *  - **The fit rule still decides.** A drop into a van is re-checked on the server with the same
 *    `src/domain/plan/fit.ts` the browser used, so a move the screen refused cannot be made by
 *    posting round it.
 *  - **Nothing else moves.** One child's bucket changes and the rest of the plan is written back
 *    exactly as it was read.
 *
 * Nothing is read from `ops.attendance_day`: being away is a placement on the day's plan, and
 * tomorrow starts clean because tomorrow is a different plan.
 */
import type { Direction } from "@/domain/day/leg";
import {
  BUCKETS,
  checkPlan,
  namesOnlyThisDay,
  ridersInVan,
  type Bucket,
  type BoardPlan,
  type Placement,
} from "@/domain/plan/board";
import { isOver } from "@/domain/plan/fit";
import { applyPending, childrenMoved, type PendingMove } from "@/domain/plan/pending";
import type { DayDataSource } from "@/domain/day/source";
import { dayDataSource, loadBoard, placementsToSave, planStore, type BoardView, type PlanStore } from "./store";

export { BUCKETS };
export type PlacementBucket = Bucket;

export type SetChildPlacementInput = {
  siteId: string;
  /** "2026-10-17", the service date in centre time. */
  serviceDate: string;
  direction: Direction;
  childToken: string;
  bucket: PlacementBucket;
  /** The van, when the bucket is `VAN`. Ignored otherwise; the row stores null. */
  vehicleId?: string | null;
  /** The version the caller was looking at. `0` means "there was no plan when I started". */
  expectedVersion: number;
  /** The staff user making the move, when the session has one. */
  actor: string | null;
  now?: Date;
};

/** What any plan write can come back with. One set of refusals, for one writer. */
export type PlanWriteOutcome =
  | { ok: true; version: number; savedAt: string; view: BoardView }
  | { ok: false; status: 404; reason: "NOT_THIS_DAY" }
  | { ok: false; status: 409; reason: "NOT_STARTED" }
  | { ok: false; status: 409; reason: "CHANGED"; changedBy: string | null; version: number }
  | { ok: false; status: 422; reason: string; childToken: string; vanId: string }
  | { ok: false; status: 422; reason: "BUCKET_NOT_HERE"; childToken: string };

/** One child's move has the same answers as any other plan write. */
export type SetChildPlacementOutcome = PlanWriteOutcome;

export async function setChildPlacement(
  input: SetChildPlacementInput,
  store: PlanStore = planStore(),
  source: DayDataSource = dayDataSource(input.siteId),
): Promise<SetChildPlacementOutcome> {
  return writePlan(
    {
      siteId: input.siteId,
      serviceDate: input.serviceDate,
      direction: input.direction,
      expectedVersion: input.expectedVersion,
      actor: input.actor,
      now: input.now,
      mayChangeBucketFor: [input.childToken],
      /** One child moves; everybody else is written back exactly as it was read. */
      change: (view) => {
        const known =
          view.day.riders.some((rider) => rider.token === input.childToken) ||
          view.day.others.some((other) => other.token === input.childToken);
        const vanId = input.bucket === "VAN" ? (input.vehicleId ?? null) : null;
        const vanExists = vanId === null || view.day.vans.some((van) => van.id === vanId);
        // One uniform refusal for a child this day does not have and a van it does not run, so
        // the answer cannot be used to find out which of the two exists somewhere else.
        if (!known || (input.bucket === "VAN" && vanId === null) || !vanExists) return null;
        const placement: Placement = { bucket: input.bucket, vanId, pinned: true };
        return { ...view.plan, [input.childToken]: placement };
      },
    },
    store,
    source,
  );
}

export type WritePlanInput = {
  siteId: string;
  serviceDate: string;
  direction: Direction;
  /** The version the caller was looking at. `0` means "there was no plan when I started". */
  expectedVersion: number;
  actor: string | null;
  now?: Date;
  /**
   * The whole plan, after whatever this write is. `null` means the request named something this
   * day does not have, which is a 404 and not a refusal worth describing.
   */
  change: (view: BoardView) => BoardPlan | null;
  /**
   * The children this write may move into or out of Absent / Family drives.
   *
   * A move names the child it is moving; a plan posted as a whole map names nobody, so a stale
   * screen cannot mark somebody away by saving over them (Veri F1).
   */
  mayChangeBucketFor?: readonly string[];
};

/**
 * **The** plan write. Every path that changes who is where goes through this one function, so
 * there is one set of refusals and not two (Veri F1, 2026-10-17 ~8:35 PM ET).
 *
 * Its callers are: `setChildPlacement` (a drag, a drop on Absent or Family drives, `Move to…`),
 * the board's Save after Auto-plan, and the re-plan that follows a child-panel Save. They differ
 * only in the `change` they ask for.
 *
 * The rules, in the order they are checked:
 *  1. the day has not been started, so there is no plan to write — 409 `NOT_STARTED`;
 *  2. the change names a child or a van this day does not have — 404, uniform;
 *  3. **`ABSENT` and `FAMILY_DRIVES` are not a whole-board write.** A plan posted from the board
 *     may not move anybody into or out of those two buckets: that is `setChildPlacement`'s, one
 *     child at a time, so a stale screen cannot mark somebody away by saving over them;
 *  4. **the fit rule decides, always.** There is no `allowOver`: a van may never be saved over
 *     its own counts (Veri, 8:35 PM ET — it was a flag, and a flag is a way round the rule);
 *  5. the version has moved on — 409 `CHANGED`, naming whoever moved it;
 *  6. otherwise it is kept, at version + 1.
 */
export async function writePlan(
  input: WritePlanInput,
  store: PlanStore = planStore(),
  source: DayDataSource = dayDataSource(input.siteId),
): Promise<PlanWriteOutcome> {
  const now = input.now ?? new Date();
  const view = await loadBoard(store, input.siteId, input.serviceDate, input.direction, source);
  if (!view.started) return { ok: false, status: 409, reason: "NOT_STARTED" };

  /*
   * The caller's draft was built on a version somebody has already moved past: that is a 409
   * naming them, decided **before** anything else. Judging their moves against a plan they have
   * never seen would otherwise refuse the draft for the wrong reason — "Van 1 is full" when the
   * honest answer is "Plan changed, reload" (Firia's option A, 2026-10-17 10:29 PM ET). The
   * store compares the version again inside the write, so this is a better message, not the lock.
   */
  if (view.version !== input.expectedVersion) {
    return {
      ok: false,
      status: 409,
      reason: "CHANGED",
      changedBy: view.savedBy,
      version: view.version,
    };
  }

  const next = input.change(view);
  if (next === null) return { ok: false, status: 404, reason: "NOT_THIS_DAY" };
  if (!namesOnlyThisDay(view.day, next)) {
    return { ok: false, status: 404, reason: "NOT_THIS_DAY" };
  }

  const moved = bucketMovedOutsideTheWriter(view.plan, next, input.mayChangeBucketFor);
  if (moved) return { ok: false, status: 422, reason: "BUCKET_NOT_HERE", childToken: moved };

  const checked = checkPlan(view.day, next);
  if (!checked.ok) {
    return {
      ok: false,
      status: 422,
      reason: checked.reason,
      childToken: checked.childToken,
      vanId: checked.vanId,
    };
  }

  const saved = await store.savePlan(input.siteId, {
    date: input.serviceDate,
    direction: input.direction,
    version: input.expectedVersion,
    placements: placementsToSave(view.day, next),
    savedBy: input.actor,
    now,
  });
  if (!saved.ok) {
    return {
      ok: false,
      status: 409,
      reason: "CHANGED",
      changedBy: saved.changedBy,
      version: saved.version,
    };
  }

  const after = await loadBoard(store, input.siteId, input.serviceDate, input.direction, source);
  return { ok: true, version: saved.version, savedAt: saved.savedAt, view: after };
}

/**
 * The first child whose Absent / Family-drives membership this write would change, or null.
 *
 * `setChildPlacement` sets its own child's bucket before this runs, so a single-child move is
 * allowed through; a *board* save that happens to carry a different answer for somebody who is
 * away is not. That is the difference between "I moved Mia" and "my screen was stale".
 */
function bucketMovedOutsideTheWriter(
  before: BoardPlan,
  after: BoardPlan,
  allowed: readonly string[] | undefined,
): string | null {
  const away = (bucket: Bucket | undefined) => bucket === "ABSENT" || bucket === "FAMILY_DRIVES";
  const named = new Set(allowed ?? []);
  for (const [token, placement] of Object.entries(after)) {
    if (named.has(token)) continue;
    const was = before[token]?.bucket;
    if (was === placement.bucket) continue;
    if (away(was) || away(placement.bucket)) return token;
  }
  return null;
}

/**
 * **Save: every pending move, in one transaction** (Firia's option A, 2026-10-17 10:29 PM ET).
 *
 * The board drags into a queue and writes nothing; Save sends the queue. Each move is applied
 * through the same checks one drag would get — the child and the van have to be the day's, the
 * fit rule has to agree, and a van can never end up over its counts — and the whole lot is then
 * written as **one** new `plan_run` version. One bad move and nothing is written at all, which
 * is what makes a draft safe to build up: a coordinator never gets half of what they asked for.
 *
 * A stale version is a 409 naming whoever moved it; the screen keeps the queue and says
 * "Plan changed, reload" (copy.ts), so no work is lost to somebody else's save.
 */
export async function applyPendingMoves(
  input: {
    siteId: string;
    serviceDate: string;
    direction: Direction;
    moves: readonly PendingMove[];
    expectedVersion: number;
    actor: string | null;
    now?: Date;
  },
  store: PlanStore = planStore(),
  source: DayDataSource = dayDataSource(input.siteId),
): Promise<PlanWriteOutcome> {
  return writePlan(
    {
      siteId: input.siteId,
      serviceDate: input.serviceDate,
      direction: input.direction,
      expectedVersion: input.expectedVersion,
      actor: input.actor,
      now: input.now,
      mayChangeBucketFor: childrenMoved(input.moves),
      change: (view) => {
        // Every move has to name this day's child, and a van move this day's van. One unknown
        // id refuses the whole save, which is the same uniform 404 a single drag gets.
        for (const move of input.moves) {
          const known =
            view.day.riders.some((rider) => rider.token === move.childToken) ||
            view.day.others.some((other) => other.token === move.childToken);
          if (!known) return null;
          if (move.bucket === "VAN") {
            if (!move.vanId || !view.day.vans.some((van) => van.id === move.vanId)) return null;
          }
        }
        return applyPending(view.plan, input.moves);
      },
    },
    store,
    source,
  );
}

/**
 * Away for the whole day: the same move on both legs (founder 7:17 PM ET — "all-day absent =
 * ABSENT in both the AM and PM plans").
 *
 * Two plans, two versions, and the second is attempted even if the first came back with a
 * conflict: a morning somebody else re-planned is not a reason to leave the afternoon wrong. The
 * caller gets both answers and the screen says which half needs a reload.
 */
export async function setChildAwayAllDay(
  input: Omit<SetChildPlacementInput, "direction" | "bucket" | "expectedVersion"> & {
    /** The version the caller holds for each leg, by leg. `0` where they hold none. */
    expectedVersions: Readonly<Record<Direction, number>>;
  },
  store: PlanStore = planStore(),
  source: DayDataSource = dayDataSource(input.siteId),
): Promise<Record<Direction, SetChildPlacementOutcome>> {
  const legs: Direction[] = ["AM", "PM"];
  const answers = {} as Record<Direction, SetChildPlacementOutcome>;
  for (const leg of legs) {
    answers[leg] = await setChildPlacement(
      { ...input, direction: leg, bucket: "ABSENT", expectedVersion: input.expectedVersions[leg] },
      store,
      source,
    );
  }
  return answers;
}

/** Which vans are over their own counts on this plan, for a screen that shows it as a chip. */
export function vansOver(view: BoardView, plan: BoardPlan): string[] {
  return view.day.vans
    .filter((van) => isOver(van.setup, ridersInVan(view.day, plan, van.id)))
    .map((van) => van.id);
}
