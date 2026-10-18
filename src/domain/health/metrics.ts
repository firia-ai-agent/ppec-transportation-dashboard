/**
 * Today, counted — SURF-07's numbers (PRD §14 l.1064, §17.1, DESIGN-DIRECTION §4.6).
 *
 * Four numbers, each one a count over the **same board the Today screen reads**
 * (src/domain/board), and each one carrying the rides it was counted from. Nothing here holds a
 * figure of its own: no baseline, no rate, no dollar amount, no assumed coordinator minute. §17.3
 * gives formulas whose inputs are a four-week time-and-motion baseline and provider invoices
 * (§17.4), and this deployment has neither — so the honest version of a ROI panel on a demo day
 * is the day's own counts with the cohort named under them, and that is what this module
 * computes. §17.2's rule, written for cash, is the same rule: a number nobody measured is not a
 * number.
 *
 * Which §17.1 metrics these are, and why these four:
 *  - `CHILDREN_PLACED` is MET-07's own question asked before the van arrives rather than at it
 *    ("mismatch discovered at vehicle"): the capacity solver has either found every child a
 *    place or it has not, and the shortfall is the one number that must never hide inside a
 *    percentage.
 *  - `VAN_UNCHECKED` is MET-07's source — PRD §6.3's rule that a manifest is locked only on a
 *    van somebody checked — counted as the rides still waiting on that check.
 *  - `ARRIVING_LATE` is MET-08 (on-time; ETA error), measured the way MET-08 defines it: against
 *    the window first published for the ride, which is what `RideView.deltaSeconds` is.
 *  - `NEEDS_A_PERSON` is MET-05 (exception resolution; EOD unresolved), which on a board read
 *    mid-morning is the count of rides nothing will close on its own.
 *
 * What is deliberately *not* counted here: MET-01 coordination minutes, MET-02 chasing volume,
 * MET-06 avoidable journeys, MET-09 preserved attendance and MET-10 operating cost. Every one of
 * them needs a measured baseline or an invoice (they are P2 in §17.1's own phase column), and a
 * screen that printed them from an assumption would be the one thing a ROI panel must not do.
 *
 * The two a founder asks for by name — hours saved and money saved — are not simply missing from
 * the screen, though, because an absent row is read as an oversight and invites somebody to fill
 * it in with a guess. They are `BASELINE_ROWS` below: rows with a label, no number at all, and
 * the sentence that says when a number could exist (§17.4's four-week baseline). Saying "not
 * measured yet" out loud is the claim this panel can defend; a figure would not be.
 *
 * Pure and deterministic: a `Board` in, counts out. No clock, no database, no network — the
 * board already fixed the instant.
 */

import type { Board, LegRow } from "@/domain/board/board";

/**
 * The four numbers, in the order they are read. The order is the argument: every child has a
 * place, these vans are not checked yet, these arrivals have moved, and this is what is left for
 * a person — safety first, then what is open.
 */
export const ROI_METRICS = [
  "CHILDREN_PLACED",
  "VAN_UNCHECKED",
  "ARRIVING_LATE",
  "NEEDS_A_PERSON",
] as const;
export type RoiMetricKey = (typeof ROI_METRICS)[number];

/**
 * The two savings this deployment cannot count, in the order they are asked for.
 *
 * `HOURS_SAVED` is §17.3's reclaimed hours, whose inputs are MET-01's per-change coordination
 * minutes before and after; `MONEY_SAVED` is its NetCash, whose inputs are §17.2's payroll and
 * invoice evidence and MET-10's operating cost. Both start from a measurement this build has
 * never taken: §17.4's four-week baseline. So neither has a value field, here or anywhere — the
 * type is a key and a reading order, the words are in `health.baseline`, and there is nothing in
 * this module for a later change to quietly populate with an assumption.
 */
export const BASELINE_ROWS = ["HOURS_SAVED", "MONEY_SAVED"] as const;
export type BaselineRowKey = (typeof BASELINE_ROWS)[number];

export type RoiMetric = {
  key: RoiMetricKey;
  /** The number the sentence leads with. */
  count: number;
  /** What the count is out of, or null when the number stands on its own. */
  outOf: number | null;
  /**
   * The rides behind `count`, by board leg key, in board order — the drill-down, and the reason
   * this module returns keys rather than numbers alone. A number whose rides cannot be opened is
   * a number nobody can check (AT-15: ROI instrumentation **with drill-down**).
   */
  legKeys: readonly string[];
  /** The children behind `count`, labelled, in board order with no repeats. */
  children: readonly string[];
  /**
   * The one extra number a sentence needs: the furthest an arrival has moved, in whole minutes.
   * Null on every other metric, and on this one when no arrival has moved at all.
   */
  minutes: number | null;
};

export type DayCounts = {
  /** The service day these counts are about, and the instant they were taken at. */
  dayIso: string;
  nowMs: number;
  metrics: readonly RoiMetric[];
  /** SURF-07's sample size: the cohort every number above was counted over. */
  children: number;
  rides: number;
};

/** A ride we are driving: the family brings the child otherwise, and there is no van to count. */
function onAVan(leg: LegRow): boolean {
  return leg.ride.vehicleLabel !== null;
}

