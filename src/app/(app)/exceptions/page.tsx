import { getExec } from "@/auth/exec";
import { requirePage } from "@/auth/page-guard";
import { nav, stub } from "@/ui/copy";
import { StubPage } from "@/ui/StubPage";
import {
  type AlertThreadMessage,
  type AssistantAlert,
  alertThreadMessages,
  openAlert,
  openAssistantAlerts,
} from "@/modules/agent/staff-alert";
import { AlertCards } from "./AlertCards";

/** The guard reads a session, so this route is never statically rendered. */
export const dynamic = "force-dynamic";

/**
 * SURF-05 Exceptions & Approvals (§4.1).
 *
 * It is a `StubPage` and not the "isn't built yet" `Placeholder`: REDESIGN-SPEC §0 puts this on
 * the menu, nothing on the menu may 404, and a founder clicking a menu item mid-demo should land
 * on a screen carrying the page's own name. The frame is the page's title and its one line.
 *
 * The exceptions board itself is still not built, and the page still renders no list of it —
 * an empty table would read as "nothing needs action", which is the one thing a page like this
 * must never say falsely. What **is** built, under the title, is the one card #72 adds: a family
 * text the assistant could not read because its model was unavailable (founder, 2026-10-17:
 * "never compensate with a deterministic text parser … the owner/staff need to be notified").
 *
 * Server-side role guard first, before anything is read or rendered: `/exceptions` is in the
 * access table (src/auth/access.ts), and a role that is not in its row gets the no-access page
 * and a 403 (forbidden.tsx beside this file), never this frame. The front desk is not in that
 * row, which is the whole of why they see neither these cards nor the rail's count — there is no
 * second rule about alerts anywhere.
 *
 * ## Reading fails soft, and says so
 *
 * The alert read is wrapped, and a failure renders `assistantUnavailable.unreadable` rather than
 * an error page or — worse — the empty state. Three real situations reach it: a preview, whose
 * database user is read-only and may refuse; a signed-in demo session, which holds no membership
 * and therefore no site to read; and a database that is simply away. None of them is a reason to
 * take the whole of SURF-05 off a coordinator, and none of them is a reason to tell them their
 * families are all answered.
 *
 * ## `?open=` marks an alert taken
 *
 * Opening a card is a navigation to this page with the alert named, and arriving *is* the act of
 * opening it — so the write happens here, guarded on this caller's own memberships, before the
 * list is read, so the card comes back already marked.
 *
 * It is a link rather than a server action for a binding reason: a server action is a POST
 * endpoint, `src/auth/access.test.ts` requires every one of them to have a row in
 * `src/auth/access.ts`, and the founder's ruling for this change says not to touch that file at
 * all. The page's own row is the same guard, and it has already run on the line above.
 *
 * It never *closes* an alert, and there is no control that does. A card goes when the family has
 * been answered, which this screen cannot observe.
 */
export default async function Page({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const caller = await requirePage("/exceptions");
  const params = (await searchParams) ?? {};
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

  const siteIds = caller.memberships.map((m) => m.siteId);
  const board = await readBoard(siteIds, one(params.open), callerActor(caller));

  return (
    <StubPage title={nav.exceptions} line={stub.exceptions}>
      <AlertCards
        alerts={board.alerts}
        thread={board.thread}
        showReplyNote={one(params.reply) === "1"}
        unreadable={board.unreadable}
      />
    </StubPage>
  );
}

type Board = {
  readonly alerts: readonly AssistantAlert[];
  readonly thread: { readonly alertId: string; readonly messages: readonly AlertThreadMessage[] } | null;
  readonly unreadable: boolean;
};

/** Who the write is stamped with. `requirePage` has already refused anyone without a session. */
function callerActor(caller: { kind: string; userId?: string }): string {
  return caller.kind === "STAFF" && caller.userId ? `staff:${caller.userId}` : "staff:unknown";
}

/**
 * Mark the opened alert taken, then read the cards and the one thread it points at.
 *
 * The thread is read from the alert **we just selected** rather than from an id in the URL: the
 * alerts in hand are the ones this caller's memberships admit, so an unknown or foreign alert id
 * opens nothing rather than being asked about. (`alertThreadMessages` is site-scoped too; this is
 * the cheaper half of the same fence.)
 *
 * The `openAlert` write has its own `try`: on a preview the database user is read-only
 * (`src/db/read-only.ts`) and the UPDATE is refused, and the right answer there is the card
 * exactly as it was — still waiting, still nobody's — not a broken board.
 */
async function readBoard(
  siteIds: readonly string[],
  openedId: string | undefined,
  by: string,
): Promise<Board> {
  if (siteIds.length === 0) return { alerts: [], thread: null, unreadable: false };
  if (openedId) {
    try {
      await openAlert(getExec(), { id: openedId, siteIds, by });
    } catch {
      // Read-only preview, or the database is away. The read below still has the truth.
    }
  }
  try {
    // Inside the `try`, pool and all: `getExec()` itself throws when there is no DATABASE_URL,
    // which is the case on the guard-matrix walk and on any shell built without one. "We could
    // not read the board" covers that as honestly as it covers a query that failed.
    const db = getExec();
    const alerts = await openAssistantAlerts(db, siteIds);
    const opened = openedId ? alerts.find((a) => a.id === openedId) : undefined;
    const thread =
      opened && opened.threadId
        ? { alertId: opened.id, messages: await alertThreadMessages(db, { threadId: opened.threadId, siteIds }) }
        : null;
    return { alerts, thread, unreadable: false };
  } catch {
    return { alerts: [], thread: null, unreadable: true };
  }
}
