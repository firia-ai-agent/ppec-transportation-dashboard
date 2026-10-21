/**
 * A CHANGE TO ONE LEG'S PLAN, AND WHAT IT DOES TO THE DAY (ledger #76, #77, #79).
 *
 * One pure preview, read by every card that changes a route — a re-plan, a person's or the agent's
 * moves and departures, and a family's agreed time — so what a panel says is what Approve saves:
 *
 *  - named moves first, then Auto-plan's smallest fix if asked, then the agreed times (`holds`:
 *    the van drops that child no earlier) and the departures;
 *  - a van that has **already left** keeps its children and its departure: nobody moves out of it
 *    or into it, and its time cannot change (`VAN_LEFT`) — a waiting van or a reorder is still fine;
 *  - the lines are generated from the board: each departure that moves, each child who moves or
 *    waits with their new time, whether every van fits, how many families are texted.
 */
import { notifyGateConfig } from "@/config/live";
import { hhmmOf, madeLate, minuteOfDay, minutesLate, plannedStopTimes, type Departures } from "@/domain/plan/arrivals";
import { outsideSlots, totalOutside } from "@/domain/plan/slots";
import { autoPlan, ridersInVan, type BoardDay, type BoardPlan, type BoardRider, type Placement } from "@/domain/plan/board";
import { vanVerdicts } from "@/domain/plan/eligibility";
import { vansOver } from "@/modules/plan/place";
import type { loadBoard } from "@/modules/plan/store";
import { fill, planBoard, pluralize, replanDraft } from "@/ui/copy";
import { clockLabel } from "@/ui/service-date";

type BoardView = Awaited<ReturnType<typeof loadBoard>>;

const LATE_MINUTES = notifyGateConfig.shiftSeconds / 60;

export type PlanChange = {
  /**
   * Auto-plan, by name (ledger #87): WHOLE_LEG plans the leg from scratch, as the board's Auto-plan
   * button does; FIX_FIT is the smallest change — only children who no longer fit move (Re-plan).
   */
  readonly auto?: AutoPlanMode;
  readonly moves?: readonly { readonly token: string; readonly bucket: Placement["bucket"]; readonly vanId: string | null }[];
  /** `{ vanId: "HH:MM" }`, today's departures this change sets. */
  readonly departures?: Readonly<Record<string, string>>;
  /** `{ childToken: "HH:MM" }`, times agreed with families: their van drops them no earlier. */
  readonly holds?: Readonly<Record<string, string>>;
  /**
   * `{ childToken: dropAfter }`, where the route puts a child's stop in their van's run (ledger
   * #90): the child whose stop it follows, or `FIRST_STOP`. A route search (`agreed.ts`) sets it
   * so a held stop goes where the wait delays nobody.
   */
  readonly drops?: Readonly<Record<string, string>>;
};

/** A change's moves as a plan save takes them (`savePlanBody`, the card's args). */
export type WireMove = { child_token: string; bucket: Placement["bucket"]; van_id: string | null; not_before?: string; drop_after?: string };

export type PlanPreview =
  | {
      readonly ok: true;
      readonly next: BoardPlan;
      readonly departs: Departures;
      /** The departures that actually move, `{ vanId: "HH:MM" }`. */
      readonly departures: Readonly<Record<string, string>>;
      readonly moves: readonly WireMove[];
      readonly lines: readonly string[];
      /** Children the change leaves with no van, by name. */
      readonly stranded: readonly string[];
      /** Families the change makes late (never one whose time was agreed), and every van fits. */
      readonly madeLate: number;
      readonly allFit: boolean;
      /** Minutes the change adds to everybody else's drop-off, summed. */
      readonly addedMinutes: number;
      /** How far past a time agreed with a family the van gets there, in minutes; 0 when on it. */
      readonly agreedLate: number;
      /** Minutes every child with an approved slot falls outside it, summed (ledger #84); 0 inside. */
      readonly outsideMinutes: number;
    }
  | { readonly ok: false; readonly reason: "NOTHING_TO_CHANGE" }
  | { readonly ok: false; readonly reason: "NO_VAN_FITS"; readonly children: readonly string[] };


export type AutoPlanMode = "WHOLE_LEG" | "FIX_FIT";

/**
 * THE SMALLEST RE-PLAN THAT WORKS. A colleague moves the children the problem is about, not the
 * whole afternoon: everybody still fitting the van they are in stays put (pinned for this search),
 * and Auto-plan places only the ones who no longer fit. Only if that leaves somebody without a van
 * that a full Auto-plan would have placed is the whole leg planned again.
 */
