/**
 * Where a saved plan is kept: the demo day's own state, in this server process, and nowhere else.
 *
 * SOURCE: ADR-015 (synthetic data only), ADR-014 / ARCHITECTURE §2 (the demo surfaces), PRD §18.1
 * (the synthetic dataset the demo replays).
 *
 * **No database.** Plan routes is a demo surface built entirely on the fixtures the Today board
 * uses: it reads no table, the scenario it plans is one of two fleets on one synthetic date, and
 * `ops.manifest` / `ops.trip_leg` are the real tables a *locked* manifest will live in once a
 * coordinator can approve one (PRD §6.2, AT-12) — which is a different act from this one. Writing
 * a half-approved plan into them for the sake of a demo would put rows in the operational schema
 * that no screen reads and no migration asked for, so the demo's plan stays in the demo's state:
 * this map, keyed by the run it is a plan of, for the life of this process.
 *
 * What that costs, said out loud rather than discovered: the deployment is serverless, so a
 * plan saved on one instance is not readable from another, and a redeploy forgets every plan.
 * That is the right trade for a plan that notifies nobody and locks nothing — the save's whole
 * job is to prove the check (src/domain/plan/save.ts) runs on the server as well as in the
 * browser. It is also why the screen says "Plan saved at 1:24 PM" about the save it just made
 * and never "last saved at …" about a plan it found here: a plan read back from another instance
 * is a plan this process never kept.
 *
 * No identity in the key, either: the browser-test session is a role with no user id
 * (src/auth/caller.ts) and the demo has one centre, so the plan belongs to the run and not to a
 * person. Who may write one at all is the access table's answer, not this module's.
 */
import type { Assignment } from "@/domain/solver";
import type { DemoScenario, Direction } from "@/domain/plan/day";

export type SavedPlan = {
  scenario: DemoScenario;
  direction: Direction;
  /** The plan as the solver re-checked it, lane by lane (`checkPlan`). */
  assignment: Assignment;
  /** When it was kept, ISO. Answered by the POST, so the screen can say the minute it saved at. */
  savedAt: string;
};

/** One plan per run of one scenario: "EVERY_RIDER_FITS/AM". */
export function savedPlanKey(scenario: DemoScenario, direction: Direction): string {
  return `${scenario}/${direction}`;
}

const SAVED = new Map<string, SavedPlan>();

/** Keep a checked plan, replacing whatever this run's last one was. */
export function putSavedPlan(plan: SavedPlan): SavedPlan {
  SAVED.set(savedPlanKey(plan.scenario, plan.direction), plan);
  return plan;
}

/** The plan last saved for this run, or null when none has been. */
export function getSavedPlan(scenario: DemoScenario, direction: Direction): SavedPlan | null {
  return SAVED.get(savedPlanKey(scenario, direction)) ?? null;
}

/**
 * Forget every saved plan. Called by the demo reset (src/modules/demo/reset.ts), because the day
 * those plans were plans of has just been re-seeded, and by tests that want a fresh process.
 */
export function clearSavedPlans(): void {
  SAVED.clear();
}
