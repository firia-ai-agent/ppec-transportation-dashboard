/**
 * What the board's four endpoints actually do, with the HTTP left in the routes.
 *
 * The routes are the guard and the shape of the answer; this is the decision. Keeping it here
 * means the decisions are unit-testable without a request (src/modules/plan/api.test.ts) and that
 * the two writes — a plan and a van's setup — run the same checks whoever asks for them.
 *
 * The one rule that matters most: **the plan is re-checked on the server**. The board asks the fit
 * rule before every drop, and a request did not come from the board, so the posted plan is
 * replayed van by van through the same `src/domain/plan/fit.ts` the browser used (#58 established
 * this for `tryMove`; §1.4 asks for it in as many words). A move the screen refused cannot be
 * saved by posting round it.
 */
import { z } from "zod";
import { COUNTER_MAX } from "@/config/vans";
import { BUCKETS, checkPlan, namesOnlyThisDay, ridersInVan, type BoardPlan, type Placement } from "@/domain/plan/board";
import { isOver } from "@/domain/plan/fit";
import { SETUP_STATES, type SetupState } from "@/domain/plan/setup";
import type { DayReadiness } from "@/domain/day/readiness";
import type { Direction } from "@/domain/solver";
import type { StaffCaller } from "@/auth/api-guard";
import { DEMO_SITE_ID } from "@/modules/demo/fixtures/standard";
import { loadBoard, placementsToSave, planStore, type BoardView, type PlanStore } from "./store";

/* ───────────────────────────── which site ───────────────────────────── */

/**
 * The site this caller's board belongs to: their own membership, or the demo site when the
 * session has no membership at all.
 *
 * The demo is one centre (PRD §18.1), and the board is not a multi-site surface yet: a caller who
 * is a member of several sites gets the first, which is the same resolution the demo reset uses
 * when a request does not name one. The membership-less case is the browser check's synthetic
 * session (src/auth/caller.ts), which has a role and no identity.
 */
export function siteOf(caller: { memberships?: readonly { siteId: string }[] }): string {
  return caller.memberships?.[0]?.siteId ?? DEMO_SITE_ID;
}

/* ───────────────────────────── reading the board ───────────────────────────── */

export type BoardBody = BoardView;

/** The board for one date and leg, as every reader of it gets it. */
export async function boardResponse(
  siteId: string,
  date: string,
  direction: Direction,
  store: PlanStore = planStore(),
): Promise<BoardBody> {
  return loadBoard(store, siteId, date, direction);
}

/** The three steps of the day (§9.4). */
export async function readinessResponse(
  siteId: string,
  date: string,
  leg: Direction,
  store: PlanStore = planStore(),
): Promise<DayReadiness> {
  return (await loadBoard(store, siteId, date, leg)).readiness;
}

/* ───────────────────────────── saving the board ───────────────────────────── */

const placement = z.strictObject({
  bucket: z.enum(BUCKETS),
  vanId: z.string().min(1).max(64).nullable(),
  pinned: z.boolean(),
});

export const savePlanBody = z.strictObject({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  direction: z.enum(["AM", "PM"]),
  /** The version the board was showing; 0 when it started from no saved plan. */
  version: z.number().int().min(0).max(1_000_000),
  placements: z.record(z.string().min(1).max(64), placement),
  /**
   * The coordinator answered "Save anyway?" about a van that is over its own counts (§1.3).
   *
   * Over-capacity is the one state the spec saves *with* a confirm rather than refusing: it
   * happens when a setup is lowered under the riders already in a van, and the thing that stops
   * anybody boarding is the ramp check, not this endpoint. So the override is explicit and comes
   * from a person answering a question — a body without it is held to the fit rule exactly.
   */
  allowOver: z.boolean().optional(),
});

export type SavePlanAnswer =
  | { status: 200; body: { ok: true; version: number; savedAt: string; over: string[] } }
  | { status: 404 | 409 | 422 | 503; body: { ok: false; error?: string; reason?: string; changedBy?: string | null; childToken?: string; vanId?: string } };

/**
 * One save (§1.6's `POST /api/plan/save`).
 *
 * The order is the order the answers differ in:
 *  1. the day has not been started, so there is nothing to save a plan of — 409 `NOT_STARTED`
 *     (§9.4's own wording for this guard);
 *  2. the plan names a child or a van this day does not have — 404, one uniform refusal, so the
 *     answer cannot be used to find out which of them exists somewhere else;
 *  3. the fit rule refuses a van — 422, naming the child and the van, which are both already on
 *     the caller's screen;
 *  4. somebody else saved first — 409 with their name, so the board reloads rather than writing
 *     over them;
 *  5. otherwise it is kept, and the answer carries the new version, the instant the server wrote
 *     it, and any van that is over (which the screen shows as a chip rather than as an error).
 */
