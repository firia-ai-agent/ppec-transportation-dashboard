/**
 * A VAN THAT NO LONGER CARRIES ITS RIDERS IS AN ALERT (ledger #74 e).
 *
 * The board already *shows* it — the ramp's "won't fit" banner, a van marked over on Plan routes —
 * but a computed fact reaches nobody who is not looking, and it never reached the agent at all. So
 * when the ramp confirms a van's counts and the saved plan no longer fits them, this rule raises
 * one staff alert (`VAN_SHORT`, RED) for that van and leg, which starts the agent on it
 * (`agent/alerts.ts`): it can propose the re-plan as a card a person confirms.
 *
 * One alert per van, leg, date and setup: the id is derived from those, so confirming the same
 * counts again raises nothing new, and a different shortfall is a new alert.
 */
import { createHash } from "node:crypto";
import type { Db } from "@/db/exec";
import type { Direction } from "@/domain/day/leg";
import type { DayDataSource } from "@/domain/day/source";
import { ALERT_TRIGGER, raiseStaffAlert } from "@/modules/agent/alerts";
import type { AgentWakeTransport } from "@/modules/agent/run/queue";
import { effectId } from "@/modules/agent/run/exec/effects";
import { fill, vanShortAlert } from "@/ui/copy";
import { ridersInVan } from "@/domain/plan/board";
import { vanVerdicts } from "@/domain/plan/eligibility";
import { vansOver } from "./place";
import { loadBoard } from "./store";
import type { PlanStore } from "./types";

export const VAN_SHORT_TASK_CATEGORY = "VAN_SHORT";

const LEGS: readonly Direction[] = ["AM", "PM"];

export type VanShortInput = {
  readonly siteId: string;
  readonly date: string;
  readonly by: string;
  readonly store: PlanStore;
  readonly source: DayDataSource;
};

/** Raise an alert for every van this date's saved plans no longer fit. Returns the task ids raised. */
export async function raiseVanShortAlerts(
  db: Db,
  transport: AgentWakeTransport,
  routing: { readonly model: string; readonly provider: string },
  a: VanShortInput,
): Promise<string[]> {
  const raised: string[] = [];
  for (const leg of LEGS) {
    const view = await loadBoard(a.store, a.siteId, a.date, leg, a.source);
    if (view.version === 0) continue; // nothing saved for this leg: nothing it was planned to carry
    const over = new Set(vansOver(view, view.plan));
    // A van that carries its riders again needs nobody looking at it any more (ledger #75).
    for (const van of view.day.vans) {
      if (!over.has(van.id)) await standDownAlertRuns(db, { siteId: a.siteId, vanId: van.id, date: a.date, leg, keep: null, by: a.by });
    }
    for (const vanId of over) {
      const van = view.day.vans.find((v) => v.id === vanId)!;
      // Who no longer fits, in the ramp's own order and by its own rule (the banner's "Ava N. won't fit").
      const who = vanVerdicts(van.setup, ridersInVan(view.day, view.plan, vanId)).flatMap((v) =>
        v.reason ? [view.day.riders.find((r) => r.token === v.token)?.name ?? ""] : [],
      ).filter(Boolean);
      const setup = createHash("sha256").update(JSON.stringify(van.setup)).digest("hex").slice(0, 16);
      const id = effectId(`van-short:${a.siteId}:${vanId}:${a.date}:${leg}:${setup}`);
      // The newest counts are the situation: an older alert's run on this van and leg stands down.
      await standDownAlertRuns(db, { siteId: a.siteId, vanId, date: a.date, leg, keep: id, by: a.by });
      await db.tx(async (tx, afterCommit) => {
        await raiseStaffAlert(tx, afterCommit, transport, {
          id,
          siteId: a.siteId,
          category: VAN_SHORT_TASK_CATEGORY,
          severity: "RED",
          words: {
            summary: fill(vanShortAlert.summary, {
              van: van.name,
              who: who.length > 0 ? who.join(", ") : vanShortAlert.itsRiders,
              leg: leg === "AM" ? "morning" : "afternoon",
            }),
            nextStep: vanShortAlert.nextStep,
            predicate: vanShortAlert.predicate,
          },
          by: a.by,
          evidence: { locator: { van_id: vanId, date: a.date, leg } },
        }, routing);
      });
      raised.push(id);
    }
  }
  return raised;
}

/**
 * ONE SITUATION, ONE CONVERSATION (ledger #75). A colleague who heard "Van 1 is one seat short" and
 * then "Van 1 is two seats short" works on the second; one who heard the van is fine again stops.
 * So an alert run still on its way for this van, date and leg — other than `keep` — is stood down:
 * QUEUED, RUNNING or parked runs move to ABORTED_SUPERSEDED_BY_HUMAN (a person's newer count is what
 * superseded it), which the run loop checks before every turn and the retry timer finds nothing to
 * wake. A run that already answered or drafted a card is left as it is: what it said was said.
 */
export async function standDownAlertRuns(
  db: Db,
  a: { readonly siteId: string; readonly vanId: string; readonly date: string; readonly leg: Direction; readonly keep: string | null; readonly by: string },
): Promise<number> {
  const r = await db.query(
    `UPDATE ops.agent_run r SET state = 'ABORTED_SUPERSEDED_BY_HUMAN', version = r.version + 1, updated_at = now(), updated_by = $6
       FROM ops.task t
      WHERE r.trigger_type = $7 AND r.state IN ('QUEUED', 'RUNNING', 'WAITING_TOOL') AND r.site_id = $1
        AND t.id::text = r.trigger_id AND t.site_id = $1 AND t.category = $8
        AND t.completion_evidence->'locator' @> jsonb_build_object('van_id', $2::text, 'date', $3::text, 'leg', $4::text)
        AND ($5::text IS NULL OR t.id::text <> $5::text)
      RETURNING r.id`,
    [a.siteId, a.vanId, a.date, a.leg, a.keep, a.by, ALERT_TRIGGER, VAN_SHORT_TASK_CATEGORY],
  );
  return r.rows.length;
}
