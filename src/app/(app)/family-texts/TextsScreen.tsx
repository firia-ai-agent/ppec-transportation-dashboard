import Link from "next/link";
import { Bot, ChevronLeft, ShieldCheck } from "lucide-react";
import { StateChip } from "@/ui/StateChip";
import { approval, assistantUnavailable, familyTexts, fill } from "@/ui/copy";
import { icon } from "@/ui/tokens";
import type { AssistantAlert } from "@/modules/agent/staff-alert";
import { Composer } from "./Composer";
import { ProposalCard } from "./ProposalCard";
import { ROW_STATES } from "./row-state";
import type { ConversationRow, ProposalView, TabKey, ThreadView } from "./conversations";
import { TABS } from "./conversations";
import type { DecideAction } from "./actions";
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
  editedTime,
  threadOpen,
  decide,
  showForYouTab,
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
  /** A time a coordinator typed into Edit, already applied to the draft. */
  readonly editedTime: string | null;
  /** True when the URL names a thread: the phone shows the thread rather than the list. */
  readonly threadOpen: boolean;
  readonly decide: DecideAction;
  /**
   * Whether this caller may see the "For you" tab at all. The front desk may not — and the tab
   * being absent is the courtesy; the server refusing the action and the page is the guard.
   */
  readonly showForYouTab: boolean;
}) {
  const forYou = tab === "for-you" && showForYouTab;
  return (
    <div className={styles.screen} data-view={threadOpen ? "thread" : "list"}>
      <div className={styles.header}>
        <h1 className={styles.title}>{familyTexts.heading}</h1>
        <span className={styles.headerSpacer} />
        {assistantReachable ? (
          <StateChip state={{ icon: Bot, label: familyTexts.assistantOn, tone: "info" }} />
        ) : null}
      </div>

      <nav className={styles.tabs} aria-label={familyTexts.conversationsLabel}>
        {TABS.filter((key) => key !== "for-you" || showForYouTab).map((key) => (
          <Link
            key={key}
            href={hrefFor(key, null)}
            className={[styles.tab, key === tab ? styles.tabOn : ""].filter(Boolean).join(" ")}
            aria-current={key === tab ? "page" : undefined}
          >
            {TAB_LABELS[key]}
            {countFor(key, rows.length, proposals.length, alerts.length) === null ? null : (
              <span className={styles.tabCount}>{countFor(key, rows.length, proposals.length, alerts.length)}</span>
            )}
          </Link>
        ))}
      </nav>

      {forYou ? (
        <ForYou
          proposals={proposals}
          alerts={alerts}
          alertsUnreadable={alertsUnreadable}
          assistantReachable={assistantReachable}
          decide={decide}
        />
      ) : (
        <div className={styles.work}>
          <ConversationList rows={rows} tab={tab} openKey={thread?.key ?? null} />
          {thread === null ? (
            <p className={styles.empty}>{familyTexts.emptyDay}</p>
          ) : (
            <Thread thread={thread} tab={tab} editedTime={editedTime} decide={decide} />
          )}
        </div>
      )}
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

/** This screen, with a tab and optionally a thread. One place builds the links. */
function hrefFor(tab: TabKey, threadKey: string | null): string {
  const params = new URLSearchParams({ tab });
  if (threadKey) params.set("thread", threadKey);
  return `/family-texts?${params.toString()}`;
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
                <span className={styles.rowName}>{row.adultName}</span>
                <span className={styles.rowTime}>{row.timeLabel}</span>
              </span>
              <span className={styles.rowChild}>{row.childFirstName}</span>
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
  editedTime,
  decide,
}: {
  readonly thread: ThreadView;
  readonly tab: TabKey;
  readonly editedTime: string | null;
  readonly decide: DecideAction;
}) {
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

      <div className={styles.messages}>
        {thread.runs.map((run) => (
          <Runs key={run.id} run={run} />
        ))}
        {thread.proposal === null ? null : (
          <ProposalCard
            proposal={thread.proposal}
            decide={decide}
            editHref={hrefFor(tab, thread.key)}
          />
        )}
      </div>

      <Composer
        adultName={thread.adultName}
        approvalId={thread.proposal?.approvalId ?? null}
        draftText={thread.proposal?.draftText ?? ""}
        editedTime={editedTime ?? thread.proposal?.requestedHhmm ?? null}
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
          className={[styles.bubble, side, index === run.bubbles.length - 1 ? tail : ""]
            .filter(Boolean)
            .join(" ")}
        >
          {bubble.body}
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
 * The approvals queue: the alert first, then one card per row.
 *
 * The alert is at the top because it is the thing nobody has read — and because when the model is
 * unreachable it is the *only* thing on this tab: no card renders at all (gate 5), because nothing
 * read the family's text, so there is nothing anybody could be asked to approve.
 */
function ForYou({
  proposals,
  alerts,
  alertsUnreadable,
  assistantReachable,
  decide,
}: {
  readonly proposals: readonly ProposalView[];
  readonly alerts: readonly AssistantAlert[];
  readonly alertsUnreadable: boolean;
  readonly assistantReachable: boolean;
  readonly decide: DecideAction;
}) {
  const cards = assistantReachable ? proposals : [];
  return (
    <ul className={styles.forYou} aria-label={familyTexts.tabForYou}>
      {assistantReachable && alerts.length === 0 && !alertsUnreadable ? null : (
        <li className={styles.alert}>
          <h2 className={styles.alertHeading}>{assistantUnavailable.heading}</h2>
          {alertsUnreadable ? <p className={styles.alertLine}>{assistantUnavailable.unreadable}</p> : null}
          {alerts.map((alert) => (
            <div key={alert.id}>
              <p className={styles.alertLine}>{alert.sentence}</p>
              <blockquote className={styles.alertWords}>{alert.theirWords}</blockquote>
              {alert.beingHandled ? <p className={styles.alertRule}>{assistantUnavailable.openedBy}</p> : null}
            </div>
          ))}
          {!assistantReachable && alerts.length === 0 ? (
            <p className={styles.alertLine}>{familyTexts.assistantUnavailable}</p>
          ) : null}
          <p className={styles.alertRule}>{assistantUnavailable.rule}</p>
        </li>
      )}

      {cards.length > 0 || !assistantReachable ? null : (
        <li>
          <p className={styles.empty}>{familyTexts.noneForYou}</p>
        </li>
      )}
      {cards.length === 0 ? null : (
        cards.map((proposal) => (
          <li key={proposal.approvalId}>
            <ProposalCard
              proposal={proposal}
              decide={decide}
              editHref={hrefFor("for-you", proposal.threadKey)}
              className={styles.forYouCard}
            />
          </li>
        ))
      )}
    </ul>
  );
}
