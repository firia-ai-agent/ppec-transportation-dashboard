/**
 * The order of the day, in one object: is the demo day started, are the vans counted, is there a
 * plan, and are the vans moving.
 *
 * SOURCE: redesign spec §9.1 and §9.4, and Vera's binding interim rules of 2026-10-17 3:00 PM ET:
 * "One shared helper `getDayReadiness(date)` returns `{setup, plan, live}`. The step strip, the
 * empty states and the server guards all read from it. Never write the check twice."
 *
 * This is the pure half — facts in, states out, unit-tested — and it is deliberately the only
 * place the rules live:
 *
 *  - **Van setup is soft** (conflict C5, §9.1): it is `DONE` when every van has a `CHECKED` row
 *    for the date and `NEEDED` otherwise, and it is never `LOCKED`. A board with no van checked
 *    today still plans — on the shared config's defaults — and says so in place.
 *  - **A plan is hard for everything after it.** `plan` is `LOCKED` only when the day has not
 *    been started, `DONE` when a plan is saved for this date and leg, `NEEDED` otherwise.
 *  - **Live needs a plan.** `LOCKED` with no saved plan or no started day, `RUNNING` once a van
 *    has moved, `NEEDED` in between — a saved plan whose vans are still at the depot.
 *
 * The thin loader that reads these facts out of the database is `getDayReadiness`
 * (src/modules/plan/readiness.ts); the strip, the banners and the guards all go through it, so
 * no screen re-implements a single line of this.
 *
 * Pure: no clock, no database, no network. Dates are the service dates the caller resolved in
 * centre time, and the one piece of formatting in here is the three-letter weekday the strip and
 * the board's banner both show ("From Fri").
 */
import type { Direction } from "@/domain/day/leg";
import type { SetupSource } from "@/domain/plan/setup";

export type StepState = "DONE" | "NEEDED" | "LOCKED" | "RUNNING";

/** What the database says about one day, read once (src/modules/plan/readiness.ts). */
export type DayFacts = {
  /** "2026-10-17", centre time. */
  date: string;
  leg: Direction;
  /**
   * Has the demo day been started for this date? Outside demo mode this is always true, so the
   * step does not exist (§9.1). In demo mode it is the day having been reset, which is what the
   * DEMO bar's button does.
   */
  started: boolean;
  /** How many vans the board plans with, and how many of them the ramp confirmed today. */
  vans: number;
  vansCheckedToday: number;
  /**
   * Which counts the day as a whole is standing on: `CHECKED` only when the ramp has confirmed
   * every van today, `DEFAULT` otherwise (Firia/Veri 6:00 PM ET — there is no carry-over rung).
   */
  setupSource: SetupSource;
  /** When the plan for this date and leg was saved, ISO, or null when none is. */
  planSavedAt: string | null;
  /** Who saved it, in words, when anybody did. */
  planSavedBy?: string | null;
  /** Riders of this leg in no van on the saved plan. */
  unassigned: number;
  /** Vans that have moved today: the live step is `RUNNING` once any of them has. */
  vansOut: number;
  /** Family texts waiting for a person (the menu badge). */
  approvalsWaiting: number;
};

export type DayReadiness = {
  date: string;
  leg: Direction;
  started: boolean;
  setup: {
    state: "DONE" | "NEEDED";
    checked: number;
    total: number;
    source: SetupSource;
  };
  plan: {
    state: "DONE" | "NEEDED" | "LOCKED";
    savedAt?: string;
    savedBy?: string;
    unassigned: number;
  };
  live: {
    state: "LOCKED" | "NEEDED" | "RUNNING";
    vansOut: number;
    /** What is missing, when the step is locked: the plan, or the day itself. */
    blockedBy?: "PLAN" | "START";
  };
  approvals: { waiting: number };
};

/** "2026-10-16" → "Fri". Three letters, in centre time, as §9.5 fixes the format. */
export function weekdayLabel(isoDate: string): string {
  // Read at noon UTC so the centre's own calendar day is the one named, whatever the offset.
  const at = new Date(`${isoDate}T12:00:00Z`);
  if (Number.isNaN(at.getTime())) return "";
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short" }).format(at);
}

/** The three steps, from the day's facts. */
export function deriveReadiness(facts: DayFacts): DayReadiness {
  const planSaved = facts.planSavedAt !== null;
  const setupDone = facts.vans > 0 && facts.vansCheckedToday >= facts.vans;

  const plan: DayReadiness["plan"] = {
    state: !facts.started ? "LOCKED" : planSaved ? "DONE" : "NEEDED",
    unassigned: facts.unassigned,
    ...(facts.planSavedAt ? { savedAt: facts.planSavedAt } : {}),
    ...(facts.planSavedBy ? { savedBy: facts.planSavedBy } : {}),
  };

  const live: DayReadiness["live"] = !facts.started
    ? { state: "LOCKED", vansOut: 0, blockedBy: "START" }
    : !planSaved
      ? { state: "LOCKED", vansOut: 0, blockedBy: "PLAN" }
      : facts.vansOut > 0
        ? { state: "RUNNING", vansOut: facts.vansOut }
        : { state: "NEEDED", vansOut: 0 };

  return {
    date: facts.date,
    leg: facts.leg,
    started: facts.started,
    setup: {
      state: setupDone ? "DONE" : "NEEDED",
      checked: facts.vansCheckedToday,
      total: facts.vans,
      source: facts.setupSource,
    },
    plan,
    live,
    approvals: { waiting: facts.approvalsWaiting },
  };
}

export { defaultLeg } from "./leg";
