import { redirect } from "next/navigation";
import { APPROVAL_ROLES, FOR_YOU_TAB, canOpenForYou, homePathFor } from "@/auth/access";
import { getExec } from "@/auth/exec";
import { identityGateway } from "@/modules/identity/gateway";
import { requirePage } from "@/auth/page-guard";
import { getNeonDb } from "@/db/exec";
import { demoDay, type ServiceDay } from "@/domain/board/day";
import { modelReach } from "@/modules/agent/run/model-reach";
import { siteOf } from "@/modules/plan/api";
import { openAssistantAlerts, type AssistantAlert } from "@/modules/agent/staff-alert";
import { approvalQueue } from "./queue";
import { familyTexts } from "@/ui/copy";
import { NOT_ON_YOUR_MENU, withNotice } from "@/ui/notice";
import { decideApprovalAction, takeAlertAction } from "./actions";
import { contextFor } from "./context";
import { conversationRows, tabFrom, threadView, type ProposalView } from "./conversations";
import { TextsScreen } from "./TextsScreen";
import { demoControlsGate } from "@/modules/demo/gate";
import { confirmCards } from "@/modules/actions/confirm-cards";
import { confirmPanel } from "@/ui/panel";
import { staleNotes } from "@/modules/actions/stale-notes";
import { dismissStaleNoteAction, openStaleNotePlanRoutesAction } from "./stale-note-actions";
import { phonesForDay, threadFor } from "./thread";

export const metadata = { title: familyTexts.documentTitle };

/** The guard reads a session, so this route is never statically rendered. */
export const dynamic = "force-dynamic";

/**
 * /family-texts — the day's family threads, and the approvals inside them.
 *
 * This file is the guard and the wiring; the screen is `TextsScreen.tsx` and everything it renders
 * is shaped in `conversations.ts`. Behind staff sign-in and behind the two console roles: PRD §1.1
 * gives the web console to the coordinator and the director, PRD §6.2 puts the front desk down as
 * the writer of actual attendance and custody alone, and §12 is minimum-necessary — a family's
 * thread is PHI-adjacent, so a role with no task that needs it does not get it. A role the row
 * omits gets the no-access page and a 403 (forbidden.tsx beside this file), never this frame.
 *
 * ## Three query parameters, and none of them is an id a request can choose freely
 *
 *  - `?tab=` is one of three names or the default (`conversations.tabFrom`).
 *  - `?thread=` names a *fixture child* and is matched against the day's own list, so a value from
 *    outside is either one of today's threads or the newest one. There is no id here a request
 *    could use to reach a family the day did not text.
 *  - `?time=` is the Edit control's new drop-off time. It changes the words on the card — through
 *    `bodyOf`, the decision model's own renderer — and **nothing else**: it writes nothing and
 *    sends nothing, so an edited message is still a pending proposal needing a fresh approval
 *    (Firia's gate 2).
 *
 * ## The "For you" tab, and who gets it
 *
 * `APPROVAL_ROLES` (src/auth/access.ts) decides. The front desk is not in it, so the tab is not
 * rendered for them, the alerts are not read for them, and `decideApprovalAction` refuses them on
 * the server — the tab's absence is the courtesy and the action is the guard (the ID-swap rule).
 *
 * ## When no model can be reached
 *
 * `modelReach()` is a pure environment read — no network, no call. With no model there is **no
 * proposal card anywhere on this screen**, and the "needs a person" alert is what the tab shows
 * instead (gate 5): nothing read the family's text, so there is nothing to approve. The threads
 * still render, because the texts that went out did go out.
 *
 * ## Reading fails soft, and says so
 *
 * Both database reads are wrapped. Three real situations reach them: a preview, whose database
 * user is read-only; a signed-in demo session, which holds no membership and therefore no site;
 * and a database that is simply away. None is a reason to take the screen off a coordinator, and
 * none is a reason to tell them their families are all answered — `alertsUnreadable` says which.
 *
 * TWO GUARDS, AND THEY ANSWER TWO QUESTIONS.
 *  1. `requirePage` — may you open Family texts at all? That is this page's row.
 *  2. `canOpenForYou` — may you *decide*? That is `APPROVAL_ROLES` (src/auth/access.ts), and it
 *     is asked here, on the server, before any markup exists, because `?tab=for-you` is a URL a
 *     person can type. A tab that is merely not drawn is hiding, not denying (the ID-swap
 *     skill, rule 6), and the front desk must never land on this queue — they land on their own
 *     home, the live map, with the §9.3 notice.
 * The two are independent on purpose: widening the row that opens the page must not quietly
 * hand the approvals queue to a role that may not approve.
 */
