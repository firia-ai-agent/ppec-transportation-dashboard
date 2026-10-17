/**
 * Saving a plan: the check a plan has to pass before anything keeps it.
 *
 * The screen asks the solver about every move as it is made (`tryMove`), so what is on screen is
 * always a plan the four constraints agreed with. A save arrives as a *request*, and a request
 * did not come from the screen — it came from whatever sent it. So the plan is re-asked here,
 * child by child, through the same `tryMove` the drag goes through: the assignment is replayed
 * from an empty day into the lanes it names, and the first child a lane refuses refuses the
 * whole save. Nothing is kept half-applied, because nothing is applied until the replay is done.
 *
 * Which is also the answer to the pinned children (Vera's review, 2026-10-17): planning keeps a
 * coordinator's own placements, so a saved plan contains moves a *person* made as well as moves
 * the search made — and both are in the assignment, so both are replayed. There is no "already
 * checked" path through this function for either of them.
 *
 * Two refusals, because they are two different facts:
 *  - `NOT_THIS_RUN` — the plan names a child or a van that is not on this run at all. One answer
 *    for a child at another site, a van on no lane today, and an id that matches nothing, so the
 *    response cannot be used to find out which of the three it was (the ID-swap rule: a uniform
 *    refusal that confirms nothing).
 *  - `REFUSED` — every id is this run's own, and the solver says this van cannot take this child.
 *    That one names them, because both are already on the caller's screen.
 *
 * Pure: no clock, no database, no network. What *keeps* a checked plan is
 * src/modules/demo/plan-store.ts.
 */
import { refusalLine } from "./reasons";
import { tryMove, type Assignment, type PlanInput, type UnplacedCause } from "@/domain/solver";
import { planRoutes } from "@/ui/copy";

export type SaveRefusal =
  | { reason: "NOT_THIS_RUN" }
  | { reason: "REFUSED"; laneId: string; childToken: string; cause: UnplacedCause };

export type SaveCheck = { ok: true; assignment: Assignment } | ({ ok: false } & SaveRefusal);

/**
 * Is every lane and every child in this plan one this run has, and is each child in one van?
 *
 * A child in two vans is not a solver question — no constraint is broken by the second van, the
 * two lanes just disagree about where the child is — so it is refused here, as the same uniform
 * "not this run" answer: a plan that says a child is in two places is not a plan of this day.
 */
function namesOnlyThisRun(input: PlanInput, assignment: Assignment): boolean {
  const laneIds = new Set(input.lanes.map((lane) => lane.id));
  const tokens = new Set(input.riders.map((rider) => rider.child.token));
  const seen = new Set<string>();
  for (const [laneId, inLane] of Object.entries(assignment)) {
    if (!laneIds.has(laneId)) return false;
    for (const token of inLane) {
      if (!tokens.has(token)) return false;
      if (seen.has(token)) return false;
      seen.add(token);
    }
  }
  return true;
}

/**
 * The plan, re-asked of the solver one child at a time.
 *
 * The replay order is the plan's own: lane by lane, and inside a lane the order the assignment
 * lists. It matters that it is a replay and not a per-child spot check — the constraints are
 * checked per stop over everyone aboard, so "this van can take this child" is only true of the
 * children already in it, and the only honest way to ask about a whole van is to fill it.
 */
export function checkPlan(input: PlanInput, assignment: Assignment): SaveCheck {
  if (!namesOnlyThisRun(input, assignment)) return { ok: false, reason: "NOT_THIS_RUN" };

  let building: Assignment = Object.fromEntries(input.lanes.map((lane) => [lane.id, []]));
  for (const lane of input.lanes) {
    for (const childToken of assignment[lane.id] ?? []) {
      const result = tryMove(input, building, childToken, lane.id);
      if (!result.ok) {
        return { ok: false, reason: "REFUSED", laneId: lane.id, childToken, cause: result.cause };
      }
      building = result.assignment;
    }
  }
  return { ok: true, assignment: building };
}

/**
 * The refusal in the words a coordinator reads — the same sentence a refused drag puts on the
 * screen, because it is the same verdict about the same van (src/domain/plan/reasons.ts).
 *
 * A refusal naming ids this run does not have says so and names nothing, so no caller can learn
 * from the answer whether a child or a van it guessed at exists somewhere else.
 */
export function saveRefusalLine(input: PlanInput, refusal: SaveRefusal): string {
  if (refusal.reason === "NOT_THIS_RUN") return planRoutes.saveNotThisRun;
  const lane = input.lanes.find((l) => l.id === refusal.laneId);
  const rider = input.riders.find((r) => r.child.token === refusal.childToken);
  if (!lane || !rider) return planRoutes.saveNotThisRun;
  return refusalLine(lane.vehicle, rider.child, refusal.cause);
}

/** How many children a checked plan has in a van, which is what the saved answer reports. */
export function placedCount(assignment: Assignment): number {
  return Object.values(assignment).reduce((n, inLane) => n + inLane.length, 0);
}
