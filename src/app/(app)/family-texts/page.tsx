import { redirect } from "next/navigation";
import { APPROVAL_ROLES, FOR_YOU_TAB, canOpenForYou, homePathFor } from "@/auth/access";
import { getExec } from "@/auth/exec";
import { identityGateway } from "@/modules/identity/gateway";
import { requirePage } from "@/auth/page-guard";
import { getNeonDb } from "@/db/exec";
import { demoDay, type ServiceDay } from "@/domain/board/day";
import { modelReach } from "@/modules/agent/run/deps";
import { openAssistantAlerts, type AssistantAlert } from "@/modules/agent/staff-alert";
import { approvalQueue } from "./queue";
import { familyTexts } from "@/ui/copy";
import { NOT_ON_YOUR_MENU, withNotice } from "@/ui/notice";
import { decideApprovalAction, redraftReplyAction, takeAlertAction } from "./actions";
import { contextFor } from "./context";
import { conversationRows, openThreadOf, tabFrom, threadView, type ProposalView } from "./conversations";
import { TextsScreen } from "./TextsScreen";
import { phonesForDay, threadsForDay } from "./thread";

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
 *  - `?time=` is a drop-off time to show the card's time field, through `bodyOf` — the decision
 *    model's own renderer — and **nothing else**: it writes nothing, it calls no model, and it
 *    cannot change a word of a drafted reply, so an edited message is still a pending proposal
 *    needing a fresh approval (Firia's gate 2). Since PPE-107 nothing on screen produces it: the
 *    time field is inside the form that approves and changing it is a POST that redrafts the reply
 *    (`redraftReplyAction`), because a GET that re-rendered the page wiped the box beside it. A
 *    hand-typed `?time=` therefore shows a field that disagrees with the stored draft, and the
 *    decision refuses that press by name rather than sending a sentence about another time
 *    (`decide.DRAFT_FOR_OTHER_TIME`).
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
  const editedTime = clockOrNull(one(params.time));
  /*
   * `?edit=` is the Edit control's own state and nothing else: it names the proposal whose time
   * field is open. It writes nothing and sends nothing — the card comes back pending either way
   * (gate 2) — and the resting card has no field on it at all (Firia, 10:51 PM ET).
   */
  const editing = one(params.edit) !== undefined;

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
   * READING THIS PAGE WRITES NOTHING AND CALLS NO MODEL (PPE-96). The card is the agent run's: an
   * inbound text starts a run, the model proposes, and the proposal writer stores the row this
   * reads (`agent/run/exec/proposals.ts`). With no model there is nothing to approve, because
   * nothing read the family's text — gate 5 — and a role that may not decide does not have the
   * queue read for them at all.
   */
  const queue =
    mayApprove && assistantReachable ? await readQueue(siteIds, day, editedTime) : [];

  /*
   * Which thread is open: the one the URL names, else the one with a decision waiting on it (the
   * row the mockups draw as current — approvals.html `.th.on` is the "Change ready" family), else
   * the one an alert is about, else the newest. The order lives in `conversations.ts` with the
   * rest of the view model, where it can be asked about without a database.
   */
  /*
   * ONE READ OF THE DAY'S THREADS, for the list and for the pane alike (#B5). A row's preview is
   * the newest bubble of the thread that row opens; before this the rows previewed the demo day's
   * projection while the pane rendered the log, so Dara's row said the van was running late at
   * 4:08 over a thread whose only message was her own, at 12:57.
   */
  const threads = await threadsForDay(getNeonDb, {
    phones,
    pepper: process.env.HMAC_PEPPER,
    userId: caller.kind === "STAFF" ? caller.userId : undefined,
  });
  /*
   * "Change ready" only where the queue holds a pending proposal for that thread (Vera, bdfaa8e):
   * the chip, the card and For you read one list, so a fixture ask with no row behind it shows as
   * the text the day sent rather than as a decision nobody can make.
   *
   * Built **before** the thread is chosen, because which thread opens by default is "the row at
   * the top of this list" and not "the newest text" (`openThreadOf` step 4).
   */
  const rows = conversationRows(phones, queue, threads);
  const selected = openThreadOf(phones, { askedThread, proposals: queue, alerts: board.alerts, rows });
  const thread = selected ? threads.get(selected.childKey) ?? null : null;

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
  const context = selected && mayApprove ? await contextFor(selected.childKey, day) : null;

  return (
    <TextsScreen
      tab={tab}
      context={context}
      editing={editing}
      rows={rows}
      thread={view}
      /* The same rows the card in the thread came from: one read, two readers (S1-2). */
      proposals={queue}
      alerts={board.alerts}
      alertsUnreadable={board.unreadable}
      assistantReachable={assistantReachable}
      editedTime={editedTime}
      threadOpen={askedThread !== undefined}
      decide={decideApprovalAction}
      redraft={redraftReplyAction}
      takeAlert={takeAlertAction}
      showForYouTab={mayApprove}
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
 * With no rows there is now no card, and the For you tab says so in its own words. The demo still
 * has a card to show, because the demo *seeds a real approval row* — `seedDemoChangeRequest`
 * (src/modules/demo/approval-seed.ts), run by the standard seed, which writes the same shape
 * `agent/run/exec/proposals.ts` writes and is read back by the same query.
 */

/**
 * A 24-hour wall-clock time, or nothing.
 *
 * The same shape `decideApproval` accepts, checked here too, so a junk `?time=` is simply ignored
 * rather than rendered into a card. It is never used as anything but a time.
 */
function clockOrNull(value: string | undefined): string | null {
  return value !== undefined && /^([01]\d|2[0-3]):[0-5]\d$/.test(value) ? value : null;
}

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
  editedTime: string | null,
): Promise<readonly ProposalView[]> {
  if (siteIds.length === 0) return [];
  try {
    return await approvalQueue({ db: getExec(), siteIds, day, editedTime });
  } catch {
    return [];
  }
}
