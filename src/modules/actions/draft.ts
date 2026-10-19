/**
 * RE-PLAN AS A DRAFT A PERSON APPROVES (ledger #76).
 *
 * Whoever asks for a re-plan — a person pressing Re-plan at the ramp, the agent asked to, or the
 * agent hearing a van-short alert — gets the same thing: Auto-plan run over the saved plan, and the
 * result written as **one card** that says what it would change and what that does to the day.
 * Nothing is saved until a person presses Approve on it (`confirm.ts` runs `save_plan` with exactly
 * these moves) or saves the board themselves, which withdraws the card (`STALE_PLAN_CARD_SQL`).
 *
 * The card's words are generated from the plan, never written by hand: one line per child who
 * moves, with the van they move from and to, their new estimated time and how far past their
 * family's window that is (`domain/plan/arrivals.ts` — the same numbers the board shows and the
 * late texts send); then whether every van fits; then how many families would be texted.
 */
import { createHash } from "node:crypto";
import { notifyGateConfig } from "@/config/live";
import type { Exec } from "@/db/exec";
import type { Direction } from "@/domain/day/leg";
import { hhmmOf, madeLate, minuteOfDay, minutesLate, plannedStopTimes } from "@/domain/plan/arrivals";
import { autoPlan, ridersInVan, type BoardDay, type BoardPlan, type Placement } from "@/domain/plan/board";
import { vanVerdicts } from "@/domain/plan/eligibility";
import { effectId, raiseTask } from "@/modules/agent/run/exec/effects";
import { vansOver } from "@/modules/plan/place";
import { loadBoard } from "@/modules/plan/store";
import type { DayDataSource } from "@/domain/day/source";
import type { PlanStore } from "@/modules/plan/types";
import { agentTasks, fill, planBoard, pluralize, replanDraft } from "@/ui/copy";
import { clockLabel } from "@/ui/service-date";
import { STAFF_ACTION_KIND } from "./confirm-view";

/** `ops.task.category` a card hangs on (the agent's proposal writer uses the same one). */
export const STAFF_ACTION_TASK_CATEGORY = "STAFF_ACTION";

const LEG_WORDS: Readonly<Record<Direction, string>> = { AM: "morning", PM: "afternoon" };
const LATE_MINUTES = notifyGateConfig.shiftSeconds / 60;

export type DraftOutcome =
  | { readonly drafted: true; readonly approvalId: string; readonly impact?: readonly string[] }
  | { readonly drafted: false; readonly reason: "NOTHING_TO_CHANGE" }
  /** Nobody can be moved to a van that fits them: nothing to approve, a family to call. */
  | { readonly drafted: false; readonly reason: "NO_VAN_FITS"; readonly children: readonly string[] };

/** One confirm card: the task it hangs on and the approval a person decides. Idempotent on `key`. */
export async function writeStaffActionCard(
  tx: Exec,
  a: {
    readonly siteId: string;
    readonly key: string;
    readonly by: string;
    readonly tool: string;
    readonly action: string;
    readonly args: Record<string, unknown>;
    readonly summary: string;
    readonly note?: string | null;
    readonly impact?: readonly string[];
    readonly approvalKey?: string;
  },
): Promise<string> {
  const taskId = await raiseTask(tx, {
    id: effectId(a.key, "exception"),
    siteId: a.siteId,
    category: STAFF_ACTION_TASK_CATEGORY,
    severity: "AMBER",
    words: agentTasks.proposedStaffAction,
    by: a.by,
  });
  const approvalId = effectId(a.key, "approval");
  await tx.query(
    `INSERT INTO ops.approval_request (id, site_id, task_id, proposal, created_by, updated_by, source_mode)
     VALUES ($1, $2, $3, $4::jsonb, $5, $5, 'SIMULATED')
     ON CONFLICT (id) DO NOTHING`,
    [
      approvalId,
      a.siteId,
      taskId,
      JSON.stringify({
        kind: STAFF_ACTION_KIND,
        tool: a.tool,
        action: a.action,
        args: a.args,
        summary: a.summary,
        ...(a.note && a.note.trim() ? { note: a.note.trim() } : {}),
        ...(a.impact && a.impact.length > 0 ? { impact: a.impact } : {}),
        ...(a.approvalKey ? { approval_key: a.approvalKey } : {}),
      }),
      a.by,
    ],
  );
  return approvalId;
}

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

