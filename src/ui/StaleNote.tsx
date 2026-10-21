import { Route, X } from "lucide-react";
import type { StaleNoteAction, StaleNoteView } from "@/modules/actions/confirm-view";
import styles from "@/app/(app)/family-texts/texts.module.css";
import { confirmCopy } from "./copy";
import { icon } from "./tokens";

/**
 * A STALE AGENT PLAN CARD'S NOTE (Vera): where the card was on For you, one line and Plan
 * routes. Never an Approve — the card cannot be approved (the server refuses it with 422 too).
 * Both buttons are POSTs: opening Plan routes from here clears the note, then goes there.
 *
 * IT IS DRAWN AS A CARD, not as a refusal (Vera's second pass). The first version reused
 * `.refusedLine` — the crit-tone panel a panel's *refused press* leaves — with two browser-default
 * buttons under it, so the one thing on For you that is nobody's fault was the only red thing on
 * the screen and the only pair of unstyled buttons in the app. A card the board has moved past is
 * news, not an error, so it takes the same box every other thing waiting on this tab takes
 * (`AgentPanel`, the same stylesheet): white surface, teal hairline, the sentence in ink, Open
 * Plan routes as the one teal button and Dismiss as the quiet text button beside it. Reused
 * rather than restated — `.card`, `.cardHead`, `.cardTitle`, `.actions`, `.primary`, `.quiet` are
 * the panel's own classes, so a change to the card shape reaches this too and no colour is
 * written here.
 */
export function StaleNote({ note, dismiss, open }: { note: StaleNoteView; dismiss: StaleNoteAction; open: StaleNoteAction }) {
  return (
    <section className={styles.card} data-stale-note={note.approvalId} aria-label={note.says}>
      <div className={styles.cardHead}>
        <h3 className={styles.cardTitle}>{note.says}</h3>
      </div>
      <div className={styles.actions}>
        <form action={open}>
          <input type="hidden" name="card" value={note.approvalId} />
          <button type="submit" className={styles.primary} data-open-plan-routes="">
            <Route size={icon.inline} aria-hidden="true" />
            {note.fix.label}
          </button>
        </form>
        <span className={styles.actionSpacer} />
        <form action={dismiss}>
          <input type="hidden" name="card" value={note.approvalId} />
          <button type="submit" className={styles.quiet} data-dismiss="">
            <X size={icon.inline} aria-hidden="true" />
            {confirmCopy.staleNoteDismiss}
          </button>
        </form>
      </div>
    </section>
  );
}