export default async function FamilyTextsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const caller = await requirePage("/family-texts");
  const params = await searchParams;
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

  /*
   * The second guard (#74): `?tab=for-you` is a URL a person can type, so a role that may not
   * decide is sent to their own home with the §9.3 notice rather than shown a tab that is merely
   * not drawn. The page's own row has already answered the first question above.
   */
  const mayApprove = canOpenForYou(caller);
  if (one(params.tab) === FOR_YOU_TAB && !mayApprove) {
    redirect(withNotice(homePathFor(caller), NOT_ON_YOUR_MENU));
  }
  const tab = tabFrom(one(params.tab));
  const askedThread = one(params.thread);
  /*
   * `?edit=` is the Edit control's own state and nothing else: it names the proposal whose text box
   * is open. It writes nothing and sends nothing — the words travel in the Approve POST, never in
   * the URL — and the resting card has no field on it at all (Firia, 10:51 PM ET).
   */
  const editingId = one(params.edit) ?? null;

  const day = demoDay();
  const phones = phonesForDay(day);
  const assistantReachable = modelReach().kind === "model";
  const siteIds = caller.memberships.map((m) => m.siteId);
  const board = mayApprove ? await readAlerts(siteIds) : { alerts: [], unreadable: false };
  /*
   * THE ONE READ OF THE PROPOSALS (S1-2). The tab's badge, the For you queue, the "Change ready"
   * rows and the card inside the thread are all this list — matched to a thread on `threadKey` — so
   * the screen cannot say "1 waiting" over a card that is about something else, and cannot draw a
   * card with no row behind it for an Approve to post.
   *
   * READING THIS PAGE WRITES NOTHING AND CALLS NO MODEL. The card is the agent run's: an
   * inbound text starts a run, the model proposes, and the proposal writer stores the row this
   * reads (`agent/run/exec/proposals.ts`). With no model there is nothing to approve, because
   * nothing read the family's text — gate 5 — and a role that may not decide does not have the
   * queue read for them at all.
   */
  const queue =
    mayApprove && assistantReachable ? await readQueue(siteIds, day) : [];

  /*
   * Which thread is open, in order: the one the URL names; otherwise the one with something
   * waiting on it, which is the row the mockups draw as current (approvals.html `.th.on` is the
   * "Change ready" family); otherwise the newest.
   */
  const selected =
    phones.find((p) => p.childKey === askedThread) ??
    phones.find((p) => queue.some((q) => q.threadKey === p.childKey)) ??
    phones[0];
  const thread = selected
    ? await threadFor(getNeonDb, {
        dropoff: selected,
        pepper: process.env.HMAC_PEPPER,
        userId: caller.kind === "STAFF" ? caller.userId : undefined,
      })
    : null;

  const view =
    selected && thread
      ? threadView({
          selected,
          thread,
          proposal: queue.find((p) => p.threadKey === selected.childKey) ?? null,
          day,
          assistantReachable,
          mayApprove,
        })
      : null;

  /* The third pane, for the thread that is open and only on the tab that decides things. */
  const context = selected && mayApprove ? await contextFor(selected.childKey, siteOf(caller)) : null;

  return (
    <TextsScreen
      tab={tab}
      context={context}
      editingId={editingId}
      /*
        * "Change ready" only where the queue holds a pending proposal for that thread (Vera,
        * bdfaa8e): the chip, the card and For you read one list, so a fixture ask with no row
        * behind it shows as the text the day sent rather than as a decision nobody can make.
        */
      rows={conversationRows(phones, queue)}
      thread={view}
      /* The same rows the card in the thread came from: one read, two readers (S1-2). */
      proposals={queue}
      alerts={board.alerts}
      alertsUnreadable={board.unreadable}
      assistantReachable={assistantReachable}
      threadOpen={askedThread !== undefined}
      decide={decideApprovalAction}
      takeAlert={takeAlertAction}
      showForYouTab={mayApprove}
      /* A demo control (ledger #78): only where the demo controls are on, for the roles it serves. */
      changes={mayApprove ? (await readChanges(siteOf(caller))).map(confirmPanel) : []}
      staleNotes={mayApprove ? await readStaleNotes(siteOf(caller)) : []}
      staleNoteActions={{ dismiss: dismissStaleNoteAction, open: openStaleNotePlanRoutesAction }}
      simulate={mayApprove && demoControlsGate(process.env).allowed ? phones.map((p) => ({ key: p.childKey, label: p.childLabel })) : null}
    />
  );
}

