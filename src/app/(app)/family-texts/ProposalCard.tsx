"use client";

import { useActionState } from "react";
import { Check, Pencil, X } from "lucide-react";
import { approval, fill } from "@/ui/copy";
import { icon } from "@/ui/tokens";
import type { DecideAction, DecisionState } from "./actions";
import type { ProposalView } from "./conversations";
import styles from "./texts.module.css";

/**
 * THE APPROVE CARD, rendered inside the thread, under the message it answers.
 *
 * Four things and nothing else: **who the reply goes to** ("Reply to Dara"), **the message as a
 * bubble**, **one line of what the plan changes**, and **the three buttons**, worded exactly as
 * mockups/approvals.html words them. Vera's card (7:51 AM ET) was the first three minus the line;
 * the line arrived with Firia's 11:11 AM ruling, because Approve stopped being only a send — it
 * moves the leg's drop-off time, the placement and the receiver on the child's file, and a
 * coordinator signing for that has to be able to read it without knowing the plan by heart.
 *
 * ## What came off it, and why that is not a loss
 *
 *  - **The Stop / Time / Pick-up table.** The message already says what changes, in the words
 *    the family will read. The table said it again in a shape only somebody who already knew the
 *    plan could check, and it put a clock time on the card — which is the "NO Time row" half of
 *    the ruling, in the one place a stray time was still being drawn.
 *  - **The green check chips.** They were facts, and they are still facts: `queue.ts` computes
 *    them and `real-card-only.test.ts` holds them. A row of ticks over a decision is the screen
 *    reassuring itself, and a coordinator who trusts the ticks is not reading the sentence.
 *  - **"The text the family will get".** A label on a bubble that already looks like a text.
 *    The region's accessible name (`approval.cardLabel`) says it once, for a reader who cannot
 *    see that it is a bubble.
 *
 * ## The three controls are still the whole of Firia's gates 1 and 2
 *
 *  - **Approve & send** posts to `decideApprovalAction`, which calls `decideApproval` and nothing
 *    else. One write path, for all three controls (gate 1).
 *  - **Edit** is a `GET` to this same screen. It writes nothing and sends nothing: the card comes
 *    back *pending* with the message re-rendered through the same template, so **an edited
 *    message needs a fresh approval** (gate 2). Edit changes the words and only the words — it
 *    moves no ride, because the ride is saved by the decision and by nothing else.
 *  - **Don't send** posts the same action with `DECLINED`: the decision is written and nothing
 *    else happens.
 *
 * The words themselves are always `renderTemplate`'s output over the proposal's own template.
 * That is what keeps "no free text to a family" true of the approval path as well as the
 * automatic one.
 */
