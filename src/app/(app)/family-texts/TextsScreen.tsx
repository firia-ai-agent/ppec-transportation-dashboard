import Link from "next/link";
import { Bot, ChevronLeft, ShieldCheck } from "lucide-react";
import { FAMILY_TEXTS_FOR_YOU, FOR_YOU_TAB } from "@/auth/access";
import { StateChip } from "@/ui/StateChip";
import { approval, assistantUnavailable, familyTexts, fill } from "@/ui/copy";
import { icon } from "@/ui/tokens";
import type { AssistantAlert } from "@/modules/agent/staff-alert";
import { Composer } from "./Composer";
import { AgentPanel } from "@/ui/AgentPanel";
import { StaleNote } from "@/ui/StaleNote";
import type { StaleNoteAction, StaleNoteView } from "@/modules/actions/confirm-view";
import { replyPanel, type PanelView } from "@/ui/panel";
import { ThreadEnd } from "./ThreadEnd";
import { ROW_STATES } from "./row-state";
import type { ThreadContext } from "./context";
import type { ConversationRow, ProposalView, TabKey, ThreadView } from "./conversations";
import { TABS } from "./conversations";
import type { DecideAction, TakeAlertAction } from "./actions";
import { SimulateParentText, type SimulateOption } from "./SimulateParentText";
import styles from "./texts.module.css";

/**
 * FAMILY TEXTS — the screen, rebuilt to mockups/family-texts.html at both widths.
 *
 * At ≥768 it is two panes: the conversation list on the left and the thread on the right, with the
 * approve card **inside the thread** under the last bubble and one compose bar pinned beneath it.
 * Below 768 it is one pane at a time, and which one is the URL's answer (`?thread=`), so the list
 * and the thread are a navigation with a real back link rather than a script's state.
 *
 * `?tab=for-you` is the approvals queue — mockups/approvals.html, which REDESIGN-SPEC §9.2 makes a
 * tab of this screen and not a page. It stacks one proposal card per row at every width, with the
 * "needs a person" alert above them.
 *
 * One title and no explanatory sentence under it (Firia, 8:36 PM ET). What this screen is for is
 * evident from what is on it.
 */
