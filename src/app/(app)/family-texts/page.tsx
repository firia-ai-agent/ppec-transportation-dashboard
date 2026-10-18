import { APPROVAL_ROLES, canDecideApprovals } from "@/auth/access";
import { getExec } from "@/auth/exec";
import { requirePage } from "@/auth/page-guard";
import { getNeonDb } from "@/db/exec";
import { demoDay } from "@/domain/board/day";
import { modelReach } from "@/modules/agent/run/deps";
import { openAssistantAlerts, type AssistantAlert } from "@/modules/agent/staff-alert";
import { bodyOf, pendingApprovals } from "@/modules/approvals/decide";
import { demoChangeRequests, withRequestedTime, type DemoChangeRequest } from "@/modules/demo/change-request";
import { familyTexts } from "@/ui/copy";
import { decideApprovalAction } from "./actions";
import { conversationRows, proposalFromDemo, proposalFromRow, tabFrom, threadView, type ProposalView } from "./conversations";
import { TextsScreen } from "./TextsScreen";
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
 */
export default async function FamilyTextsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const caller = await requirePage("/family-texts");
  const params = await searchParams;
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

  const role = caller.kind === "STAFF" ? caller.role : null;
  const mayApprove = canDecideApprovals(role);
  const tab = tabFrom(one(params.tab));
  const askedThread = one(params.thread);
  const editedTime = clockOrNull(one(params.time));

  const day = demoDay();
  const phones = phonesForDay(day);
  // The Edit control, applied once: every reader below sees the time that is on screen.
  const requests = demoChangeRequests(day).map((r) => withRequestedTime(r, editedTime, day));
  const assistantReachable = modelReach().kind === "model";

  const selected = phones.find((p) => p.childKey === askedThread) ?? phones[phones.length - 1];
  const thread = selected
    ? await threadFor(getNeonDb, {
        dropoff: selected,
        pepper: process.env.HMAC_PEPPER,
        userId: caller.kind === "STAFF" ? caller.userId : undefined,
      })
    : null;

  const siteIds = caller.memberships.map((m) => m.siteId);
  const board = mayApprove ? await readAlerts(siteIds) : { alerts: [], unreadable: false };
  const logged = mayApprove ? await readPending(siteIds) : [];

  const view =
    selected && thread
      ? threadView({
          selected,
          thread,
          request: requests.find((r) => r.childKey === selected.childKey),
          day,
          assistantReachable,
          mayApprove,
        })
      : null;

  return (
    <TextsScreen
      tab={tab}
      rows={conversationRows(phones, requests)}
      thread={view}
      proposals={mayApprove ? proposalsFor(logged, requests, editedTime) : []}
      alerts={board.alerts}
      alertsUnreadable={board.unreadable}
      assistantReachable={assistantReachable}
      editedTime={editedTime}
      threadOpen={askedThread !== undefined}
      decide={decideApprovalAction}
      showForYouTab={mayApprove}
    />
  );
}

/**
 * The queue: the real rows when the database has them, the demo day's own request when it does not.
 *
 * In that order on purpose. A deployment that has run the day has `ops.approval_request` rows and
 * those are the truth; a laptop and a fresh preview have none, and the day's scripted request is
 * what the screen shows instead — the same projection the threads already fall back to, and the
 * reason this screen works with no `DATABASE_URL` at all.
 */
function proposalsFor(
  logged: readonly Awaited<ReturnType<typeof pendingApprovals>>[number][],
  requests: readonly DemoChangeRequest[],
  editedTime: string | null,
): readonly ProposalView[] {
  if (logged.length > 0) {
    return logged.map((row) => {
      const view = proposalFromRow(row, row.id);
      return editedTime === null
        ? view
        : {
            ...view,
            timeTo: editedTime,
            requestedHhmm: editedTime,
            // The decision model's own renderer, so the words on the card are the words it queues.
            draftText: bodyOf({ template_id: row.templateId, vars: { ...row.vars } }, editedTime),
          };
    });
  }
  // The requests already carry the edited time (applied once, above), so this is one mapping.
  return requests.map(proposalFromDemo);
}

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
    return { alerts: await openAssistantAlerts(getExec(), siteIds), unreadable: false };
  } catch {
    return { alerts: [], unreadable: true };
  }
}

async function readPending(siteIds: readonly string[]) {
  if (siteIds.length === 0) return [];
  try {
    return await pendingApprovals(getExec(), siteIds);
  } catch {
    return [];
  }
}
