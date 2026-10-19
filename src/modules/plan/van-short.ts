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
import { raiseStaffAlert } from "@/modules/agent/alerts";
import type { AgentWakeTransport } from "@/modules/agent/run/queue";
import { effectId } from "@/modules/agent/run/exec/effects";
import { fill, vanShortAlert } from "@/ui/copy";
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
    for (const vanId of vansOver(view, view.plan)) {
      const van = view.day.vans.find((v) => v.id === vanId)!;
      const setup = createHash("sha256").update(JSON.stringify(van.setup)).digest("hex").slice(0, 16);
      const id = effectId(`van-short:${a.siteId}:${vanId}:${a.date}:${leg}:${setup}`);
      await db.tx(async (tx, afterCommit) => {
        await raiseStaffAlert(tx, afterCommit, transport, {
          id,
          siteId: a.siteId,
          category: VAN_SHORT_TASK_CATEGORY,
          severity: "RED",
          words: {
            summary: fill(vanShortAlert.summary, { van: van.name, leg: leg === "AM" ? "morning" : "afternoon" }),
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