/**
 * The solver could not seat this ride's riders in this ride's van.
 *
 * Both unseatable verdicts, not just `INFEASIBLE`: a van that is not available today leaves its
 * riders exactly as unplaced as one whose seats do not fit them. Every other verdict — feasible,
 * or still waiting on a capability report — is not a refusal and must not be counted as one.
 */
function hasNoSeat(leg: LegRow): boolean {
  return leg.ride.solver === "INFEASIBLE" || leg.ride.solver === "VEHICLE_UNAVAILABLE";
}

/** Child labels in board order, each once. */
function childrenOf(legs: readonly LegRow[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const leg of legs) {
    if (seen.has(leg.child.childKey)) continue;
    seen.add(leg.child.childKey);
    out.push(leg.child.childLabel);
  }
  return out;
}

function metricFor(
  key: RoiMetricKey,
  counted: readonly LegRow[],
  outOf: number | null,
  count = counted.length,
  minutes: number | null = null,
): RoiMetric {
  return {
    key,
    count,
    outOf,
    legKeys: counted.map((leg) => leg.key),
    children: childrenOf(counted),
    minutes,
  };
}

/**
 * Children with a seat (MET-07, asked of the plan rather than of the kerb).
 *
 * Per child and not per ride, because a child with a seat in the morning and none in the
 * afternoon has not been placed: the question is whether the day holds together for them. The
 * rides behind the number are that child's own rides, so opening it lands on the day the number
 * is about.
 */
function childrenPlaced(board: Board): RoiMetric {
  const riding = board.legs.filter(onAVan);
  const unplacedKeys = new Set(riding.filter(hasNoSeat).map((leg) => leg.child.childKey));
  const placed = riding.filter((leg) => !unplacedKeys.has(leg.child.childKey));
  const ridingChildren = new Set(riding.map((leg) => leg.child.childKey));
  return metricFor(
    "CHILDREN_PLACED",
    placed,
    ridingChildren.size,
    ridingChildren.size - unplacedKeys.size,
  );
}

/**
 * Rides still waiting on a van check (PRD §6.3, MET-07's source).
 *
 * A capability that is `UNKNOWN` or `REPORTED` is not a check: §6.3 lets only staff verify one,
 * and the whole of AT-04 is that a van's configuration is unknown until somebody at the ramp
 * says otherwise. So the count is every ride on a van whose check is not verified — which on a
 * board read mid-morning is most of the afternoon, because the request goes out ninety minutes
 * before the run (§18.2 step 5). Saying that out loud is the point of the number.
 */
function vanUnchecked(board: Board): RoiMetric {
  const riding = board.legs.filter(onAVan);
  return metricFor(
    "VAN_UNCHECKED",
    riding.filter((leg) => leg.ride.capability !== "VERIFIED"),
    riding.length,
  );
}

/**
 * Rides arriving later than planned (MET-08).
 *
 * `deltaSeconds` is the ride's current estimate minus the window **first published** for it,
 * which is MET-08's own definition ("ETA at T−15/T−30 vs actual") as far as a board can take it,
 * and it is null on every ride nothing has moved yet. So the denominator is the rides a shift can
 * be measured on at all — not all 56 — because a ride with no published window is not on time
 * and is not late either.
 *
 * `minutes` is the furthest of them, rounded to a whole minute: the one number a coordinator
 * reads first, and the only one the sentence needs beyond the count.
 */
function arrivingLate(board: Board): RoiMetric {
  const measurable = board.legs.filter((leg) => leg.ride.deltaSeconds !== null);
  const late = measurable.filter((leg) => (leg.ride.deltaSeconds ?? 0) > 0);
  const worst = late.reduce((max, leg) => Math.max(max, leg.ride.deltaSeconds ?? 0), 0);
  return metricFor(
    "ARRIVING_LATE",
    late,
    measurable.length,
    late.length,
    late.length === 0 ? null : Math.round(worst / 60),
  );
}

/**
 * Rides that need a person (MET-05).
 *
 * The board's own needs-action group, counted — not a second rule here that could disagree with
 * the one the board ranks its rows by. Out of every ride on the day, which is what the board's
 * own "Showing 56 of 56 rides" counts, so the two screens cannot report different denominators
 * for the same day.
 */
function needsAPerson(board: Board): RoiMetric {
  return metricFor(
    "NEEDS_A_PERSON",
    board.legs.filter((leg) => leg.group === "NEEDS_ACTION"),
    board.legs.length,
  );
}

/** The four numbers for one board, with the cohort they were counted over. */
export function dayCounts(board: Board): DayCounts {
  return {
    dayIso: board.day.iso,
    nowMs: board.nowMs,
    metrics: [
      childrenPlaced(board),
      vanUnchecked(board),
      arrivingLate(board),
      needsAPerson(board),
    ],
    children: board.rows.length,
    rides: board.legs.length,
  };
}

/** One metric by key, for a screen that has a number and wants the rides under it. */
export function metricByKey(counts: DayCounts, key: RoiMetricKey): RoiMetric {
  const found = counts.metrics.find((m) => m.key === key);
  if (!found) throw new Error(`no ${key} in today's counts`);
  return found;
}

/** The rides one number was counted from, as board rows, in board order. */
export function ridesBehind(board: Board, metric: RoiMetric): readonly LegRow[] {
  const wanted = new Set(metric.legKeys);
  return board.legs.filter((leg) => wanted.has(leg.key));
}
