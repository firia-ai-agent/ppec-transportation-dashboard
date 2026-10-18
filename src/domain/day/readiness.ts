/**
 * THE DAY'S READINESS — how far through the order of the day this site is, as a fact.
 *
 * SOURCE: REDESIGN-SPEC §9.1 (the order of the day and which arrow is hard), §9.2 (the step
 * strip's states), §9.4 ("one readiness helper, used three ways"), and Vera's binding interim
 * rules of 2026-10-17 3:00 PM ET: "One shared helper returns `{setup, plan, live}`. The step
 * strip, the empty states and the server guards all read from it. Never write the check twice."
 *
 * **One module, both halves.** #74's frame brought the step strip and its thin loader
 * (src/domain/day/day-facts.ts); #73's board brought the facts a planned day actually has —
 * whether the demo day was started, which counts the day stands on, how many riders are in no
 * van, how many vans have moved. They were written separately and are merged here rather than
 * kept as two modules, because two readiness helpers is exactly the thing §9.4 forbids.
 *
 * **Pure.** No database, no `next/*`, no `process.env`: it takes the day's facts and returns the
 * day's states, so every combination is a unit test rather than a seeded row. The loaders that
 * go and get those facts are beside it — src/domain/day/day-facts.ts for the strip and
 * src/modules/plan/store.ts for the board — and they are the only parts that touch a connection,
 * which is also what keeps `pg` out of the browser bundle.
 *
 * **It cannot say Done about a day it did not read.** `DayFacts.read` is false whenever the
 * facts could not be fetched — no site on the caller, no database in this shell, a query that
 * threw — and every rule below is written so that `read: false` falls to Needed and Locked. A
 * strip that showed "3/3 checked" because a query failed would be the one thing on the screen
 * that is not a fact.
 *
 * The rules, in one place:
 *  - **Van setup is soft** (conflict C5, §9.1): `DONE` when the site has vans and every one of
 *    them carries today's `CHECKED` row, `NEEDED` otherwise, and never `LOCKED`. A board with no
 *    van checked today still plans — on the shared config's defaults — and says so in place.
 *  - **A plan is hard for everything after it.** `LOCKED` only while the demo day has not been
 *    started, `DONE` when a plan is saved for this date and leg, `NEEDED` otherwise.
 *  - **Live needs a plan.** `LOCKED` with no started day or no saved plan, `RUNNING` once a van
 *    has moved, `NEEDED` in between — a saved plan whose vans are still at the depot.
 */
import type { Direction } from "@/domain/day/leg";
import type { SetupSource } from "@/domain/plan/setup";

/**
 * §9.2's state table, as the step strip draws it.
 *
 * `RUNNING` is the fourth row there — the live map once vans are moving — and it is not in this
 * union because the strip has three words for a step and no fourth (`flow.state` in
 * src/ui/copy.ts). The *fact* behind it is kept: `live.state` below can be `RUNNING`, and the
 * strip reads a running map as its unlocked state until the word lands with its copy.
 */
export type StepState = "DONE" | "NEEDED" | "LOCKED";

/** Which run of the day is being worked. §9.1: part of every check. */
export type Leg = Direction;

/**
 * What the day's three steps are decided from. Everything here is a count or a timestamp read
 * off a row — there is no state in it, because deciding the state is this module's whole job.
 *
 * Only the date and the leg are required. Every other fact has a documented default, so a
 * caller that genuinely does not have one (the strip's loader has no notion of "started"; the
 * board's store has no notion of a day it could not read) says what it knows and nothing more.
 */
export type DayFacts = {
  /** The service date these facts are about: 'YYYY-MM-DD', centre time. */
  date: string;
  leg: Leg;
  /**
   * Were these facts actually read? False means "nobody knows", which is a different answer
   * from every count being zero, and the one that must never become a Done. Default: true.
   */
  read?: boolean;
  /**
   * Has the demo day been started for this date? Outside demo mode this is always true, so the
   * step does not exist (§9.1). In demo mode it is the day having been reset, which is what the
   * DEMO bar's button does. Default: true.
   */
  started?: boolean;
  /** Vans this site has at all. Default: 0. */
  vans?: number;
  /** Of those, how many carry a `CHECKED` setup row for this date. Default: 0. */
  vansChecked?: number;
  /**
   * Which counts the day as a whole is standing on: `CHECKED` only when the ramp has confirmed
   * every van today, `DEFAULT` otherwise (Firia/Veri 6:00 PM ET — there is no carry-over rung).
   * Default: derived from the two counts above.
   */
  setupSource?: SetupSource;
  /** When the plan for this date and leg was saved, or null when none was. Default: null. */
  planSavedAt?: string | Date | null;
  /** Who saved it, in words, when anybody did. Default: null. */
  planSavedBy?: string | null;
  /** Riders of this leg in no van on the saved plan. Default: 0. */
  unassigned?: number;
  /** Vans that have moved today: the live step is `RUNNING` once any of them has. Default: 0. */
  vansOut?: number;
  /** Family texts waiting for a person (the menu badge). Default: 0. */
  approvalsWaiting?: number;
};

