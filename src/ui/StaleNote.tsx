import { Route, X } from "lucide-react";
import type { StaleNoteAction, StaleNoteView } from "@/modules/actions/confirm-view";
import styles from "@/app/(app)/family-texts/texts.module.css";
import { confirmCopy } from "./copy";
import { icon } from "./tokens";

/**
 * A STALE AGENT PLAN CARD (Vera): one card, its own bold line ("Move Noah to Van 1, afternoon."),
 * and where Approve and Don't would be, the reason it cannot be approved — "Noah's plan changed
 * after this card was written." — with Open Plan routes and a quiet Dismiss. The same card on For
 * you and in the bubble; never a second card or line beside it. No Approve: the server refuses it
 * by id with 422 too. Both buttons are POSTs: opening Plan routes clears the note, then goes there.
 * The panel's own classes, so it is the same box as every live card and no colour is written here.
 */
export function StaleNote({ note, dismiss, open, className }: { note: StaleNoteView; dismiss: StaleNoteAction; open: StaleNoteAction; className?: string }) {
  return (
    <section className={[styles.card, className].filter(Boolean).join(" ")} data-stale-note={note.approvalId} aria-label={note.title}>
      <div className={styles.cardHead}>
        <h3 className={styles.cardTitle}>{note.title}</h3>
      </div>
      <p className={styles.staleSays} data-stale-says="">{note.says}</p>
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
