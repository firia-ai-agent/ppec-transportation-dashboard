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
 * **Read back, within this server's memory, for this session.** The screen asks for the run's
 * saved plan when it opens one, so a coordinator who reloads the page gets their children back
 * in their vans instead of an empty screen (Veri's S1, 2026-10-17) — which is why this map keeps
 * everything the screen needs to rebuild the plan and not just the assignment: the lanes as the
 * request described them, the chairs the ramp had measured, and the minute it was kept.
 *
 * What that still costs, said out loud rather than discovered: the deployment is serverless, so
 * a reload that lands on another instance finds nothing here, and a redeploy forgets every plan.
 * This is memory for a session and not a record, and the database save on the board work is what
 * replaces it. Until then the screen says what is true of what it found — "Showing the plan saved
 * at 1:24 PM" — and nothing about where it was kept.
 *
 * No identity in the key, either: the browser-test session is a role with no user id
 * (src/auth/caller.ts) and the demo has one centre, so the plan belongs to the run and not to a
 * person. Who may write one at all is the access table's answer, not this module's.
 */
import type { Assignment } from "@/domain/solver";
import type { DemoScenario, Direction } from "@/domain/plan/day";
import type { AskedLane } from "@/domain/plan/stages";

/**
 * A plan, as everything needed to put it back on the screen that made it.
 *
 * The assignment on its own is not the plan: who fits in which van depends on what each lane's
 * van was reported as and whose chair the ramp had measured, so a screen handed only the
 * assignment would be drawing a plan the solver no longer agrees with. These are the same four
 * facts the POST took and checked against the day (`readPlanDay`), kept as they were checked.
 *
 * Lanes as `AskedLane` and not `LaneStage`: no person travels either way. Who is driving is the
 * day's own record on both sides of the wire (src/domain/plan/stages.ts), so the name is never
 * in a request body and never in this answer.
 */
export type SavedPlan = {
  scenario: DemoScenario;
  direction: Direction;
  /** The lanes as the request described them and the day accepted them — ids only, no driver. */
  stages: Readonly<Record<string, AskedLane>>;
  /** Child tokens whose chair the ramp had measured when the plan was kept (AT-04). */
  measured: readonly string[];
  /** The plan as the solver re-checked it, lane by lane (`checkPlan`). */
  assignment: Assignment;
  /** When it was kept, ISO. Answered by the POST, so the screen can say the minute it saved at. */
  savedAt: string;
};

/** One plan per run of one scenario: "EVERY_RIDER_FITS/AM". */
export function savedPlanKey(scenario: DemoScenario, direction: Direction): string {
  return `${scenario}/${direction}`;
}

/**
 * The map hangs off `globalThis`, and that is not a shortcut.
 *
 * Next bundles a route handler and a server component separately, so a module-level `const` is
 * **not** one object between them: `POST /api/plan/save` would write into the route's copy and a
 * page rendering on the server would read its own, empty one. The board never noticed — it both
 * writes and reads through the endpoint, which is one bundle — but the Live map reads this on the
 * server to answer §9.1's "is a plan saved for this leg?", and it was reading an empty map every
 * time. One well-known key, so every bundle reaches the same object.
 *
 * It is still one process's memory, which is the honest limit already written at the top of this
 * file. #73's `src/modules/plan/memory.ts` holds the state the same way, for the same reason.
 */
const KEY = "__ppecDemoSavedPlans";
type Holder = typeof globalThis & { [KEY]?: Map<string, SavedPlan> };

function saved(): Map<string, SavedPlan> {
  const holder = globalThis as Holder;
  holder[KEY] ??= new Map<string, SavedPlan>();
  return holder[KEY];
}

/** Keep a checked plan, replacing whatever this run's last one was. */
export function putSavedPlan(plan: SavedPlan): SavedPlan {
  saved().set(savedPlanKey(plan.scenario, plan.direction), plan);
  return plan;
}

/** The plan last saved for this run, or null when none has been. */
export function getSavedPlan(scenario: DemoScenario, direction: Direction): SavedPlan | null {
  return saved().get(savedPlanKey(scenario, direction)) ?? null;
}

/**
 * Forget every saved plan. Called by the demo reset (src/modules/demo/reset.ts), because the day
 * those plans were plans of has just been re-seeded, and by tests that want a fresh process.
 */
export function clearSavedPlans(): void {
  saved().clear();
}