export type DayReadiness = {
  date: string;
  leg: Leg;
  /** Has the demo day been started? The one thing that locks the plan step itself. */
  started: boolean;
  /** Never Locked: §9.1 makes Van setup → Plan routes a *soft* arrow, so it never blocks. */
  setup: { state: "DONE" | "NEEDED"; checked: number; total: number; source: SetupSource };
  plan: {
    state: "DONE" | "NEEDED" | "LOCKED";
    savedAt: Date | null;
    savedBy: string | null;
    unassigned: number;
  };
  /** §9.1's one hard arrow in this slice: no saved plan for this leg, no live map. */
  live: {
    state: "NEEDED" | "LOCKED" | "RUNNING";
    vansOut: number;
    /** What is missing, when the step is locked: the plan, or the day itself. */
    blockedBy: "PLAN" | "START" | null;
  };
  approvals: { waiting: number };
};

/** The day as it reads when nothing could be read: the fail-safe every caller falls back to. */
export function unreadFacts(date: string, leg: Leg): DayFacts {
  return { date, leg, read: false, vans: 0, vansChecked: 0, planSavedAt: null };
}

/** "2026-10-16" → "Fri". Three letters, in centre time, as §9.5 fixes the format. */
export function weekdayLabel(isoDate: string): string {
  // Read at noon UTC so the centre's own calendar day is the one named, whatever the offset.
  const at = new Date(`${isoDate}T12:00:00Z`);
  if (Number.isNaN(at.getTime())) return "";
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short" }).format(at);
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
 *    routes, no ETAs" — Running once a van has moved, and Needed in between. It is never Done,
 *    because watching is not a thing that finishes.
 */
export function deriveReadiness(facts: DayFacts): DayReadiness {
  const read = facts.read ?? true;
  const started = facts.started ?? true;
  const checked = read ? (facts.vansChecked ?? 0) : 0;
  const total = read ? (facts.vans ?? 0) : 0;
  const setupDone = read && total > 0 && checked >= total;
  const source: SetupSource = read ? (facts.setupSource ?? (setupDone ? "CHECKED" : "DEFAULT")) : "DEFAULT";

  const savedAt = read ? toDate(facts.planSavedAt) : null;
  const planSaved = savedAt !== null;
  const vansOut = read ? (facts.vansOut ?? 0) : 0;

  const plan: DayReadiness["plan"] = {
    state: !started ? "LOCKED" : planSaved ? "DONE" : "NEEDED",
    savedAt,
    savedBy: planSaved ? (facts.planSavedBy ?? null) : null,
    unassigned: read ? (facts.unassigned ?? 0) : 0,
  };

  const live: DayReadiness["live"] = !started
    ? { state: "LOCKED", vansOut: 0, blockedBy: "START" }
    : !planSaved
      ? { state: "LOCKED", vansOut: 0, blockedBy: "PLAN" }
      : vansOut > 0
        ? { state: "RUNNING", vansOut, blockedBy: null }
        : { state: "NEEDED", vansOut: 0, blockedBy: null };

  return {
    date: facts.date,
    leg: facts.leg,
    started,
    setup: { state: setupDone ? "DONE" : "NEEDED", checked, total, source },
    plan,
    live,
    approvals: { waiting: read ? (facts.approvalsWaiting ?? 0) : 0 },
  };
}

/** A timestamp as the one type the card formats, whichever way the loader read it. */
function toDate(at: string | Date | null | undefined): Date | null {
  if (at == null) return null;
  const date = at instanceof Date ? at : new Date(at);
  return Number.isNaN(date.getTime()) ? null : date;
}

export { defaultLeg } from "./leg";