export function TextsScreen({
  tab,
  rows,
  thread,
  proposals,
  alerts,
  alertsUnreadable,
  assistantReachable,
  context,
  editingId,
  threadOpen,
  decide,
  takeAlert,
  showForYouTab,
  simulate = null,
  changes = [],
  staleNotes = [],
  staleNoteActions = null,
}: {
  readonly tab: TabKey;
  readonly rows: readonly ConversationRow[];
  /** The open thread, or null on a day with no family texts at all. */
  readonly thread: ThreadView | null;
  /** The "For you" queue: every proposal waiting for a person. */
  readonly proposals: readonly ProposalView[];
  /** The #72 "needs a person" alerts, for the roles that may act on them. */
  readonly alerts: readonly AssistantAlert[];
  readonly alertsUnreadable: boolean;
  /** False when no model can be reached: no card renders at all (gate 5). */
  readonly assistantReachable: boolean;
  /**
   * The van / pick-up pane beside the thread — the third pane at 1440 (Firia, 10:51 PM ET).
   * Null when the open thread has nothing to decide, which is when there is no pane.
   */
  readonly context: ThreadContext | null;
  /** The proposal the URL has put into its Edit state (`?edit=<approval id>`), or null. */
  readonly editingId: string | null;
  /** True when the URL names a thread: the phone shows the thread rather than the list. */
  readonly threadOpen: boolean;
  readonly decide: DecideAction;
  /** The POST that marks a "needs a person" alert taken. A render never does (S1-4). */
  readonly takeAlert: TakeAlertAction;
  /**
   * Whether this caller may see the "For you" tab at all. The front desk may not — and the tab
   * being absent is the courtesy; the server refusing the action and the page is the guard.
   */
  readonly showForYouTab: boolean;
  /** The demo's "Simulate parent text" families (ledger #78), or null where the demo controls are off. */
  readonly simulate?: readonly SimulateOption[] | null;
  /** Changes to the day waiting for a person, as the one agent panel (ledger #79). */
  readonly changes?: readonly PanelView[];
  /** Stale agent plan cards, each as its note: no Approve, until dismissed or opened. */
  readonly staleNotes?: readonly StaleNoteView[];
  readonly staleNoteActions?: { readonly dismiss: StaleNoteAction; readonly open: StaleNoteAction } | null;
}) {
  const forYou = tab === "for-you" && showForYouTab;
  return (
    <div
      className={styles.screen}
      data-view={threadOpen ? "thread" : "list"}
      /*
       * The For you tab does not switch panes at 390: png/approvals-390.png stacks them — the
       * day's rows as full-width cards, the thread under them, the van pane under that. The
       * list/thread switch belongs to the other two tabs, where a phone shows one conversation
       * at a time (family-texts.html's two phone frames).
       */
      data-tab={tab}
    >
      {/*
        * No `h1` and no header row of its own. Since #74 the title is the frame's — one 64 px
        * page header bar, one heading, read from the access table (src/ui/PageHeader.tsx) — so a
        * title here would be the second on the page, and a row holding nothing but a chip was a
        * band of empty white under it. The assistant's state chip (approvals.html
        * `.top .chip.info`) rides the tab strip instead, which is this screen's own row.
        */}
      <nav className={styles.tabs} aria-label={familyTexts.conversationsLabel}>
        {TABS.filter((key) => key !== "for-you" || showForYouTab).map((key) => (
          <Link
            key={key}
            href={hrefFor(key, null)}
            className={[styles.tab, key === tab ? styles.tabOn : ""].filter(Boolean).join(" ")}
            aria-current={key === tab ? "page" : undefined}
          >
            {TAB_LABELS[key]}
            {countFor(key, rows.length, proposals.length + changes.length + staleNotes.length, alerts.length) === null ? null : (
              <span className={styles.tabCount}>{countFor(key, rows.length, proposals.length + changes.length + staleNotes.length, alerts.length)}</span>
            )}
          </Link>
        ))}
        <span className={styles.headerSpacer} />
        {simulate && simulate.length > 0 ? <SimulateParentText options={simulate} /> : null}
      </nav>

      {/*
        * THREE PANES at 1440 (Firia, 2026-10-17 10:51 PM ET; mockups/approvals.html): the list,
        * the thread with the proposal card inline under the parent's message, and the van /
        * pick-up pane. The same three stack into one column at 390, which is what
        * png/approvals-390.png draws — one card per row, the thread below it, no second layout
        * and no second copy of the day's words.
        */}
      <div className={styles.work} data-panes={forYou ? "three" : "two"}>
        <div className={styles.listPane}>
          {forYou ? (
            <ForYouAlert
              alerts={alerts}
              alertsUnreadable={alertsUnreadable}
              takeAlert={takeAlert}
              assistantReachable={assistantReachable}
            />
          ) : null}
          {/*
            * THE EMPTY STATE (Firia's S1-2: "with no rows show the … empty state").
            *
            * Said as a fact about the day rather than about the build, which is what
            * `approval.none` already says on the screen this tab replaced. It is the whole of what
            * a coordinator gets when no proposal is waiting — there is no card any more for a day
            * with no approval rows in it, because a card is an offer to approve something and
            * there is nothing to approve.
            *
            * Not shown while an alert is up: "nothing is waiting" under a "needs a person" card
            * would be the tab contradicting itself in two lines.
            */}
          {/* A change to the day is the same panel the bubble shows, decided here or there (ledger #79). */}
          {forYou ? changes.map((panel) => <AgentPanel key={panel.id} panel={panel} />) : null}
          {forYou && staleNoteActions
            ? staleNotes.map((note) => <StaleNote key={note.approvalId} note={note} dismiss={staleNoteActions.dismiss} open={staleNoteActions.open} />)
            : null}
          {forYou && proposals.length === 0 && changes.length === 0 && staleNotes.length === 0 && alerts.length === 0 && !alertsUnreadable ? (
            <p className={styles.empty}>{approval.none}</p>
          ) : null}
          <ConversationList rows={rows} tab={tab} openKey={thread?.key ?? null} />
        </div>
        {thread === null ? (
          <p className={styles.empty}>{familyTexts.emptyDay}</p>
        ) : (
          <Thread
            thread={thread}
            tab={tab}
            editingId={editingId}
            decide={decide}
            assistantReachable={assistantReachable}
          />
        )}
        {forYou && context !== null ? <ContextPane context={context} /> : null}
      </div>
    </div>
  );
}

