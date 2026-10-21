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
import type { Exec } from "@/db/exec";
import type { Direction } from "@/domain/day/leg";
import { effectId, raiseTask } from "@/modules/agent/run/exec/effects";
import { previewPlanChange, type PlanChange } from "@/modules/changes/plan-change";
import { rehearsePlanSave } from "@/modules/changes/rehearse";
import type { Refusal } from "@/modules/changes/refusal";
import { loadBoard } from "@/modules/plan/store";
import type { DayDataSource } from "@/domain/day/source";
import type { PlanStore } from "@/modules/plan/types";
import { agentTasks, fill, replanDraft } from "@/ui/copy";
import { STAFF_ACTION_KIND } from "./confirm-view";

/** `ops.task.category` a card hangs on (the agent's proposal writer uses the same one). */
export const STAFF_ACTION_TASK_CATEGORY = "STAFF_ACTION";

const LEG_WORDS: Readonly<Record<Direction, string>> = { AM: "morning", PM: "afternoon" };

export type DraftOutcome =
  | { readonly drafted: true; readonly approvalId: string; readonly impact?: readonly string[] }
  | { readonly drafted: false; readonly reason: "NOTHING_TO_CHANGE" }
  /** The board would not take it: its own reason, the van and child it names (ledger #80). */
  | { readonly drafted: false; readonly reason: "REFUSED"; readonly refusal: Refusal }
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

export { smallestReplan, type PlanChange } from "@/modules/changes/plan-change";

/**
 * Auto-plan this leg as a draft card. `by` is who asked (`staff:<id>` or `agent:<run>`); `note` the
 * model's own sentence when the agent drafted it. A plan that Auto-plan would not change is no
 * card at all: there is nothing for anybody to approve.
 */
export function draftReplan(
  db: Exec,
  deps: { readonly store: PlanStore; readonly source: DayDataSource },
  a: { readonly siteId: string; readonly date: string; readonly leg: Direction; readonly by: string; readonly note?: string | null; readonly now?: Date },
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
    /** The wall clock the rehearsal saves at. */
    readonly now?: Date;
    /** The change, or how to read it off the board as it stands (van names → this day's van ids). */
    readonly change: PlanChange | ((view: Awaited<ReturnType<typeof loadBoard>>) => PlanChange);
  },
): Promise<DraftOutcome> {
  const view = await loadBoard(deps.store, a.siteId, a.date, a.leg, deps.source);
  const change = typeof a.change === "function" ? a.change(view) : a.change;
  const preview = previewPlanChange(view, change);
  if (!preview.ok) {
    // Whoever no van can carry today is said plainly, with no card to approve.
    if (preview.reason === "NO_VAN_FITS") await withdrawOlderDrafts(db, a, null);
    return preview.reason === "NO_VAN_FITS"
      ? { drafted: false, reason: "NO_VAN_FITS", children: preview.children }
      : { drafted: false, reason: preview.reason };
  }
  const departures = preview.departures;
  const leaves = Object.keys(departures);
  // Rehearse it first (ledger #80): a card is only ever a change Approve can make. When the board
  // would refuse, its own reason comes back instead — to the agent as feedback, to a person in words.
  const refused = await rehearsePlanSave(db, deps, {
    siteId: a.siteId, date: a.date, leg: a.leg, moves: preview.moves, departures, now: a.now ?? new Date(),
  });
  if (refused) return { drafted: false, reason: "REFUSED", refusal: refused };
  // One draft per board version and result: pressing Re-plan twice, or the agent and a person
  // both asking, is the same card rather than two to decide.
  const key = `replan-draft:${a.siteId}:${a.date}:${a.leg}:${view.version}:${createHash("sha256").update(JSON.stringify([preview.moves, departures])).digest("hex").slice(0, 16)}`;
  await withdrawOlderDrafts(db, a, effectId(key, "approval"));
  const approvalId = await writeStaffActionCard(db, {
    siteId: a.siteId,
    key,
    by: a.by,
    tool: "save_plan",
    action: "save_plan",
    // `basis_version`: the board this card was drafted on. A save past it makes the card stale (by
    // version, not by clock — a save's `now()` is its transaction's start), and Approve saves against it.
    args: { date: a.date, leg: a.leg, moves: preview.moves, ...(leaves.length > 0 ? { departures } : {}), basis_version: view.version },
    summary: fill(change.replan && !change.moves?.length && leaves.length === 0 ? replanDraft.title : replanDraft.changeTitle, { leg: LEG_WORDS[a.leg] }),
    note: a.note,
    impact: preview.lines,
  });
  return { drafted: true, approvalId, impact: preview.lines };
}

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
