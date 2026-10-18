/**
 * THE MORNING EVERY S1 TEST IS ABOUT — Firia's prod re-save of 2026-10-18 5:09 AM ET.
 *
 * Veri's GET-only prod check on a34ce49 found Today's morning van column disagreeing with the
 * board the director had just saved for **five of nine children** (Ava N., Eli N., Ivy H.,
 * Owen C., Theo V.), because Today took each ride's van from the demo scenario's own runs and the
 * saved plan was in `ops.plan_run` / `ops.plan_assignment`. Firia then re-saved that morning in
 * production, and this is the layout it came out as: Auto-plan, with Liam D. dragged to Van 2,
 * nine of nine placed.
 *
 * It is written down once, here, rather than left to Auto-plan in each test: the point of these
 * tests is that four readers agree about **one** plan, and a layout that drifts between them is a
 * layout that proves nothing. Both the memory-store round trip
 * (src/app/(app)/today/saved-plan.test.ts) and the seeded-database one
 * (src/app/(app)/today/saved-plan.db.test.ts) mirror this exact morning.
 *
 * Child and vehicle keys are the fixtures' (src/modules/demo/fixtures/standard.ts): C3 is
 * Liam D., V2 is Van 2. The keys carry the names in the comments so a reviewer can read the
 * layout against Firia's message without opening the fixture.
 *
 * Every van fits its riders on the shared defaults — 6 seats, 1 chair, 3 car seats, 1 oxygen
 * mount (src/config/vans.ts `GENERIC_VAN`, Firia's ruling of 2026-10-18 8:49 AM ET) — which is
 * what lets the server's own re-check accept the whole save (src/domain/plan/fit.ts): the two
 * chairs (Noah O., Zoe B.) are on different vans, the one oxygen rider has that van's mount, and
 * the three car seats are one per van. Both screens check this morning against those counts and
 * neither warns about a ride in it (src/app/(app)/today/one-van-setup.test.ts).
 */

/** Liam D., and the drag that is the whole of the difference below. */
export const MOVED_CHILD = "C3";
export const MOVED_FROM = "V1";
export const MOVED_TO = "V2";

/**
 * The morning as **Auto-plan** left it, which is what the board's Save writes first: Liam D. (C3)
 * is still on Van 1. One child away from the plan below, and that child is the drag.
 */
export const AUTO_PLANNED_VANS: Readonly<Record<string, readonly string[]>> = {
  V1: ["C6", "C4", "C3"], // Zoe B., Ava N., Liam D.
  V2: ["C5", "C8", "C2"], // Eli N., Ivy H., Noah O.
  V3: ["C1", "C7", "C9"], // Mia R., Owen C., Theo V.
};

/**
 * The saved morning itself, after the drag — Firia's 5:09 AM ET layout, van by van.
 * Van 1 carries two, Van 2 four, Van 3 three: nine of nine placed, nobody unassigned.
 */
export const REFERENCE_VANS: Readonly<Record<string, readonly string[]>> = {
  V1: ["C6", "C4"], // Zoe B., Ava N.
  V2: ["C5", "C8", "C3", "C2"], // Eli N., Ivy H., Liam D. (dragged here), Noah O.
  V3: ["C1", "C7", "C9"], // Mia R., Owen C., Theo V.
};

/**
 * The same morning child by child, which is the direction every assertion reads it in: given a
 * child, which van does this screen put them on? Veri's five are marked.
 */
export const REFERENCE_MORNING: Readonly<Record<string, string>> = {
  C6: "V1", // Zoe B.
  C4: "V1", // Ava N.      — Veri: Today said Van 3
  C5: "V2", // Eli N.      — Veri: Today said Van 3
  C8: "V2", // Ivy H.      — Veri: Today said Van 1
  C3: "V2", // Liam D.     — the drag
  C2: "V2", // Noah O.
  C1: "V3", // Mia R.
  C7: "V3", // Owen C.     — Veri: Today said Van 1
  C9: "V3", // Theo V.     — Veri: Today said Van 2
};

/** The five children Veri named, with the van the saved plan puts each of them on. */
export const VERI_FIVE: Readonly<Record<string, string>> = {
  C4: "V1", // Ava N.
  C5: "V2", // Eli N.
  C8: "V2", // Ivy H.
  C7: "V3", // Owen C.
  C9: "V3", // Theo V.
};