/**
 * A change to one leg's plan, as a person or the agent asks for it (ledger #77): Auto-plan's
 * smallest fix, named moves, new departure times — or any mix. Children by token; vans by id.
 */
export type PlanChange = {
  readonly replan?: boolean;
  readonly moves?: readonly { readonly token: string; readonly bucket: Placement["bucket"]; readonly vanId: string | null }[];
  /** `{ vanId: "HH:MM" }`, today's departures this change sets. */
  readonly departures?: Readonly<Record<string, string>>;
};

/**
 * Auto-plan this leg as a draft card. `by` is who asked (`staff:<id>` or `agent:<run>`); `note` the
 * model's own sentence when the agent drafted it. A plan that Auto-plan would not change is no
 * card at all: there is nothing for anybody to approve.
 */
export function draftReplan(
  db: Exec,
  deps: { readonly store: PlanStore; readonly source: DayDataSource },
  a: { readonly siteId: string; readonly date: string; readonly leg: Direction; readonly by: string; readonly note?: string | null },
): Promise<DraftOutcome> {
  return draftPlanChange(db, deps, { ...a, change: { replan: true } });
}

/**
 * ANY PLAN CHANGE AS ONE CARD (ledger #77): the change applied to the board in memory — named moves
 * first, then Auto-plan's smallest fix if asked, then the departures — and the card says what that
 * does: each departure that moves, each child who moves with their new time, whether every van
 * fits, how many families would be texted. Approve is the board's own Save of exactly that.
 */
