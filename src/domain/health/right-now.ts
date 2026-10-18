/**
 * THE FOUR "RIGHT NOW" TILES — Health on Today
 * (png/health-demo-1440.png, png/health-demo-390.png).
 *
 * Firia, 2026-10-17: Health is these four tiles on the Today page, and nothing else. No chart,
 * no Systems row, no Savings row. Hours and money are not a fifth tile: this deployment has
 * no baseline to count them from, so they are absent rather than guessed.
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

/**
 * Which mark the pill draws. The colour is the component's: All is ok, a van and a count of the
 * work left are warn, Family texts is info, None is neutral.
 *
 * `van` is a chip whose text is one van's on-screen name; `count` is a chip that counts the work
 * instead of naming any of it ("3 to check"). They draw the same amber mark, so the chip does not
 * change shape when the last van left becomes the one it names.
 */
export type RightNowPillKind = "all" | "van" | "count" | "family" | "none";

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

function nonePill(): RightNowPill {
  return { text: healthNow.none, kind: "none" };
}

/**
 * The Vans checked chip (Firia, 2026-10-18). The number over it is the fraction either way
 * (0/3, 2/3, 3/3); only the chip changes.
 *
 * Checking the vans is one job with a size, not a queue of named vans: with two or more left the
 * chip says how many and names nobody, because naming the first of three reads as though it were
 * the only one still open. The last one left is worth naming — that is a van somebody can go and
 * check. Every one of them checked is the green All.
 *
 * A site with no vans gets no chip of its own: it has not finished checking them, so `pillFor`
 * gives it the grey None, and so does a day nothing could be read from.
 */
function vansCheckedPill(
  vans: number,
  checked: number,
  unchecked: readonly string[],
): RightNowPill | null {
  if (vans <= 0) return null;
  const left = Math.max(vans - checked, 0);
  if (left === 0) return allPill();
  // One left and its name read: the chip is that van. One left and no name (a fleet row the
  // unchecked query could not name) counts it rather than pointing at nothing.
  if (left === 1 && unchecked[0]) return vanPill(unchecked[0]);
  return { text: fill(healthNow.toCheck, { n: left }), kind: "count" };
}

/** All, a van, or Family texts when there is one. A zero with nothing else to say is None. */
function pillFor(count: number, pill: RightNowPill | null): RightNowPill | null {
  return pill ?? (count === 0 ? nonePill() : null);
}

/**
 * The four tiles, in the order the mockup reads them.
 *
 * A pill says the one thing the number is about: "All" when the fraction is complete, the van
 * that is still open when exactly one is — or how many are left when more than one is, naming
 * none of them (`vansCheckedPill`) — and "Family texts" when something is waiting on a person,
 * which is where those tasks are read. A count of 0 still carries the grey None pill, so a tile
 * at 0 is never a bare number (png/health-demo-1440.png, png/health-demo-390.png). A day that
 * was not read gets the zeros and that same pill, never All.
 */
export function rightNowTiles(facts: RightNowFacts): readonly RightNowTile[] {
  const known = facts.read;
  const placed = known ? facts.placed : 0;
  const toPlace = known ? facts.toPlace : 0;
  const checked = known ? facts.vansChecked : 0;
  const vans = known ? facts.vans : 0;
  const lateCount = known ? facts.lateVans.length : 0;
  const needs = known ? facts.needsYou : 0;
  const kidsDone = known && toPlace > 0 && placed === toPlace;
  const late = known ? facts.lateVans[0] : undefined;

  return [
    {
      key: "KIDS_PLACED",
      label: healthNow.kidsPlaced,
      count: placed,
      outOf: toPlace,
      pill: pillFor(placed, kidsDone ? allPill() : null),
    },
    {
      key: "VANS_CHECKED",
      label: healthNow.vansChecked,
      count: checked,
      outOf: vans,
      pill: pillFor(checked, vansCheckedPill(vans, checked, known ? facts.uncheckedVans : [])),
    },
    {
      key: "RUNNING_LATE",
      label: healthNow.runningLate,
      count: lateCount,
      outOf: null,
      pill: pillFor(lateCount, late ? vanPill(late) : null),
    },
    {
      key: "NEEDS_YOU",
      label: healthNow.needsYou,
      count: needs,
      outOf: null,
      pill: pillFor(needs, known && needs > 0 ? { text: nav.familyTexts, kind: "family" } : null),
    },
  ];
}
