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
      // A name when the server knows one, and the chip that names nobody when it does not.
      return {
        label: state.by ? fill(planBoard.changedBy, { name: state.by }) : planBoard.changedAnon,
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
  /** The step this banner is about, as a word and an address, or null when the fix is the DEMO bar. */
  action: { label: string; href: string } | null;
};

export function boardBanner(
  readiness: DayReadiness,
  firstUncheckedVanHref: string | null,
): BoardBanner | null {
  if (!readiness.started) {
    // Only the DEMO bar can start a day, and it is on every screen already (§9.3), so this
    // banner names the step and offers no second button for it.
    return { text: flow.banner.notStarted, tone: "warn", action: null };
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
 * and one line — no chip, no button — when it is being planned on its defaults.
 *
 * The "Not checked" chip is deliberately gone (STEERING, 2026-10-17 5:55 PM ET): an unconfirmed
 * van is a soft prerequisite and not a fault, so the column states the assumption it is standing
 * on instead of marking the van as wrong.
 */
export function setupLine(van: BoardVan): { label: string; tone: Tone; chip: boolean } {
  return van.setupState === "CHECKED"
    ? { label: planBoard.checked, tone: "ok", chip: true }
    : { label: planBoard.usingDefault, tone: "neutral", chip: false };
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