export function smallestReplan(day: BoardDay, plan: BoardPlan): BoardPlan {
  const keep: Record<string, Placement> = { ...plan };
  for (const van of day.vans) {
    for (const verdict of vanVerdicts(van.setup, ridersInVan(day, plan, van.id))) {
      if (verdict.reason === null) keep[verdict.token] = { ...plan[verdict.token], pinned: true };
    }
  }
  const placed = autoPlan(day, keep);
  // The pins were this search's, not the planner's: put back what the saved plan said.
  const smallest: Record<string, Placement> = Object.fromEntries(
    Object.entries(placed).map(([token, p]) => [token, { ...p, pinned: plan[token]?.pinned ?? false }]),
  );
  const unplaced = (p: BoardPlan) => day.riders.filter((r) => p[r.token]?.bucket === "UNASSIGNED").length;
  const full = autoPlan(day, plan);
  return unplaced(smallest) <= unplaced(full) ? smallest : full;
}

export function previewPlanChange(view: BoardView, change: PlanChange): PlanPreview {
  const named: Record<string, Placement> = { ...view.plan };
  for (const m of change.moves ?? []) {
    if (!named[m.token]) continue;
    // A stop's place belongs to the van it was chosen in: a move to another van starts from its window.
    const { dropAfter, ...rest } = named[m.token];
    const sameVan = m.bucket === "VAN" && m.vanId === rest.vanId;
    named[m.token] = { ...rest, ...(dropAfter && sameVan ? { dropAfter } : {}), bucket: m.bucket, vanId: m.bucket === "VAN" ? m.vanId : null, pinned: true };
  }
  const mode = change.auto ?? null;
  const next: Record<string, Placement> = {
    ...(mode === "WHOLE_LEG" ? autoPlan(view.day, named) : mode === "FIX_FIT" ? smallestReplan(view.day, named) : named),
  };
  for (const [token, hhmm] of Object.entries(change.holds ?? {})) {
    if (next[token] && minuteOfDay(hhmm) !== null) next[token] = { ...next[token], notBefore: hhmm };
  }
  for (const [token, after] of Object.entries(change.drops ?? {})) {
    if (next[token]?.bucket === "VAN") next[token] = { ...next[token], dropAfter: after };
  }
  const departs: Record<string, number> = { ...view.departs };
  const departures: Record<string, string> = {};
  for (const [vanId, hhmm] of Object.entries(change.departures ?? {})) {
    const minute = minuteOfDay(hhmm);
    if (minute === null || !(vanId in departs) || departs[vanId] === minute) continue;
    departs[vanId] = minute;
    departures[vanId] = hhmm;
  }

  const was = (r: BoardRider) => view.plan[r.token];
  const moved = view.day.riders.filter((r) => was(r)?.bucket !== next[r.token]?.bucket || was(r)?.vanId !== next[r.token]?.vanId);
  const held = view.day.riders.filter(
    (r) => !moved.includes(r) &&
      ((was(r)?.notBefore ?? null) !== (next[r.token]?.notBefore ?? null) || (was(r)?.dropAfter ?? null) !== (next[r.token]?.dropAfter ?? null)),
  );
  if (moved.length === 0 && held.length === 0 && Object.keys(departures).length === 0) return { ok: false, reason: "NOTHING_TO_CHANGE" };

  const stranded = moved.filter((r) => next[r.token]?.bucket === "UNASSIGNED");
  if (mode !== null && Object.keys(departures).length === 0 && held.length === 0 && stranded.length === moved.length) {
    return { ok: false, reason: "NO_VAN_FITS", children: stranded.map((r) => r.name) };
  }

  const vanName = (id: string | null | undefined) => view.day.vans.find((v) => v.id === id)?.name ?? replanDraft.noVan;
  const at = (minute: number | undefined) => (minute === undefined ? "" : clockLabel(hhmmOf(Math.round(minute))));
  const after = plannedStopTimes(view.day, next, departs);

  const lines = Object.keys(departures).map((vanId) =>
    fill(replanDraft.leaves, { van: vanName(vanId), time: clockLabel(departures[vanId]), was: at(view.departs[vanId]) }),
  );
  let agreedLate = 0;
  for (const rider of [...moved.filter((r) => next[r.token]?.bucket !== "UNASSIGNED"), ...held]) {
    const time = after.get(rider.token)?.arrivesAtMinute;
    const agreed = minuteOfDay(next[rider.token]?.notBefore ?? "");
    if (agreed !== null && time !== undefined) {
      // The honest result against the time the family was promised: the van waits for it, gets
      // there on it, or gets there after it — said in those words, never rounded into a promise.
      const past = Math.round(time - agreed);
      agreedLate = Math.max(agreedLate, past);
      if (moved.includes(rider)) lines.push(fill(replanDraft.moved, { child: rider.name, from: vanName(was(rider)?.vanId), to: vanName(next[rider.token]?.vanId), time: at(time) }));
      lines.push(
        past <= 0
          ? fill(replanDraft.waits, { van: vanName(next[rider.token]?.vanId), child: rider.name, time: at(agreed) })
          : fill(replanDraft.afterAgreed, { child: rider.name, time: at(time), late: past }),
      );
      continue;
    }
    const late = minutesLate(rider.window, time);
    const to = next[rider.token]?.bucket === "VAN" ? vanName(next[rider.token]?.vanId) : placeWord(next[rider.token]?.bucket);
    lines.push(
      fill(late !== null && late >= LATE_MINUTES ? replanDraft.movedLate : replanDraft.moved, {
        child: rider.name, from: vanName(was(rider)?.vanId), to, time: at(time), late: late === null ? 0 : Math.round(late),
      }).replace(/ · ≈ $/, ""),
    );
  }
  // A time a family agreed (ledger #84): every child the change puts further outside their slot.
  const outsideBefore = outsideSlots(view.day, view.plan, view.departs);
  const outsideAfter = outsideSlots(view.day, next, departs);
  for (const rider of view.day.riders) {
    const off = outsideAfter.get(rider.token);
    if (off === undefined || off <= (outsideBefore.get(rider.token) ?? 0)) continue;
    const slot = rider.slots?.[0];
    if (!slot) continue;
    lines.push(fill(replanDraft.outsideSlot, {
      child: rider.name, time: at(after.get(rider.token)?.arrivesAtMinute),
      start: clockLabel(slot.start), end: clockLabel(slot.end),
    }));
  }
  const outsideMinutes = totalOutside(outsideAfter);
  const over = vansOver(view, next).map((id) => vanName(id));
  lines.push(
    stranded.length > 0
      ? fill(replanDraft.stillNeedsRide, { children: stranded.map((r) => r.name).join(", ") })
      : over.length === 0
        ? replanDraft.everyVanFits
        : fill(replanDraft.stillOver, { vans: over.join(", ") }),
  );
  // Families made late by the change — never the family who asked for the time.
  const late = madeLate(view.day, view.plan, next, LATE_MINUTES, { before: view.departs, after: departs })
    .filter((l) => !(change.holds && l.token in change.holds));
  if (late.length > 0) lines.push(fill(replanDraft.texted, { families: pluralize(late.length, replanDraft.family) }));

  const moves: WireMove[] = [...moved, ...held].map((r) => ({
    child_token: r.token,
    bucket: next[r.token].bucket,
    van_id: next[r.token].vanId,
    ...(next[r.token].notBefore ? { not_before: next[r.token].notBefore! } : {}),
    ...(next[r.token].dropAfter ? { drop_after: next[r.token].dropAfter! } : {}),
  }));
  const before = plannedStopTimes(view.day, view.plan, view.departs);
  const addedMinutes = view.day.riders
    .filter((r) => !(change.holds && r.token in change.holds))
    .reduce((sum, r) => sum + Math.max(0, (after.get(r.token)?.arrivesAtMinute ?? 0) - (before.get(r.token)?.arrivesAtMinute ?? Infinity)), 0);
  return {
    ok: true, next, departs, departures, moves, lines, stranded: stranded.map((r) => r.name),
    madeLate: late.length, allFit: stranded.length === 0 && over.length === 0, addedMinutes, agreedLate, outsideMinutes,
  };
}

/** "Unassigned", "Family drives", "Absent" — the board's own lane names. */
const PLACE_WORDS: Readonly<Record<string, string>> = {
  UNASSIGNED: planBoard.unassigned,
  FAMILY_DRIVES: planBoard.familyDrives,
  ABSENT: planBoard.absent,
};
const placeWord = (bucket: Placement["bucket"] | undefined) => PLACE_WORDS[bucket ?? ""] ?? replanDraft.noVan;
