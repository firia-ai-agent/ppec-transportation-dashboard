/**
 * Every line the board puts on screen, in one place and keyed by the facts behind it.
 *
 * SOURCE: redesign spec §1.3 (the states), §1.5 (the whole copy block) and §9.5 (the flow words).
 *
 * The components below are deliberately dumb: a column renders what this module says, so the
 * question "what does the screen say when a van is over its counts" is answered by a unit test
 * rather than by reading JSX. No string is built here either — every one of them is a `copy.ts`
 * key filled in (§0's rule 6), and no colour is chosen without a word beside it (§0's rule 2).
 */
import { fill, flow, planBoard } from "@/ui/copy";
import type { Tone } from "@/ui/tokens";
import { clockLabel, siteTimeLabel } from "@/ui/service-date";
import type { CounterKey, RejectReason } from "@/config/equipment";
import { COUNTER_LABEL } from "@/ui/equipment";
import type { DayReadiness } from "@/domain/day/readiness";
import type { BoardVan } from "@/domain/plan/board";

/** "10 of 12 placed" — the toolbar's one count. */
export function placedLine(placed: number, total: number): string {
  return fill(planBoard.placed, { n: placed, total });
}

/** How a save is going, as a chip: a word, a tone, and nothing that is only a colour (§1.3). */
export type SaveState =
  | { kind: "SAVED"; at: string }
  | { kind: "DIRTY" }
  | { kind: "SAVING" }
  | { kind: "FAILED" }
  | { kind: "CHANGED"; by: string | null };

export function saveLine(state: SaveState): { label: string; tone: Tone } {
  switch (state.kind) {
    case "SAVED":
      return { label: fill(planBoard.saved, { time: siteTimeLabel(new Date(state.at)) }), tone: "ok" };
    case "SAVING":
      return { label: planBoard.saving, tone: "neutral" };
    case "FAILED":
      return { label: planBoard.saveFailed, tone: "crit" };
    case "CHANGED":
      /*
       * Somebody else saved while this board was being built. The unsaved moves are kept, so
       * the chip asks for a reload rather than announcing a loss (Firia, 10:29 PM ET) — and it
       * names whoever moved it when the server knows a name.
       */
      return {
        label: state.by ? fill(planBoard.changedBy, { name: state.by }) : planBoard.changedReload,
        tone: "warn",
      };
    default:
      return { label: planBoard.notSaved, tone: "neutral" };
  }
}

/** "4 of 6 Seats" — what a meter is called when it is read out rather than looked at. */
export function meterSr(used: number, total: number, counter: CounterKey): string {
  return fill(planBoard.meterSr, { used, total, thing: COUNTER_LABEL[counter] });
}

/** The one word on a refused column's chip. */
export function rejectChip(reason: RejectReason): string {
  return planBoard.reject[reason];
}

/** "Noah O. won't fit Van 3: no wheelchair spot" — announced, not only drawn (§1.3). */
export function rejectSr(child: string, van: string, reason: RejectReason): string {
  return fill(planBoard.rejectSr, { child, van, thing: planBoard.rejectThing[reason] });
}

/**
 * "Van 1 wheelchair full" — the one line a refused drop leaves on the card (Vera's taste spec,
 * 2026-10-18).
 *
 * Four words at most, naming the van and the thing that is missing, and nothing else: no code,
 * no count, and no toast — a refusal is about the card a person is holding, and a toast about it
 * would slide away while the card sat there unexplained.
 */
export function rejectCardLine(van: string, reason: RejectReason): string {
  return fill(planBoard.rejectCard[reason], { van });
}

/** "Mia R. → Van 2" — what a drop leaves behind for four seconds. */
export function movedLine(child: string, van: string): string {
  return fill(planBoard.moved, { child, van });
}

/** "Seats 4/6" — one read-only count chip on a van column (§1.2 as re-cut 5:55 PM ET). */
export function countChip(counter: CounterKey, used: number, total: number): string {
  return fill(planBoard.countChip, { thing: COUNTER_LABEL[counter], used, total });
}

/** What tapping a count chip does, in words: "Count Van 2 at the ramp". */
export function countChipLabel(van: string): string {
  return fill(planBoard.openRamp, { van });
}

/** "3:14 PM · Boynton Beach Mall" — a rider's own line inside a van. */
export function stopLine(window: string, stopLabel: string): string {
  return `${clockLabel(window)} · ${stopLabel}`;
}

/** "3 stops" and "38 min" — a van's footer. */
export function footerLines(stops: number, minutes: number): { stops: string; minutes: string } {
  return {
    stops: fill(planBoard.stops, { n: stops }),
    minutes: fill(planBoard.minutes, { n: minutes }),
  };
}

/**
 * The one banner a board can carry, and the link that fixes it (§9.3's Plan routes rows).
 *
 * Two cases: the day has not been started at all, or some van has not been confirmed today and
 * the plan is standing on its defaults. There is no third, carried-forward case — an unconfirmed
 * van uses the shared config's defaults and nothing else (Firia/Veri, 6:00 PM ET). A day whose
 * vans were all counted today carries no banner, because there is nothing to say.
 */
export type BoardBanner = {
  text: string;
  tone: Tone;
  /**
   * The step this banner is about: a word and an address, a word and a button, or nothing.
   * `start: true` is the one button this strip has — "Start demo day", for the role the reset
   * endpoint allows (Firia's final scope, 2026-10-18 1:50 AM ET).
   */
  action: { label: string; href: string } | { label: string; start: true } | null;
};

/**
 * @param canStartDay the caller may start the demo day — the director, which is the one role
 * `POST /api/demo/reset` allows (src/auth/access.ts). A coordinator is offered the way to it
 * instead of a button that would answer 403, and the server still decides either way.
 */
export function boardBanner(
  readiness: DayReadiness,
  firstUncheckedVanHref: string | null,
  canStartDay = false,
): BoardBanner | null {
  if (!readiness.started) {
    // One button, and only for the role that may press it (Firia, 1:50 AM ET). For everybody
    // else the strip says where the day is started rather than offering a refusal.
    return {
      text: flow.banner.notStarted,
      tone: "warn",
      action: canStartDay
        ? { label: flow.action.startDemo, start: true }
        : { label: flow.action.whereDayStarts, href: "/today" },
    };
  }
  if (readiness.setup.source === "DEFAULT") {
    return {
      text: flow.banner.usingDefault,
      tone: "info",
      action: firstUncheckedVanHref
        ? { label: flow.action.checkVans, href: firstUncheckedVanHref }
        : null,
    };
  }
  return null;
}

/**
 * What a van column says about its counts: the ok chip when the front desk confirmed it today,
 * and **nothing at all** when it is being planned on its defaults.
 *
 * The "Not checked" chip is deliberately gone (STEERING, 2026-10-17 5:55 PM ET): an unconfirmed
 * van is a soft prerequisite and not a fault, so the column does not mark the van as wrong.
 *
 * Nor does it carry "Using default setup" any more (Vera on b3453cd, 2026-10-18). That line is
 * the **board's**, once, in the banner beside "Check vans" (`boardBanner` above) — on three
 * columns it was the same sentence three times, which is three times the weight for one fact
 * that is about the day and not about any one van. The words stay in copy.ts, where the banner
 * reads them.
 */
export function setupLine(van: BoardVan): { label: string; tone: Tone } | null {
  return van.setupState === "CHECKED" ? { label: planBoard.checked, tone: "ok" } : null;
}

/** "ML" — the two letters on a driver's avatar, from their own name and never a code. */
export function initialsOf(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}