export async function draftPlanChange(
  db: Exec,
  deps: { readonly store: PlanStore; readonly source: DayDataSource },
  a: {
    readonly siteId: string;
    readonly date: string;
    readonly leg: Direction;
    readonly by: string;
    readonly note?: string | null;
    /** The change, or how to read it off the board as it stands (van names → this day's van ids). */
    readonly change: PlanChange | ((view: Awaited<ReturnType<typeof loadBoard>>) => PlanChange);
  },
): Promise<DraftOutcome> {
  const view = await loadBoard(deps.store, a.siteId, a.date, a.leg, deps.source);
  const change = typeof a.change === "function" ? a.change(view) : a.change;
  const named: Record<string, Placement> = { ...view.plan };
  for (const m of change.moves ?? []) {
    if (!named[m.token]) continue;
    named[m.token] = { ...named[m.token], bucket: m.bucket, vanId: m.bucket === "VAN" ? m.vanId : null, pinned: true };
  }
  const next = change.replan ? smallestReplan(view.day, named) : named;
  const departs: Record<string, number> = { ...view.departs };
  const departures: Record<string, string> = {};
  for (const [vanId, hhmm] of Object.entries(change.departures ?? {})) {
    const minute = minuteOfDay(hhmm);
    if (minute === null || !(vanId in departs) || departs[vanId] === minute) continue;
    departs[vanId] = minute;
    departures[vanId] = hhmm;
  }
  const moved = view.day.riders.filter(
    (r) => view.plan[r.token]?.bucket !== next[r.token]?.bucket || view.plan[r.token]?.vanId !== next[r.token]?.vanId,
  );
  const leaves = Object.keys(departures);
  if (moved.length === 0 && leaves.length === 0) return { drafted: false, reason: "NOTHING_TO_CHANGE" };

  const vanName = (id: string | null | undefined) => view.day.vans.find((v) => v.id === id)?.name ?? replanDraft.noVan;
  const after = plannedStopTimes(view.day, next, departs);
  // Whoever no van can carry today is said plainly, never folded into "every van fits" — and a
  // "re-plan" that only takes children out of vans is no plan to approve: say who, and stop.
  const stranded = moved.filter((rider) => next[rider.token]?.bucket === "UNASSIGNED");
  if (change.replan && leaves.length === 0 && stranded.length === moved.length) {
    await withdrawOlderDrafts(db, a, null);
    return { drafted: false, reason: "NO_VAN_FITS", children: stranded.map((r) => r.name) };
  }
  const impact = leaves.map((vanId) =>
    fill(replanDraft.leaves, { van: vanName(vanId), time: clockLabel(departures[vanId]), was: clockLabel(hhmmOf(view.departs[vanId])) }),
  );
  for (const rider of moved.filter((r) => next[r.token]?.bucket !== "UNASSIGNED")) {
    const at = after.get(rider.token)?.arrivesAtMinute;
    const late = minutesLate(rider.window, at);
    const to = next[rider.token]?.bucket === "VAN" ? vanName(next[rider.token]?.vanId) : placeWord(next[rider.token]?.bucket);
    impact.push(fill(late !== null && late >= LATE_MINUTES ? replanDraft.movedLate : replanDraft.moved, {
      child: rider.name,
      from: vanName(view.plan[rider.token]?.vanId),
      to,
      time: at === undefined ? "" : clockLabel(hhmmOf(Math.round(at))),
      late: late === null ? 0 : Math.round(late),
    }).replace(/ · ≈ $/, ""));
  }
  const over = vansOver(view, next).map((id) => vanName(id));
  impact.push(
    stranded.length > 0
      ? fill(replanDraft.stillNeedsRide, { children: stranded.map((r) => r.name).join(", ") })
      : over.length === 0
        ? replanDraft.everyVanFits
        : fill(replanDraft.stillOver, { vans: over.join(", ") }),
  );
  const texted = madeLate(view.day, view.plan, next, LATE_MINUTES, { before: view.departs, after: departs }).length;
  if (texted > 0) impact.push(fill(replanDraft.texted, { families: pluralize(texted, replanDraft.family) }));

  const moves = moved.map((r) => ({ child_token: r.token, bucket: next[r.token].bucket, van_id: next[r.token].vanId }));
  // One draft per board version and result: pressing Re-plan twice, or the agent and a person
  // both asking, is the same card rather than two to decide.
  const key = `replan-draft:${a.siteId}:${a.date}:${a.leg}:${view.version}:${createHash("sha256").update(JSON.stringify([moves, departures])).digest("hex").slice(0, 16)}`;
  await withdrawOlderDrafts(db, a, effectId(key, "approval"));
  const approvalId = await writeStaffActionCard(db, {
    siteId: a.siteId,
    key,
    by: a.by,
    tool: "save_plan",
    action: "save_plan",
    args: { date: a.date, leg: a.leg, moves, ...(leaves.length > 0 ? { departures } : {}) },
    summary: fill(change.replan && !change.moves?.length && leaves.length === 0 ? replanDraft.title : replanDraft.changeTitle, { leg: LEG_WORDS[a.leg] }),
    note: a.note,
    impact,
  });
  return { drafted: true, approvalId, impact };
}

/** "Unassigned", "Family drives", "Absent" — the board's own lane names. */
const PLACE_WORDS: Readonly<Record<string, string>> = {
  UNASSIGNED: planBoard.unassigned,
  FAMILY_DRIVES: planBoard.familyDrives,
  ABSENT: planBoard.absent,
};
const placeWord = (bucket: Placement["bucket"] | undefined) => PLACE_WORDS[bucket ?? ""] ?? replanDraft.noVan;

/** Older drafts of this leg stand down: the situation they were drafted for has moved on. */
async function withdrawOlderDrafts(
  db: Exec,
  a: { readonly siteId: string; readonly date: string; readonly leg: Direction; readonly by: string },
  keep: string | null,
): Promise<void> {
  // One draft per leg on screen: a newer one replaces any still waiting, so there is never a choice
  // between two re-plans of the same afternoon.
  await db.query(
    `UPDATE ops.approval_request SET decided_at = now(), decision = 'DECLINED', updated_at = now(), updated_by = $4, version = version + 1
      WHERE site_id = $1 AND decided_at IS NULL AND proposal->>'kind' = $5 AND proposal->>'tool' = 'save_plan'
        AND proposal->'args'->>'date' = $2 AND proposal->'args'->>'leg' = $3 AND id <> $6`,
    [a.siteId, a.date, a.leg, a.by, STAFF_ACTION_KIND, keep ?? "00000000-0000-0000-0000-000000000000"],
  );
}