export async function savePlanRequest(
  siteId: string,
  caller: Pick<StaffCaller, "userId">,
  input: z.infer<typeof savePlanBody>,
  now: Date = new Date(),
  store: PlanStore = planStore(),
): Promise<SavePlanAnswer> {
  const view = await loadBoard(store, siteId, input.date, input.direction);
  if (!view.started) {
    return { status: 409, body: { ok: false, reason: "NOT_STARTED" } };
  }

  const plan = input.placements as BoardPlan;
  if (!namesOnlyThisDay(view.day, plan)) {
    return { status: 404, body: { ok: false, reason: "NOT_THIS_DAY" } };
  }

  const over = view.day.vans
    .filter((van) => isOver(van.setup, ridersInVan(view.day, plan, van.id)))
    .map((van) => van.id);

  if (!(input.allowOver && over.length > 0)) {
    const checked = checkPlan(view.day, plan);
    if (!checked.ok) {
      return {
        status: 422,
        body: { ok: false, reason: checked.reason, childToken: checked.childToken, vanId: checked.vanId },
      };
    }
  }

  const saved = await store.savePlan(siteId, {
    date: input.date,
    direction: input.direction,
    version: input.version,
    placements: placementsToSave(view.day, plan),
    savedBy: caller.userId ?? null,
    now,
  });
  if (!saved.ok) {
    return { status: 409, body: { ok: false, reason: "CHANGED", changedBy: saved.changedBy } };
  }
  return { status: 200, body: { ok: true, version: saved.version, savedAt: saved.savedAt, over } };
}

/* ───────────────────────────── one van's setup ───────────────────────────── */

export const vanSetupBody = z.strictObject({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  seats: z.number().int().min(0).max(COUNTER_MAX),
  wheelchairSpots: z.number().int().min(0).max(COUNTER_MAX),
  carSeats: z.number().int().min(0).max(COUNTER_MAX),
  oxygenMounts: z.number().int().min(0).max(COUNTER_MAX),
  hasLift: z.boolean(),
  state: z.enum(SETUP_STATES),
});

export type VanSetupAnswer =
  | { status: 200; body: { ok: true; readiness: DayReadiness } }
  | { status: 403 | 404; body: { ok: false; reason: string } };

/**
 * One van's setup for one day (§1.6's `PUT /api/vans/:id/setup`, a POST here).
 *
 * Two checks beyond the role the access table already took:
 *  - the van has to be one this board runs, answered as a uniform 404 like every other id this
 *    app does not have;
 *  - **the front desk may only write `CHECKED`.** Counting what arrived is their job (§2) and
 *    planning a van is not — a `PLANNED` write from the ramp would be the front desk changing a
 *    coordinator's plan for a van nobody has looked at yet. `DEFAULT` is nobody's to write: it is
 *    what the ladder *returns* for a day with no row (src/domain/plan/setup.ts), not a state a
 *    person sets.
 */
export async function putVanSetupRequest(
  siteId: string,
  caller: Pick<StaffCaller, "userId" | "role">,
  vanId: string,
  input: z.infer<typeof vanSetupBody>,
  now: Date = new Date(),
  store: PlanStore = planStore(),
): Promise<VanSetupAnswer> {
  if (input.state === "DEFAULT") return { status: 403, body: { ok: false, reason: "NOT_A_STATE" } };
  if (caller.role === "FRONT_DESK" && input.state !== "CHECKED") {
    return { status: 403, body: { ok: false, reason: "NOT_YOUR_WRITE" } };
  }

  const view = await loadBoard(store, siteId, input.date, "PM");
  if (!view.day.vans.some((van) => van.id === vanId)) {
    return { status: 404, body: { ok: false, reason: "NO_SUCH_VAN" } };
  }

  await store.putSetup(siteId, {
    vehicleId: vanId,
    date: input.date,
    setup: {
      seats: input.seats,
      wheelchairSpots: input.wheelchairSpots,
      carSeats: input.carSeats,
      oxygenMounts: input.oxygenMounts,
      hasLift: input.hasLift,
    },
    state: input.state as Exclude<SetupState, "DEFAULT">,
    setBy: caller.userId ?? null,
    now,
  });

  // The answer carries the day's steps back, so the screen that just confirmed a van can say
  // "1/3 checked" without asking a second endpoint for it (§9.4).
  const after = await loadBoard(store, siteId, input.date, view.day.direction);
  return { status: 200, body: { ok: true, readiness: after.readiness } };
}

/** Every placement a caller may post, for the one type the board and the endpoint share. */
export type PostedPlacement = Placement;
