/**
 * THE FOUR "RIGHT NOW" TILES — Health on Today
 * (png/health-demo-1440.png, png/health-demo-390.png).
 *
 * Firia, 2026-10-17: Health is these four tiles on the Today page, and nothing else. No chart,
 * no Systems row, no Savings row. The hours and money this deployment cannot measure stay in
 * `metrics.ts` (`BASELINE_ROWS`) and are not drawn: an absent row is not a fifth tile.
 *
 * Pure. A `RightNowFacts` in, four tiles out. The facts are read from the day's own rows
 * (src/domain/health/right-now-facts.ts) — the same van check the step strip uses, the saved
 * plan, the latest arrival, the open "needs a person" tasks. Nothing here holds a figure of
 * its own.
 */
import { fill, healthNow, nav } from "@/ui/copy";

export const RIGHT_NOW_TILES = [
  "KIDS_PLACED",
  "VANS_CHECKED",
  "RUNNING_LATE",
  "NEEDS_YOU",
] as const;
export type RightNowKey = (typeof RIGHT_NOW_TILES)[number];

/** Which mark the pill draws. The colour is the component's, and it is grey. */
export type RightNowPillKind = "all" | "van" | "family";

export type RightNowPill = { text: string; kind: RightNowPillKind };

export type RightNowTile = {
  key: RightNowKey;
  label: string;
  count: number;
  /** Set on the two tiles the mockup writes as a fraction. Null when the number stands alone. */
  outOf: number | null;
  pill: RightNowPill | null;
};

/**
 * What the four tiles are counted from. Every field is a count or a name read off a row.
 * `read: false` is "nobody knows" — the day the browser check has, and a query that failed —
 * and it must never become a pill that says All.
 */
export type RightNowFacts = {
  read: boolean;
  /** Children in a van on the saved plan for this leg. */
  placed: number;
  /** Children the plan is still seating: in a van, or not in one yet. Family drives and absent are not in this. */
  toPlace: number;
  /** Vans with today's CHECKED setup row. The step strip's own count. */
  vansChecked: number;
  /** Vans this site has. */
  vans: number;
  /** On-screen names of the vans that are not checked, in label order. */
  uncheckedVans: readonly string[];
  /** On-screen names of the vans running later than their window, in label order. */
  lateVans: readonly string[];
  /** Open tasks of kind NEEDS_PERSON (docs/DATA-MODEL.md, StaffAlert). */
  needsYou: number;
};

/** The day as it reads when nothing could be read. */
export function unreadRightNow(): RightNowFacts {
  return {
    read: false,
    placed: 0,
    toPlace: 0,
    vansChecked: 0,
    vans: 0,
    uncheckedVans: [],
    lateVans: [],
    needsYou: 0,
  };
}

/**
 * A van as the pill says it.
 *
 * The row is stored with the code the rest of the system uses ("V3 substitute van"). The pill
 * says "Van 3", which is the word on the mockup, and the code never reaches the screen. A label
 * that is already "Van 3" is left as it is.
 */
export function vanOnScreen(label: string): string {
  const coded = /^V(\d+)\b/i.exec(label.trim());
  if (!coded) return label.trim();
  return fill(healthNow.van, { n: coded[1] });
}

function allPill(): RightNowPill {
  return { text: healthNow.all, kind: "all" };
}

function vanPill(name: string): RightNowPill {
  return { text: name, kind: "van" };
}

/**
 * The four tiles, in the order the mockup reads them.
 *
 * A pill names the one thing the number is about: "All" when the fraction is complete, the van
 * that is still open when it is not, and "Family texts" when something is waiting on a person
 * — that is where those tasks are read. A day that was not read gets the zeros and no pill.
 */
export function rightNowTiles(facts: RightNowFacts): readonly RightNowTile[] {
  const known = facts.read;
  const kidsDone = known && facts.toPlace > 0 && facts.placed === facts.toPlace;
  const vansDone = known && facts.vans > 0 && facts.vansChecked === facts.vans;
  const unchecked = known ? facts.uncheckedVans[0] : undefined;
  const late = known ? facts.lateVans[0] : undefined;

  return [
    {
      key: "KIDS_PLACED",
      label: healthNow.kidsPlaced,
      count: known ? facts.placed : 0,
      outOf: known ? facts.toPlace : 0,
      pill: kidsDone ? allPill() : null,
    },
    {
      key: "VANS_CHECKED",
      label: healthNow.vansChecked,
      count: known ? facts.vansChecked : 0,
      outOf: known ? facts.vans : 0,
      pill: vansDone ? allPill() : unchecked ? vanPill(unchecked) : null,
    },
    {
      key: "RUNNING_LATE",
      label: healthNow.runningLate,
      count: known ? facts.lateVans.length : 0,
      outOf: null,
      pill: late ? vanPill(late) : null,
    },
    {
      key: "NEEDS_YOU",
      label: healthNow.needsYou,
      count: known ? facts.needsYou : 0,
      outOf: null,
      pill: known && facts.needsYou > 0 ? { text: nav.familyTexts, kind: "family" } : null,
    },
  ];
}
