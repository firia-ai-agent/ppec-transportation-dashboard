/**
 * THE AGENT HEARS A VAN RUNNING LATE (ledger #79).
 *
 * The live sweep texts families whose drop-off has slipped (`messaging/eta-notice.ts`); the same
 * moment is an input the agent should see, like a van confirmed short at the ramp. One alert per
 * site per sweep that told anybody — keyed on who was told, so the next sweep does not raise it
 * again — through `raiseStaffAlert`, which starts the agent on it (`operational.event`). The agent
 * reads the board and proposes a panel, or says no change is right.
 */
import type { Db } from "@/db/exec";
import { effectId } from "./run/exec/effects";
import { raiseStaffAlert } from "./alerts";
import type { AgentWakeTransport } from "./run/wake";
import { fill, runningLateAlert } from "@/ui/copy";
import { serviceDateIso } from "@/ui/service-date";

export const RUNNING_LATE_TASK_CATEGORY = "RUNNING_LATE";

export async function raiseRunningLateAlerts(
  db: Db,
  transport: AgentWakeTransport,
  routing: { readonly model: string; readonly provider: string },
  a: { readonly late: readonly { siteId: string; childToken: string; delayMinutes: number }[]; readonly now: Date; readonly by: string },
): Promise<number> {
  let raised = 0;
  for (const siteId of [...new Set(a.late.map((l) => l.siteId))]) {
    const late = a.late.filter((l) => l.siteId === siteId);
    const names = (
      await db.query<{ display_name: string | null }>(
        "SELECT display_name FROM ops.child_profile WHERE site_id = $1 AND child_token = ANY($2::uuid[]) ORDER BY display_name",
        [siteId, late.map((l) => l.childToken)],
      )
    ).rows.map((r) => r.display_name).filter((n): n is string => !!n);
    const key = `running-late:${siteId}:${serviceDateIso(a.now)}:${late.map((l) => l.childToken).sort().join(",")}`;
    await db.tx(async (tx, afterCommit) => {
      await raiseStaffAlert(tx, afterCommit, transport, {
        id: effectId(key),
        siteId,
        category: RUNNING_LATE_TASK_CATEGORY,
        severity: "AMBER",
        words: {
          summary: fill(runningLateAlert.summary, { minutes: Math.max(...late.map((l) => l.delayMinutes)), who: names.join(", ") }),
          nextStep: runningLateAlert.nextStep,
          predicate: runningLateAlert.predicate,
        },
        by: a.by,
      }, routing);
    });
    raised += 1;
  }
  return raised;
}
