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
  ridersInVan,
  type Bucket,
  type BoardPlan,
  type Placement,
} from "@/domain/plan/board";
import { isOver } from "@/domain/plan/fit";
import { loadBoard, placementsToSave, planStore, type BoardView, type PlanStore } from "./store";

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

export type SetChildPlacementOutcome =
  | { ok: true; version: number; savedAt: string; view: BoardView }
  | { ok: false; status: 404; reason: "NOT_THIS_DAY" }
  | { ok: false; status: 409; reason: "NOT_STARTED" }
  | { ok: false; status: 409; reason: "CHANGED"; changedBy: string | null; version: number }
  | { ok: false; status: 422; reason: string; childToken: string; vanId: string };

export async function setChildPlacement(
  input: SetChildPlacementInput,
  store: PlanStore = planStore(),
): Promise<SetChildPlacementOutcome> {
  const now = input.now ?? new Date();
  const view = await loadBoard(store, input.siteId, input.serviceDate, input.direction);
  if (!view.started) return { ok: false, status: 409, reason: "NOT_STARTED" };

  const known = view.day.riders.some((rider) => rider.token === input.childToken) ||
    view.day.others.some((other) => other.token === input.childToken);
  const vanId = input.bucket === "VAN" ? (input.vehicleId ?? null) : null;
  const vanExists = vanId === null || view.day.vans.some((van) => van.id === vanId);
  // One uniform refusal for a child this day does not have and a van it does not run, so the
  // answer cannot be used to find out which of the two exists somewhere else.
  if (!known || (input.bucket === "VAN" && vanId === null) || !vanExists) {
    return { ok: false, status: 404, reason: "NOT_THIS_DAY" };
  }

  const placement: Placement = { bucket: input.bucket, vanId, pinned: true };
  const next: BoardPlan = { ...view.plan, [input.childToken]: placement };

  // The same check the board made before it let go of the card, re-asked here.
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

  const after = await loadBoard(store, input.siteId, input.serviceDate, input.direction);
  return { ok: true, version: saved.version, savedAt: saved.savedAt, view: after };
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
): Promise<Record<Direction, SetChildPlacementOutcome>> {
  const legs: Direction[] = ["AM", "PM"];
  const answers = {} as Record<Direction, SetChildPlacementOutcome>;
  for (const leg of legs) {
    answers[leg] = await setChildPlacement(
      { ...input, direction: leg, bucket: "ABSENT", expectedVersion: input.expectedVersions[leg] },
      store,
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
