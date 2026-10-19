/**
 * WHO A STAFF RUN ACTS FOR, AND WHAT THEY MAY PRESS (ledger #74, #77).
 *
 * Kept free of the action registry on purpose: the card writers (`proposals.ts`) sit in graphs —
 * the Family texts page's among them — that must not pull the plan writers or the demo seed in.
 * A card runner names its own access row (`action-tools.ts ActionTool.endpoint`), and that row is
 * all a role check needs.
 */
import { ALL_STAFF, endpointRow } from "@/auth/access";
import { Forbidden, SiteNotFound, Unauthenticated, requireSiteAccess } from "@/auth/core";
import type { Exec } from "@/db/exec";
import type { ActionCtx } from "@/modules/actions/types";
import { actionTool } from "../../action-tools";
import { STAFF_ASK_TASK_CATEGORY } from "../../ask/ask-text";

/** The staff member a run acts for: the one whose ask started it. Null for every other run. */
export async function askerOf(
  deps: { readonly db: Exec },
  call: { readonly trigger: { readonly type: string; readonly id: string }; readonly siteId: string },
): Promise<ActionCtx["caller"] | null> {
  if (call.trigger.type !== "staff.ask") return null;
  const row = (
    await deps.db.query<{ created_by: string }>(
      "SELECT created_by FROM ops.task WHERE id = $1 AND site_id = $2 AND category = $3",
      [call.trigger.id, call.siteId, STAFF_ASK_TASK_CATEGORY],
    )
  ).rows[0];
  const userId = /^staff:([0-9a-f-]{36})$/i.exec(row?.created_by ?? "")?.[1];
  if (!userId) return null;
  try {
    const membership = await requireSiteAccess(deps.db, userId, call.siteId, ALL_STAFF);
    return { userId, role: membership.role };
  } catch {
    return null;
  }
}

/**
 * WHY THE PERSON WHO ASKED COULD NOT PRESS THIS CARD THEMSELVES, or null (ledger #77). A teammate
 * proposes what the asker could do on their own screen — a front desk's ask is no way to a plan
 * change a front desk cannot save. A run nobody asked for (an alert) has no asker: its card waits
 * for whoever may decide it, and Approve checks their role as it always does.
 */
export async function askerMayNot(
  tx: Exec,
  call: Parameters<typeof askerOf>[1],
  runner: string,
): Promise<string | null> {
  if (call.trigger.type !== "staff.ask") return null;
  const caller = await askerOf({ db: tx }, call);
  if (!caller) return "NO_PERSON_TO_ACT_FOR";
  const row = endpointRow(actionTool(runner)?.endpoint ?? "");
  if (!row || row.auth.kind !== "session") return "NOT_YOUR_ROLE";
  try {
    await requireSiteAccess(tx, caller.userId, call.siteId, row.auth.roles);
    return null;
  } catch (e) {
    if (e instanceof Forbidden) return "NOT_YOUR_ROLE";
    if (e instanceof SiteNotFound || e instanceof Unauthenticated) return "NOT_A_MEMBER";
    throw e;
  }
}
