/**
 * The template id of the late text a saved re-plan sends (`modules/plan/replan-notices.ts`).
 *
 * A leaf of its own, importing nothing, because three modules that import one another — the outbox's
 * allow-list, the renderer and the sender — all need the one name.
 */
export const REPLAN_LATE_TEMPLATE = "dropoff.late_eta";
