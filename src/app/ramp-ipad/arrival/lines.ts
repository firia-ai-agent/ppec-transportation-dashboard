/**
 * Every line the van-arrival screen says, keyed by the facts behind it (redesign spec §2).
 *
 * The ramp iPad is read standing up, in the rain, at 18 px (DESIGN-DIRECTION §2's ramp body), so
 * every string here is three or four words and every one of them is a `copy.ts` key filled in.
 * The arithmetic is the board's own `src/domain/plan/fit.ts` — the front desk and the coordinator
 * must never be told two different things about one van.
 */
import { fill, pluralize, vanArrival } from "@/ui/copy";
import { formatClock } from "@/domain/eta/eta";
import type { RejectReason } from "@/config/equipment";
import type { Shortfall } from "@/domain/plan/fit";
import type { Tone } from "@/ui/tokens";

/** "What’s on Van 1?" — the card over the steppers. */
export function whatsOn(van: string): string {
  return fill(vanArrival.whatsOn, { van });
}

/** "Confirm Van 1" — the one primary button on the screen. */
export function confirmLabel(van: string): string {
  return fill(vanArrival.confirm, { van });
}

/** "Leaves 3:05 PM" — when this van pulls away from the centre, from the plan's own geometry. */
export function leavesLine(atMs: number): string {
  return fill(vanArrival.leaves, { time: formatClock(atMs) });
}

/**
 * "Default 3" — what this van normally carries, said only under a counter that differs from it.
 *
 * Not "Planned": nothing plans counts any more (Firia's rule 1, 2026-10-17 5:48 PM ET). The
 * number it compares against is the van's DEFAULT from the shared config, so a front desk who
 * finds one car seat on a van that usually has two can see that is a difference and not a typo.
 */
export function differsLine(n: number): string {
  return fill(vanArrival.differsFrom, { n });
}

/** One rider's verdict: "Fits", or the one thing that is missing. */
export function riderVerdict(reason: RejectReason | null): { label: string; tone: Tone } {
  if (!reason) return { label: vanArrival.fits, tone: "ok" };
  return { label: shortThing(reason, 1), tone: "crit" };
}

/** The thing a counter is short of, in words: "car seat", "2 car seats". */
export function shortThing(reason: RejectReason, count: number): string {
  const noun = vanArrival.shortThing[reason];
  return count === 1 ? capitalise(noun.one) : pluralize(count, noun);
}

/**
 * The banner over the riders when somebody does not fit: who, and how short the van is.
 *
 * Two lines and six words: "Mia R. won't fit" over "1 car seat short". The lift is not a number,
 * so it says so in its own words rather than counting to one.
 */
export function shortfallLines(
  child: string,
  shortfall: Shortfall,
): { who: string; short: string } {
  return {
    who: fill(vanArrival.wontFit, { child }),
    short:
      shortfall.reason === "LIFT"
        ? vanArrival.noLift
        : fill(vanArrival.short, {
            n: shortfall.short,
            thing: vanArrival.shortThing[shortfall.reason][shortfall.short === 1 ? "one" : "many"],
          }),
  };
}

function capitalise(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}
