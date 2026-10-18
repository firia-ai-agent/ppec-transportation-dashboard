/**
 * HOW MANY THINGS ARE WAITING FOR A PERSON — the one number the Family texts badge shows.
 *
 * Two kinds of thing, one count (Firia, 2026-10-17 8:36 PM ET):
 *
 *  1. the proposals nobody has decided (`ops.approval_request`, undecided), and
 *  2. the family texts the assistant could not read, because no model answered (#72's
 *     ASSISTANT_UNAVAILABLE alerts).
 *
 * Both of them are "somebody has to look at this", both of them live on the "For you" tab of
 * Family texts, and a coordinator counting them separately would be counting the same job twice.
 * So the badge is their sum and this is the only place that sum is computed.
 *
 * It is here rather than in `src/ui/nav-items.ts` on purpose: the frame PR owns which nav item
 * carries a badge and this PR owns what the number means. The shell reads this function.
 *
 * Fails soft to 0. A count nobody could read must not take the console down, and a badge that is
 * absent is a smaller lie than a badge that is wrong.
 */
import type { Exec } from "@/db/exec";
import { assistantAlertCount } from "@/modules/agent/staff-alert";
import { pendingApprovals } from "@/modules/approvals/decide";

export async function waitingForAPerson(db: Exec, siteIds: readonly string[]): Promise<number> {
  if (siteIds.length === 0) return 0;
  const [proposals, alerts] = await Promise.all([
    pendingApprovals(db, siteIds),
    assistantAlertCount(db, siteIds),
  ]);
  return proposals.length + alerts;
}
