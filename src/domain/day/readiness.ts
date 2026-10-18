/**
 * THE DAY'S READINESS — how far through the order of the day this site is, as a fact.
 *
 * SOURCE: REDESIGN-SPEC §9.1 (the order of the day and which arrow is hard), §9.2 (the step
 * strip's four states), §9.4 ("one readiness helper, used three ways"). The strip on Today is
 * the first of those three ways; the empty states and the server guards are the other two, and
 * they read this same object when they land.
 *
 * **Pure.** No database, no `next/*`, no `process.env`: it takes the day's facts and returns the
 * day's states, so every combination is a unit test rather than a seeded row. The thin loader
 * that goes and gets those facts is beside it (src/domain/day/day-facts.ts) and is the only part
 * that touches a connection — which is also what keeps `pg` out of the browser bundle, since the
 * step strip imports its types from here.
 *
 * **It cannot say Done about a day it did not read.** `DayFacts.read` is false whenever the
 * facts could not be fetched — no site on the caller, no database in this shell, a query that
 * threw — and every rule below is written so that `read: false` falls to Needed and Locked. A
 * strip that showed "3/3 checked" because a query failed would be the one thing on the screen
 * that is not a fact.
 */

/**
 * §9.2's state table, less one.
 *
 * `Running` is the fourth row there — the live map once vans are moving — and it is not in this
 * union because nothing in this build records that a van has left the depot. The positions the
 * live map draws are the scenario's replay, not a report from a van, so "Running" would be a
 * claim about the day made out of a recording. It lands with the fact that backs it.
 */
export type StepState = "DONE" | "NEEDED" | "LOCKED";

/** Which run of the day is being worked. §9.1: part of every check. */
export type Leg = "AM" | "PM";

/**
 * What the day's three steps are decided from. Everything here is a count or a timestamp read
 * off a row — there is no state in it, because deciding the state is this module's whole job.
 */
export type DayFacts = {
  /** The service date these facts are about: 'YYYY-MM-DD', centre time. */
  date: string;
  leg: Leg;
  /**
   * Were these facts actually read? False means "nobody knows", which is a different answer
   * from every count being zero, and the one that must never become a Done.
   */
  read: boolean;
  /** Vans this site has at all. */
  vans: number;
  /** Of those, how many carry a `CHECKED` setup row for this date. */
  vansChecked: number;
  /** When a plan was saved for this date and leg, or null when none was. */
  planSavedAt: Date | null;
  /**
   * How many children on that saved plan are still in the `UNASSIGNED` bucket — nobody's van.
   *
   * `null` is "the plan is there and this could not be read", which is a third answer and not a
   * zero: a count that failed must never be allowed to look like a plan with everybody placed.
   * It is `null` as well when there is no plan at all, because there is then nothing to count.
   */
  planUnplaced: number | null;
};

export type DayReadiness = {
  date: string;
  leg: Leg;
  /** Never Locked: §9.1 makes Van setup → Plan routes a *soft* arrow, so it never blocks. */
  setup: { state: "DONE" | "NEEDED"; checked: number; total: number };
  /**
   * `savedAt` is the minute a plan exists from; `unplaced` is how many children it left in
   * nobody's van, `null` when there is no plan or the count could not be read. A plan is Done
   * only at `unplaced === 0`: saving a board with a child on the bench is a step that is not
   * finished, and the card says so in amber rather than ticking.
   */
  plan: { state: "DONE" | "NEEDED"; savedAt: Date | null; unplaced: number | null };
  /** §9.1's one hard arrow in this slice: no saved plan for this leg, no live map. */
  live: { state: "NEEDED" | "LOCKED"; blockedBy: "PLAN" | null };
};

/** The day as it reads when nothing could be read: the fail-safe every caller falls back to. */
export function unreadFacts(date: string, leg: Leg): DayFacts {
  return { date, leg, read: false, vans: 0, vansChecked: 0, planSavedAt: null, planUnplaced: null };
}

/**
 * The day's facts, as the three states a person sees.
 *
 *  - **Van setup** is Done only when there are vans and every one of them has today's `CHECKED`
 *    row. Zero vans is Needed, not Done: "0/0 checked" is a site with no vans in it (§9.3 gives
 *    that its own empty state), and a tick beside it would be congratulating nobody.
 *  - **Plan routes** is Done when a `plan_run` exists for this date and leg **and nobody is
 *    left on the bench**. A board saved with a child still in `UNASSIGNED` is a step that is not
 *    finished — somebody has no ride — so the card stays Needed and says how many
 *    ("Saved · 2 unplaced", §9.5), which is the amber tone rather than the tick. A count that
 *    could not be read is `null` and is also not Done: the fail-safe is "we do not know", never
 *    "everybody is placed" (Vera, 2026-10-17 8:46 PM ET).
 *  - **Live map** is Locked until that plan exists — §9.1's hard arrow, "no saved plan = no
 *    routes, no ETAs" — and Needed once it does. It unlocks on the plan being **saved**, not on
 *    Plan routes being Done: a day with one child unplaced still has routes, ETAs and vans to
 *    watch, and locking the map over it would hide the day from the person running it. It is
 *    never Done, because watching is not a thing that finishes.
 */
export function deriveReadiness(facts: DayFacts): DayReadiness {
  const checked = facts.read ? facts.vansChecked : 0;
  const total = facts.read ? facts.vans : 0;
  const setupDone = facts.read && total > 0 && checked === total;

  const savedAt = facts.read ? facts.planSavedAt : null;
  const planSaved = savedAt !== null;
  // No plan, no count: `unplaced` is about the children on a board that exists.
  const unplaced = planSaved && facts.read ? facts.planUnplaced : null;
  const planDone = planSaved && unplaced === 0;

  return {
    date: facts.date,
    leg: facts.leg,
    setup: { state: setupDone ? "DONE" : "NEEDED", checked, total },
    plan: { state: planDone ? "DONE" : "NEEDED", savedAt, unplaced },
    live: planSaved
      ? { state: "NEEDED", blockedBy: null }
      : { state: "LOCKED", blockedBy: "PLAN" },
  };
}
