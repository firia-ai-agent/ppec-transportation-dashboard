/**
 * THE APPROVAL QUEUE — one read of `ops.approval_request`, and everything on the screen that is
 * about a pending proposal comes out of it.
 *
 * Firia's S1-2 (2026-10-17 11:00 PM ET): "the proposal card comes from the REAL model call and
 * REAL approval rows … The badge and the card come from the SAME rows (one query/module; test
 * they match)."
 *
 * They did not. The count over the "For you" tab was `pendingApprovals`, a real database read; the
 * card *inside the thread* was `proposalFromDemo`, a pure function over the demo fixture. So on a
 * deployment that had run the day the tab could read `1` while the card under the parent's message
 * was a different proposal entirely — and on one that had not, the card existed with no row behind
 * it at all. A card offering "Approve and send" for something no row records is the worst version
 * of that: the button posts an approval id the server has never heard of, so the screen promises a
 * decision it cannot make.
 *
 * This module is the fix, and it is a module rather than two call sites so that "the same rows"
 * is structural. The page calls it once. The result is the tab's count, the For you queue, and —
 * matched on `threadKey` — the card in the open thread. There is no second source for any of them.
 *
 * ## What is read, and what is computed
 *
 * The **row** carries the decision: which child, which leg, which template and vars, the time
 * proposed, the stop, and the `plan_run.version` the approval will be guarded on. The **facts**
 * around it — the van, whether the ride still fits, whether the adult is on the family's file, the
 * landmark the stop token names — are computed from the day's own source and the roster
 * (`checks.ts`), because they are facts about the plan as it stands rather than fields of a row
 * written minutes ago.
 *
 * The **words** are `bodyOf`, the decision model's own renderer, over the row's template and vars.
 * Never a string stored at proposal time: the outbox renders at send time, so a stored string is a
 * second rendering that can drift from the one the family gets.
 *
 * ## Why it fails soft
 *
 * Three real situations reach this read with no rows and no fault: a preview whose database user is
 * read-only, a signed-in demo session that holds no membership and therefore no site, and a
 * database that is away. None of them is a reason to take the screen off a coordinator, and none of
 * them is a reason to invent a card — so the queue is empty and the tab says so in words
 * (`approval.none`). An empty queue is a fact about the day, and the screen is allowed to state it.
 */
import { localTimeOn, type ServiceDay } from "@/domain/board/day";
import type { Exec } from "@/db/exec";
import { formatClock } from "@/domain/eta/eta";
import { bodyOf, pendingApprovals } from "@/modules/approvals/decide";
import { approval, fill } from "@/ui/copy";
import { proposalFacts } from "./checks";
import type { ProposalView } from "./conversations";

/**
 * The proposals waiting at these sites, oldest first, as the card renders them.
 *
 * `editedTime` is the Edit control, applied once here so that every reader below — the card in the
 * thread, the card on the tab, the compose bar's hidden field — shows the time that is on screen.
 * It writes nothing: an edited proposal is still a pending proposal (Firia's gate 2).
 */
export async function approvalQueue(a: {
  readonly db: Exec;
  readonly siteIds: readonly string[];
  readonly day: ServiceDay;
  readonly editedTime: string | null;
}): Promise<readonly ProposalView[]> {
  const rows = await pendingApprovals(a.db, a.siteIds);
  return Promise.all(rows.map((row) => viewOf(row, a)));
}

type Row = Awaited<ReturnType<typeof pendingApprovals>>[number];

async function viewOf(
  row: Row,
  a: { readonly day: ServiceDay; readonly editedTime: string | null },
): Promise<ProposalView> {
  const facts = await proposalFacts({
    childToken: row.childToken,
    stopToken: row.stopToken,
    day: a.day,
  });
  const time = a.editedTime ?? row.requestedTime;
  /*
   * The child, as the SENT text names them: `ops.child_profile.display_name` ("Noah O."), which is
   * what `pendingApprovals` already renders `row.text` with. Passed here too, because the Edit
   * control re-renders the body for a new time and a body re-rendered without the name would say
   * "your child" on the card while the queued message said "Noah O." — one renderer, one set of
   * words, including the name in them.
   */
  const childLabel = row.childLabel === "" ? facts.childLabel : row.childLabel;
  return {
    approvalId: row.id,
    /*
     * WHICH THREAD THIS CARD BELONGS IN. The fixture child key, read back from the row's own
     * `child_token` (`checks.proposalFacts` → `childKeyOfToken`), because that is what `?thread=`
     * names and what the thread pane is keyed by. A row whose child this roster cannot name keeps
     * its own id, so it still appears on the tab and simply sits in no thread — visible rather
     * than silently dropped.
     */
    threadKey: facts.threadKey ?? row.id,
    // The child's name off `ops.child_profile` (the row's own join), falling back to the roster.
    childLabel,
    adultName: facts.adultName,
    /*
     * "Agent · 3:58 PM" — the author from `copy.agentLabel` (Vera's S1-2 item a) and the minute
     * off the row's own `created_at`. No line at all for a row whose timestamp cannot be read,
     * rather than the epoch rendered as a time.
     */
    draftedLabel:
      row.draftedAtMs === 0
        ? ""
        : fill(approval.draftedBy, { agent: approval.agentLabel, time: formatClock(row.draftedAtMs) }),
    /*
     * The stop, with no "from". The row holds the place being proposed and nothing about the one
     * the leg came from, so the before half is left out rather than reconstructed: a "from" the
     * row does not hold would be this screen inventing one.
     */
    stopFrom: null,
    stopTo: facts.stopLabel,
    timeFrom: null,
    timeTo: time === null ? null : formatClock(localTimeOn(a.day, time)),
    pickupLabel: facts.pickupLabel,
    // Computed, every one of them, and absent when they cannot be answered (S1-2, checks.ts).
    checks: facts.checks,
    /*
     * The decision model's own renderer, so the words on the card are the words it queues — and
     * rendered with the row's OWN child label, not the roster's fallback.
     *
     * That distinction matters since S1-7: the card posts these words back with the decision and
     * `decideApproval` refuses a decision whose words do not match what it renders
     * (`MESSAGE_CHANGED`). It renders with the row's `display_name`, so a card that rendered with
     * a roster name the row does not hold would be refused on every press — the screen and the
     * decision have to be looking at the same sentence, which is the whole point of the check.
     */
    draftText: bodyOf(
      { template_id: row.templateId, vars: { ...row.vars } },
      time,
      row.childLabel === "" ? null : row.childLabel,
    ),
    requestedHhmm: time,
  };
}

/*
 * The clock a coordinator reads is `formatClock(localTimeOn(day, hhmm))` — the day's own timezone
 * through the board's own helper, exactly as `demo/change-request.ts` renders the same field. No
 * second formatter here: a card that formatted times for itself is how a screen ends up an hour
 * out from the one beside it.
 */