const TAB_LABELS: Readonly<Record<TabKey, string>> = {
  "for-you": familyTexts.tabForYou,
  sent: familyTexts.tabSent,
  all: familyTexts.tabAll,
};

/**
 * The number on a tab, or none.
 *
 * "For you" counts the proposals waiting **plus** the "needs a person" alerts, because both are
 * things this tab is where you deal with (Firia, 8:36 PM ET). "All" has no count: a total is not
 * a number anybody acts on.
 */
function countFor(key: TabKey, rows: number, proposals: number, alerts: number): number | null {
  const count = key === "for-you" ? proposals + alerts : key === "sent" ? rows : null;
  // A zero is not a count worth wearing: an empty tab says so in words inside it.
  return count === null || count === 0 ? null : count;
}

/**
 * This screen, with a tab and optionally a thread. One place builds the links.
 *
 * The "For you" address is `FAMILY_TEXTS_FOR_YOU` (src/auth/access.ts) and not a string written
 * here: it is also what `/approvals` is a 308 to (§9.2 — approvals *are* this tab), so the tab
 * strip and the redirect cannot drift to two different addresses.
 */
function hrefFor(tab: TabKey, threadKey: string | null): string {
  const base = tab === FOR_YOU_TAB ? FAMILY_TEXTS_FOR_YOU : `/family-texts?tab=${tab}`;
  return threadKey ? `${base}&thread=${encodeURIComponent(threadKey)}` : base;
}

/* ───────────────────────────── the list ───────────────────────────── */

