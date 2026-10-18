"use client";

import { useActionState } from "react";
import { Bot, Check, Pencil, X } from "lucide-react";
import { approval, fill } from "@/ui/copy";
import { icon } from "@/ui/tokens";
import type { DecideAction, DecisionState } from "./actions";
import type { ProposalView } from "./conversations";
import styles from "./texts.module.css";

/**
 * THE APPROVE CARD, rendered inside the thread, under the message it answers.
 *
 * Three things and nothing else (Firia relaying Vera, 2026-10-18 7:51 AM ET): **the parent's
 * name**, **the message as a bubble**, and **the three buttons**, worded exactly as
 * mockups/approvals.html words them. A coordinator decides one question — do these words go to
 * this family — and everything the card used to put above that question was answering a
 * different one.
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
        * The parent's name, and the agent's mark beside it. The mark carries the author for a
        * screen reader (`approval.agentLabel`, Vera's S1-2 item a) — without it the card would
        * reach a non-sighted reader with no idea who wrote the words, because the one thing on
        * this row that says "the agent drafted this" is an icon.
        */}
      <div className={styles.cardHead}>
        <Bot size={icon.inline} role="img" aria-label={approval.agentLabel} />
        <h3 className={styles.cardTitle}>{proposal.adultName}</h3>
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
