import Link from "next/link";
import { assistantUnavailable } from "@/ui/copy";
import type { AlertThreadMessage, AssistantAlert } from "@/modules/agent/staff-alert";
import styles from "./alerts.module.css";

/**
 * The "needs a person" cards on SURF-05 (PRD §14 "Exceptions & Approvals").
 *
 * One card per family text the assistant could not read, because its model was unavailable
 * (founder, 2026-10-17: "never compensate with a deterministic text parser … the owner/staff
 * need to be notified"). The card's job is to be read in two seconds and acted on in one click:
 * who texted and about which ride, their own words underneath, and two ways into the thread.
 *
 * Three things it deliberately does not do:
 *
 *  - **It does not say why the model was down.** A timeout, a 429 on both models and a missing
 *    key are one situation from a coordinator's chair, and all three have the same next move.
 *    The reason class is in the server log and in the task's locator, where whoever is on call
 *    will look for it.
 *  - **It does not summarize.** `theirWords` is `ops.message.body_tokenized`, rendered as text —
 *    the family's sentence, with only the contact details the tokenizer replaces. Summarizing is
 *    the thing that could not be done; doing it here in code would be the same mistake in a
 *    different file.
 *  - **It does not offer a way to dismiss.** The card goes when the family has been answered, and
 *    this screen cannot know that. Opening it marks it taken (`Being handled`) and leaves it.
 *
 * ## Why the two controls are links and not a server action
 *
 * "Opening it" is a navigation — the coordinator goes to the thread — and the state change is a
 * consequence of arriving, not a separate thing they asked for. So both controls are ordinary
 * links to this same page with the alert named in the query, and the page marks the alert taken
 * when it renders that view (`page.tsx`).
 *
 * There is a second reason, and it is the binding one: a server action is a POST endpoint, and
 * `src/auth/access.test.ts` requires every one of them to have a row in `src/auth/access.ts` —
 * which the founder's ruling for this change says not to touch at all. A link needs no row,
 * because the page it leads to already has one, and that row is the same guard either way.
 */
export function AlertCards({
  alerts,
  thread,
  showReplyNote,
  unreadable,
}: {
  readonly alerts: readonly AssistantAlert[];
  /** The messages of the thread the coordinator opened, if they opened one. */
  readonly thread: { readonly alertId: string; readonly messages: readonly AlertThreadMessage[] } | null;
  /** True when they arrived here through Reply rather than Open text. */
  readonly showReplyNote: boolean;
  /** The board could not be read. Said out loud rather than shown as an empty list. */
  readonly unreadable: boolean;
}) {
  return (
    <section className={styles.section} aria-label={assistantUnavailable.heading}>
      <h2 className={styles.heading}>{assistantUnavailable.heading}</h2>
      {unreadable ? <p className={styles.notice}>{assistantUnavailable.unreadable}</p> : null}
      {alerts.length === 0 && !unreadable ? <p className={styles.empty}>{assistantUnavailable.none}</p> : null}

      <ul className={styles.list}>
        {alerts.map((alert) => (
          <li key={alert.id} className={styles.card}>
            <p className={styles.sentence}>{alert.sentence}</p>
            {alert.beingHandled ? <p className={styles.handled}>{assistantUnavailable.openedBy}</p> : null}

            <h3 className={styles.wordsLabel}>{assistantUnavailable.theirWords}</h3>
            {/* The family's own sentence. Plain text, never markup, never shortened. */}
            <blockquote className={styles.words}>{alert.theirWords}</blockquote>

            <div className={styles.buttons}>
              <Link href={openHref(alert, false)} className={styles.button}>
                {assistantUnavailable.openText}
              </Link>
              <Link href={openHref(alert, true)} className={styles.button}>
                {assistantUnavailable.reply}
              </Link>
            </div>

            {thread?.alertId === alert.id ? (
              <div className={styles.thread}>
                <h3 className={styles.wordsLabel}>{assistantUnavailable.threadHeading}</h3>
                <ul className={styles.threadList}>
                  {thread.messages.map((m) => (
                    <li key={m.id} className={styles.threadMessage}>
                      {m.body}
                    </li>
                  ))}
                </ul>
                {showReplyNote ? <p className={styles.notice}>{assistantUnavailable.noReplyBox}</p> : null}
              </div>
            ) : null}
          </li>
        ))}
      </ul>

      <p className={styles.rule}>{assistantUnavailable.rule}</p>
    </section>
  );
}

/**
 * Where a card's two controls go: this page, with the alert named.
 *
 * `open` is the alert id, which is what the page marks as being handled; `reply=1` only changes
 * what the thread panel says underneath, because there is no reply box yet and a control that
 * pretended otherwise would be worse than the sentence that says so.
 */
function openHref(alert: AssistantAlert, reply: boolean): string {
  const params = new URLSearchParams({ open: alert.id });
  if (reply) params.set("reply", "1");
  return `/exceptions?${params}`;
}