function ConversationList({
  rows,
  tab,
  openKey,
}: {
  readonly rows: readonly ConversationRow[];
  readonly tab: TabKey;
  readonly openKey: string | null;
}) {
  return (
    <ul className={styles.list} aria-label={familyTexts.conversationsLabel}>
      {rows.map((row) => (
        <li key={row.key}>
          <Link
            href={hrefFor(tab, row.key)}
            className={[styles.row, row.key === openKey ? styles.rowOn : ""].filter(Boolean).join(" ")}
            aria-current={row.key === openKey ? "page" : undefined}
          >
            {row.unread ? (
              <span className={styles.dot}>
                <span className="srOnly">{familyTexts.unread}</span>
              </span>
            ) : (
              <span className={styles.dotOff} />
            )}
            <span className={styles.avatar} aria-hidden="true">
              {row.initials}
            </span>
            <span className={styles.rowBody}>
              <span className={styles.rowTop}>
                {/* approvals.html `.th .nm`: "Lee W. · Jonah", the child beside the adult. */}
                <span className={styles.rowName}>
                  {row.adultName}
                  <span className={styles.rowChild}>{fill(familyTexts.rowChild, { child: row.childFirstName })}</span>
                </span>
                <span className={styles.rowTime}>{row.timeLabel}</span>
              </span>
              <span className={styles.rowPreview}>{row.preview}</span>
              <StateChip state={ROW_STATES[row.state]} />
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

/* ───────────────────────────── the thread ───────────────────────────── */

function Thread({
  thread,
  tab,
  editingId,
  decide,
  assistantReachable,
}: {
  readonly thread: ThreadView;
  readonly tab: TabKey;
  readonly editingId: string | null;
  readonly decide: DecideAction;
  /** False when no model can be reached: no card renders at all (gate 5). */
  readonly assistantReachable: boolean;
}) {
  const editing = thread.proposal !== null && thread.proposal.approvalId === editingId;
  return (
    <section className={styles.thread} aria-label={thread.adultName}>
      <div className={styles.threadHeader}>
        {/* The phone's back chevron. Hidden at ≥768, where both panes are on screen. */}
        <Link href={hrefFor(tab, null)} className={styles.back}>
          <ChevronLeft size={icon.nav} aria-hidden="true" />
          <span className="srOnly">{familyTexts.backToList}</span>
        </Link>
        <span className={[styles.avatar, styles.threadAvatar].join(" ")} aria-hidden="true">
          {thread.initials}
        </span>
        <span className={styles.threadWho}>
          <span className={styles.threadName}>{thread.adultName}</span>
          <span className={styles.threadSub}>
            {fill(familyTexts.threadSubtitle, {
              relationship: thread.relationship,
              child: thread.childLabel,
            })}
          </span>
        </span>
        <StateChip state={{ icon: ShieldCheck, label: familyTexts.verified, tone: "ok" }} />
      </div>

      <div className={styles.messages} data-messages>
        {thread.runs.map((run) => (
          <Runs key={run.id} run={run} />
        ))}
        {thread.proposal === null || !assistantReachable ? null : (
          <AgentPanel panel={replyPanel(thread.proposal, hrefFor(tab, thread.key))} editing={editing} />
        )}
        {/* The thread opens at its newest message, so the card's own controls are on screen. */}
        <ThreadEnd />
      </div>

      <Composer
        adultName={thread.adultName}
        /* While the card is being edited its own Approve sends the edit; the bar does not send the draft. */
        approvalId={editing ? null : (thread.proposal?.approvalId ?? null)}
        draftText={thread.proposal?.draftText ?? ""}
        decide={decide}
      />
    </section>
  );
}

/** One run of bubbles: a centred timestamp, the bubbles, a tail on the last, one meta line. */
function Runs({ run }: { readonly run: ThreadView["runs"][number] }) {
  const side = run.side === "IN" ? styles.in : styles.out;
  const tail = run.side === "IN" ? styles.inTail : styles.outTail;
  return (
    <>
      <p className={styles.stamp}>
        <span className={styles.stampDay}>{run.stampDay}</span>
        <span>{` ${run.stampTime}`}</span>
      </p>
      {run.bubbles.map((bubble, index) => (
        <p
          key={bubble.id}
          /*
           * `data-bubble` is the author's side, which is *state* and not layout — which side of
           * the thread a message sits on is the one thing a bubble is (family-texts.html
           * `.b.in` / `.b.out`). The browser check measures the box it produces rather than
           * trusting the attribute (e2e/family-texts.spec.ts).
           */
          data-bubble={run.side}
          data-tail={index === run.bubbles.length - 1 ? "true" : undefined}
          className={[styles.bubble, side, index === run.bubbles.length - 1 ? tail : ""]
            .filter(Boolean)
            .join(" ")}
        >
          {bubble.body}
          {bubble.triage ? (
            <span className={styles.triage} data-triage={bubble.triage}>
              {familyTexts.triage[bubble.triage]}
            </span>
          ) : null}
        </p>
      ))}
      {run.meta === null ? null : (
        <p className={[styles.meta, run.side === "IN" ? styles.metaIn : styles.metaOut].join(" ")}>
          {run.meta}
        </p>
      )}
    </>
  );
}

/* ───────────────────────────── the "For you" tab ───────────────────────────── */

/**
 * The "needs a person" alert, at the top of the For you tab and above the day's list.
 *
 * It is first because it is the thing nobody has read — and because when the model is unreachable
 * it is the *only* thing to act on: no proposal card renders anywhere on the screen (gate 5),
 * since nothing read the family's text and so there is nothing anybody could be asked to approve.
 *
 * For a director and a coordinator alone: this whole tab is theirs (`APPROVAL_ROLES`), and the
 * front desk never reaches it — not the tab, not the page and not the action.
 */
function ForYouAlert({
  alerts,
  alertsUnreadable,
  assistantReachable,
  takeAlert,
}: {
  readonly alerts: readonly AssistantAlert[];
  readonly alertsUnreadable: boolean;
  readonly assistantReachable: boolean;
  readonly takeAlert: TakeAlertAction;
}) {
  if (assistantReachable && alerts.length === 0 && !alertsUnreadable) return null;
  return (
    <section className={styles.alert} aria-label={assistantUnavailable.heading}>
      <h2 className={styles.alertHeading}>{assistantUnavailable.heading}</h2>
      {alertsUnreadable ? <p className={styles.alertLine}>{assistantUnavailable.unreadable}</p> : null}
      {alerts.map((alert) => (
        <div key={alert.id}>
          <p className={styles.alertLine}>{alert.sentence}</p>
          {alert.theirWords ? <blockquote className={styles.alertWords}>{alert.theirWords}</blockquote> : null}
          {/* The family's own thread, beside the alert rather than whichever family is first in the list. */}
          {alert.threadHref ? (
            <Link href={alert.threadHref} className={styles.secondary} data-alert-open="">
              {assistantUnavailable.openText}
            </Link>
          ) : null}
          {/* The one place to fix what was in the way (ledger #80). */}
          {alert.fix ? (
            <Link href={alert.fix.href} className={styles.secondary}>
              {alert.fix.label}
            </Link>
          ) : null}
          {alert.beingHandled ? (
            <p className={styles.alertRule}>{assistantUnavailable.openedBy}</p>
          ) : (
            /*
             * The one thing that marks an alert taken (S1-4, Firia 12:13 AM ET). A POST, so a
             * render — or a link prefetch — can never claim an alert nobody has read.
             */
            <form action={takeAlert}>
              <input type="hidden" name="alert" value={alert.id} />
              <button type="submit" className={styles.secondary}>
                {assistantUnavailable.take}
              </button>
            </form>
          )}
        </div>
      ))}
      {!assistantReachable && alerts.length === 0 ? (
        <p className={styles.alertLine}>{familyTexts.assistantUnavailable}</p>
      ) : null}
      <p className={styles.alertRule}>{assistantUnavailable.rule}</p>
    </section>
  );
}

/* ───────────────────────────── the third pane ───────────────────────────── */

/**
 * The van / pick-up pane (mockups/approvals.html `aside.ctx`), beside the thread at 1440 and
 * below it at 390.
 *
 * Every line of it is read rather than decided here (`context.ts`): the van and its driver from
 * the day's own source, what the ride is doing as a **state chip** and never an ETA (Firia,
 * 10:51 PM ET), the four counts the van is left with after the change, and the adults the
 * family's file allows to collect the child.
 */
function ContextPane({ context }: { readonly context: ThreadContext }) {
  return (
    <aside className={styles.ctx} aria-label={familyTexts.rideContext}>
      <h2 className={styles.ctxHeading}>{context.childLabel}</h2>
      {context.vanLine === null ? null : (
        <p className={styles.ctxRow}>
          <span
            className={styles.ctxSwatch}
            data-van-colour={context.vanColourToken ?? undefined}
            aria-hidden="true"
          />
          <span>{context.vanLine}</span>
          <span className={styles.headerSpacer} />
          <StateChip state={context.rideState} />
        </p>
      )}

      {context.afterHeading === null ? null : (
        <>
          <h3 className={styles.ctxHeading}>{context.afterHeading}</h3>
          <ul className={styles.ctxCounts}>
            {context.after.map((count) => (
              <li key={count.key} className={styles.ctxCount}>
                <count.icon size={icon.inline} aria-hidden="true" />
                <span className={styles.ctxUsed}>{count.used}</span>
                <span className={styles.ctxTotal}>{`/${count.total}`}</span>
                <span className="srOnly">{count.label}</span>
              </li>
            ))}
          </ul>
        </>
      )}

      <h3 className={styles.ctxHeading}>{familyTexts.allowedPickup}</h3>
      <ul className={styles.ctxPickup}>
        {context.pickup.map((person) => (
          <li key={person.name} className={styles.ctxRow}>
            <span className={[styles.avatar, styles.ctxAvatar].join(" ")} aria-hidden="true">
              {person.initials}
            </span>
            <span>{person.name}</span>
            <span className={styles.headerSpacer} />
            <span className={styles.ctxRelationship}>{person.relationship}</span>
          </li>
        ))}
      </ul>
    </aside>
  );
}
