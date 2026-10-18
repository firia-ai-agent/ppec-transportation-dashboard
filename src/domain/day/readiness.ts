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
};

export type DayReadiness = {
  date: string;
  leg: Leg;
  /** Never Locked: §9.1 makes Van setup → Plan routes a *soft* arrow, so it never blocks. */
  setup: { state: "DONE" | "NEEDED"; checked: number; total: number };
  plan: { state: "DONE" | "NEEDED"; savedAt: Date | null };
  /** §9.1's one hard arrow in this slice: no saved plan for this leg, no live map. */
  live: { state: "NEEDED" | "LOCKED"; blockedBy: "PLAN" | null };
};

/** The day as it reads when nothing could be read: the fail-safe every caller falls back to. */
export function unreadFacts(date: string, leg: Leg): DayFacts {
  return { date, leg, read: false, vans: 0, vansChecked: 0, planSavedAt: null };
}

/**
 * The day's facts, as the three states a person sees.
 *
 *  - **Van setup** is Done only when there are vans and every one of them has today's `CHECKED`
 *    row. Zero vans is Needed, not Done: "0/0 checked" is a site with no vans in it (§9.3 gives
 *    that its own empty state), and a tick beside it would be congratulating nobody.
 *  - **Plan routes** is Done when a `plan_run` exists for this date and leg. The minute it was
 *    saved at rides along, because the card says it ("Saved 2:41 PM", §9.5).
 *  - **Live map** is Locked until that plan exists — §9.1's hard arrow, "no saved plan = no
 *    routes, no ETAs" — and Needed once it does. It is never Done, because watching is not a
 *    thing that finishes.
 */
export function deriveReadiness(facts: DayFacts): DayReadiness {
  const checked = facts.read ? facts.vansChecked : 0;
  const total = facts.read ? facts.vans : 0;
  const setupDone = facts.read && total > 0 && checked === total;

  const savedAt = facts.read ? facts.planSavedAt : null;
  const planDone = savedAt !== null;

  return {
    date: facts.date,
    leg: facts.leg,
    setup: { state: setupDone ? "DONE" : "NEEDED", checked, total },
    plan: { state: planDone ? "DONE" : "NEEDED", savedAt },
    live: planDone
      ? { state: "NEEDED", blockedBy: null }
      : { state: "LOCKED", blockedBy: "PLAN" },
  };
}
