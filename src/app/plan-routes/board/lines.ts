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
import { fill, flow, planBoard, vanArrival } from "@/ui/copy";
import type { Tone } from "@/ui/tokens";
import { clockLabel, siteTimeLabel } from "@/ui/service-date";
import type { RejectReason } from "@/config/equipment";
import type { CounterKey } from "@/config/equipment";
import { COUNTER_LABEL } from "@/ui/equipment";
import type { DayReadiness } from "@/domain/day/readiness";
import type { BoardVan } from "@/domain/plan/board";
import { weekdayLabel } from "@/domain/day/readiness";

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

/** "{child} fits" / "{child} won't fit" — the live preview inside the setup popover. */
export function fitPreview(child: string, fits: boolean): string {
  return fill(fits ? planBoard.fits : planBoard.wontFit, { child });
}

/** "Van 2 setup" */
export function setupTitle(van: string): string {
  return fill(planBoard.setupTitle, { van });
}

/**
 * "From Fri · Ramp staff" — where the setup in the popover came from, or nothing at all when it
 * was set today (there is no earlier day to name, so the line would be furniture).
 */
export function setupFromLine(van: BoardVan): string | null {
  if (!van.setupFromDate) return null;
  return fill(planBoard.setupFrom, {
    day: weekdayLabel(van.setupFromDate),
    // The front desk is who counts a van, and a seeded or browser-check row records no user, so
    // that is the attribution rather than an invented person.
    name: van.setupBy ?? vanArrival.observedBy,
  });
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

/** "Van 3 is over. Save anyway?" — the one confirm this screen asks for (§1.3). */
export function overConfirm(van: string): string {
  return fill(planBoard.overConfirm, { van });
}

/**
 * The one banner a board can carry, and the link that fixes it (§9.3's Plan routes rows).
 *
 * Three cases, in the order they matter: the day has not been started at all, nothing has been
 * confirmed today and the plan is standing on yesterday's counts, or nothing has ever been
 * confirmed and it is standing on the configured defaults. A day whose vans were all counted
 * today carries no banner, because there is nothing to say.
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
  if (readiness.setup.source === "YESTERDAY") {
    return {
      text: flow.banner.usingYesterday,
      tone: "info",
      action: firstUncheckedVanHref
        ? { label: flow.action.checkVans, href: firstUncheckedVanHref }
        : null,
    };
  }
  if (readiness.setup.source === "DEFAULT") {
    return {
      text: flow.banner.usingDefaults,
      tone: "info",
      action: firstUncheckedVanHref
        ? { label: flow.action.checkVans, href: firstUncheckedVanHref }
        : null,
    };
  }
  return null;
}

/** The driver row's chip: the ramp confirmed this van today, or it did not (§1.3's last row). */
export function checkedChip(van: BoardVan): { label: string; tone: Tone } {
  return van.setupState === "CHECKED"
    ? { label: planBoard.checked, tone: "ok" }
    : { label: planBoard.notChecked, tone: "warn" };
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