export function ProposalCard({
  proposal,
  decide,
  editHref,
  editing = false,
  className,
}: {
  readonly proposal: ProposalView;
  readonly decide: DecideAction;
  /** Where Edit submits: this screen, with the thread and tab it is already on. */
  readonly editHref: string;
  /** True in the state Edit navigates to, which is the only state with a field on it. */
  readonly editing?: boolean;
  readonly className?: string;
}) {
  const [state, submit, pending] = useActionState<DecisionState, FormData>(decide, { status: "idle" });

  return (
    <section
      className={[styles.card, className].filter(Boolean).join(" ")}
      aria-label={fill(approval.cardLabel, { adult: proposal.adultName })}
    >
      {/*
        * WHAT THIS CARD IS FOR, and who it goes to: "Reply to Dara" (Firia, 11:11 AM ET
        * 2026-10-18).
        *
        * The robot icon and the bare name are both gone. The icon said who *drafted* the words,
        * which is a fact about the build rather than about the decision — and it was the only
        * thing on the row a screen reader could be told, so a non-sighted reader got "Agent" and
        * the parent's name and had to infer the rest. The heading now says the act, in words, for
        * every reader: this is a reply, and it is going to this parent.
        */}
      <div className={styles.cardHead}>
        <h3 className={styles.cardTitle}>{fill(approval.replyTo, { parent: proposal.parentFirstName })}</h3>
      </div>

      {/*
        * The message, as a bubble — the same shape it will have in the thread when it is sent,
        * because it is the same words. Never shortened, and never the send step's furniture: the
        * STOP/HELP footer and the [DEMO] tag are appended by `renderForSend` and belong on a
        * family's phone, not on the thing a person is deciding (Firia, 2026-10-17 10:51 PM ET).
        */}
      <p className={[styles.bubble, styles.out, styles.cardBubble].join(" ")}>
        {proposal.draftText === "" ? approval.draftFailed : proposal.draftText}
      </p>

      {/*
        * ONE LINE OF WHAT THE PLAN DOES, under the words the family reads (same ruling).
        *
        * Approve is not a send any more — it moves the plan: the leg's drop-off time, the van the
        * child stays on, the adult recorded as receiving them (`modules/approvals/decide.ts`). The
        * bubble above says what the family is told; this says what a coordinator is signing for,
        * computed from the proposal and the placement the plan holds (`queue.ts`). Absent, rather
        * than vague, when those facts cannot be answered.
        */}
      {proposal.changeLine === "" ? null : (
        <p className={styles.changeLine}>{proposal.changeLine}</p>
      )}

      {/*
        * Edit's one field, in the state Edit navigates to and nowhere else. It is the message
        * that changes: the time is the one thing in these words a coordinator may move, so
        * moving it re-renders the sentence through the same template and leaves the proposal
        * PENDING, waiting for an approval of the new words.
        */}
      {editing ? (
        <form method="get" action={editHref} className={styles.editForm}>
          <input type="hidden" name="edit" value={proposal.approvalId} />
          <label className={styles.diffKey} htmlFor={`time-${proposal.approvalId}`}>
            {approval.editTimeLabel}
          </label>
          <input
            id={`time-${proposal.approvalId}`}
            className={styles.editTime}
            type="time"
            name="time"
            defaultValue={proposal.requestedHhmm ?? ""}
          />
          <button type="submit" className={styles.secondary}>
            <Pencil size={icon.inline} aria-hidden="true" />
            {approval.editApply}
          </button>
        </form>
      ) : null}

      {/*
        * The one action row (mockups/approvals.html `.acts`): three controls, teal first. Two
        * forms, because the three are two different kinds of thing — Edit is a navigation and the
        * other two are the decision — and HTML forms cannot nest, so they sit side by side in one
        * row and read as one bar.
        */}
      <div className={styles.actions}>
        {/* Approve and Don't send: the one write path, twice. */}
        <form action={submit} className={styles.decideForm}>
          <input type="hidden" name="approval" value={proposal.approvalId} />
          <input type="hidden" name="time" value={proposal.requestedHhmm ?? ""} />
          {/* The words this card is showing, so the decision is a signature on them and not on
            * whatever the row says by the time it is read (S1-7). */}
          <input type="hidden" name="text" value={proposal.draftText} />
          <button type="submit" name="decision" value="APPROVED" className={styles.primary} disabled={pending}>
            <Check size={icon.inline} aria-hidden="true" />
            {approval.approveAndSend}
          </button>
        </form>

        {/* Edit: a navigation, not a decision. It writes nothing and sends nothing (gate 2). */}
        {editing ? null : (
          <form method="get" action={editHref} className={styles.editForm}>
            <input type="hidden" name="edit" value={proposal.approvalId} />
            <button type="submit" className={styles.secondary}>
              <Pencil size={icon.inline} aria-hidden="true" />
              {approval.edit}
            </button>
          </form>
        )}

        {/* approvals.html `.acts .sp`: Don't send sits at the far end, away from the two
          * controls that go on with the change. */}
        <span className={styles.actionSpacer} />

        <form action={submit} className={styles.decideForm}>
          <input type="hidden" name="approval" value={proposal.approvalId} />
          <input type="hidden" name="time" value={proposal.requestedHhmm ?? ""} />
          {/* The words this card is showing, so the decision is a signature on them and not on
            * whatever the row says by the time it is read (S1-7). */}
          <input type="hidden" name="text" value={proposal.draftText} />
          <button type="submit" name="decision" value="DECLINED" className={styles.quiet} disabled={pending}>
            <X size={icon.inline} aria-hidden="true" />
            {approval.dontSend}
          </button>
        </form>
      </div>

      <p className={styles.outcome} role="status">
        {outcomeOf(state)}
      </p>
    </section>
  );
}

/**
 * What the card says after a decision, or before one.
 *
 * "Nothing until you approve" is the line that has to be there before anything is pressed: a
 * person reading a drafted text has to know the family has not seen it — the more so now that the
 * words sit in a bubble that will look exactly like this when it has been sent. Afterwards it is
 * what happened — including "approved, and nobody on this family's file may be texted", which is
 * a real outcome and not an error.
 */
function outcomeOf(state: DecisionState): string {
  if (state.status === "refused") return state.message;
  if (state.status !== "decided") return approval.nothingUntilApproved;
  if (state.decision === "DECLINED") return approval.declined;
  return state.queued === 0 ? approval.sentToNobody : approval.sent;
}
