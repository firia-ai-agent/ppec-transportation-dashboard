import type { StaleNoteAction, StaleNoteView } from "@/modules/actions/confirm-view";
import styles from "@/app/(app)/family-texts/texts.module.css";
import { confirmCopy } from "./copy";

/**
 * A STALE AGENT PLAN CARD'S NOTE (Vera, #124): where the card was on For you, one line and Plan
 * routes. Never an Approve — the card cannot be approved (the server refuses it with 422 too).
 * Both buttons are POSTs: opening Plan routes from here clears the note, then goes there.
 */
export function StaleNote({ note, dismiss, open }: { note: StaleNoteView; dismiss: StaleNoteAction; open: StaleNoteAction }) {
  return (
    <section className={styles.refusedLine} data-stale-note={note.approvalId} aria-label={note.says}>
      <p>{note.says}</p>
      <form action={open}>
        <input type="hidden" name="card" value={note.approvalId} />
        <button type="submit" data-open-plan-routes="">{note.fix.label}</button>
      </form>
      <form action={dismiss}>
        <input type="hidden" name="card" value={note.approvalId} />
        <button type="submit" data-dismiss="">{confirmCopy.staleNoteDismiss}</button>
      </form>
    </section>
  );
}