/*
 * THERE IS NO FIXTURE FALLBACK HERE ANY MORE (Firia's S1-2, 11:00 PM ET: "Delete … the For you
 * fixture when there are no rows … with no rows show the mockup's empty state").
 *
 * What used to be here was `proposalsFor`: the real `ops.approval_request` rows when the database
 * had them, and `requests.map(proposalFromDemo)` — the demo change-request fixture — when it did
 * not. It made the screen look right on a laptop and it was the wrong trade, because the thing it
 * invented was a *decision*. Every card carries an Approve that posts an approval id, so a card
 * with no row behind it is a button the server answers `NO_SUCH_APPROVAL` to; and a coordinator
 * who has pressed it has been told the family was texted about a change that no row records and
 * no plan holds.
 *
 * With no rows there is now no card, and the For you tab says so in its own words. The demo gets a
 * card the way the product does: a parent's text ("Simulate parent text", ledger #78) starts an
 * agent run, and the card is the row `agent/run/exec/proposals.ts` writes.
 */

async function readAlerts(
  siteIds: readonly string[],
): Promise<{ alerts: readonly AssistantAlert[]; unreadable: boolean }> {
  if (siteIds.length === 0) return { alerts: [], unreadable: false };
  try {
    return { alerts: await openAssistantAlerts(getExec(), siteIds, identityGateway()), unreadable: false };
  } catch {
    return { alerts: [], unreadable: true };
  }
}

/**
 * The approval queue, failing soft.
 *
 * A read-only preview, a demo session with no membership, a database that is away: all three are
 * "nothing is waiting" as far as this screen is concerned, and none of them is a reason to take
 * Family texts off a coordinator. What they are emphatically not a reason to do is invent a card
 * — see the note above — so the empty list is the honest answer and the tab prints it.
 */
async function readQueue(
  siteIds: readonly string[],
  day: ServiceDay,
): Promise<readonly ProposalView[]> {
  if (siteIds.length === 0) return [];
  try {
    return await approvalQueue({ db: getExec(), siteIds, day });
  } catch {
    return [];
  }
}

/** Stale agent plan cards' notes (Vera), failing soft like the rest. */
async function readStaleNotes(siteId: string) {
  try {
    return await staleNotes(getExec(), siteId);
  } catch {
    return [];
  }
}

/** Changes to the day waiting for a person (ledger #79), failing soft like the queue. */
async function readChanges(siteId: string) {
  try {
    return await confirmCards(getExec(), siteId);
  } catch {
    return [];
  }
}
