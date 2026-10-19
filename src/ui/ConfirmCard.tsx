"use client";

import { useActionState } from "react";
import { Check, X } from "lucide-react";
import type { ConfirmAction, ConfirmState } from "@/app/(app)/confirm/actions";
import type { ConfirmView } from "@/modules/actions/confirm-view";
import styles from "@/app/(app)/family-texts/texts.module.css";
import { confirmCopy } from "./copy";
import { icon } from "./tokens";

/**
 * A CHANGE THE AGENT PREPARED, FOR A PERSON TO PRESS (ledger #74 d).
 *
 * The reply card's shape (`family-texts/ProposalCard.tsx`) with less on it, because there is no
 * message to read: a heading, the one line of what Confirm would do, and two buttons. Confirm runs
 * the action as the person pressing it; Don't records that and changes nothing. The line under the
 * buttons says which happened — or why it could not be done.
 */
export function ConfirmCard({ card, confirm }: { readonly card: ConfirmView; readonly confirm: ConfirmAction }) {
  const [state, submit, pending] = useActionState<ConfirmState, FormData>(confirm, { status: "idle" });
  return (
    <section className={styles.card} aria-label={confirmCopy.heading}>
      <div className={styles.cardHead}>
        <h3 className={styles.cardTitle}>{card.impact.length > 0 ? card.summary : confirmCopy.heading}</h3>
      </div>
      {/* The model's own sentence when it wrote one (ledger #75 c); the action's line otherwise. */}
      {card.note || card.impact.length === 0 ? <p className={styles.changeLine}>{card.note ?? card.summary}</p> : null}
      {/* What it does to the day, generated from the plan (ledger #76): who moves, when, does it fit. */}
      {card.impact.length > 0 ? (
        <ul className={styles.impactList}>
          {card.impact.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      ) : null}
      <form action={submit} className={styles.actions}>
        <input type="hidden" name="card" value={card.approvalId} />
        <button type="submit" name="decision" value="APPROVED" className={styles.primary} disabled={pending}>
          <Check size={icon.inline} aria-hidden="true" />
          {confirmCopy.confirm}
        </button>
        <span className={styles.actionSpacer} />
        <button type="submit" name="decision" value="DECLINED" className={styles.quiet} disabled={pending}>
          <X size={icon.inline} aria-hidden="true" />
          {confirmCopy.dontDo}
        </button>
      </form>
      <p className={styles.outcome} role="status">
        {state.status === "refused"
          ? state.message
          : state.status === "done"
            ? state.decision === "APPROVED" ? confirmCopy.done : confirmCopy.declined
            : confirmCopy.pending}
      </p>
    </section>
  );
}
