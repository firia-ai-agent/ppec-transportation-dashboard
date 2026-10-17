"use client";

import { useActionState, useState } from "react";
import { fill, phonePanel } from "@/ui/copy";
import { clockLabel } from "@/ui/service-date";
import { approveAgentProposal, runAgentTurn, type ApprovalState, type TurnState } from "./actions";
import styles from "./phone.module.css";

/**
 * The assistant half of the panel (PRD §18.2 steps 9–10): a coordinator types the text a parent
 * would have sent, and watches what the assistant does with it.
 *
 * Three states, and the screen is explicit about which one it is in, because the difference is
 * the whole §11.2 rule:
 *
 *  1. **answered by a model** — the configured OpenRouter model, named by its id, because "which
 *     model said this" is the first thing a reviewer asks;
 *  2. **answered by the keyword reader** — the PRD §18.1 degraded mode, when no model is
 *     reachable. Said plainly, never dressed up as a model answer;
 *  3. **proposed, not done** — a `human`-tier call mutates nothing and sends nothing until a
 *     person approves it, and the card says so above the buttons rather than only in a tooltip.
 *
 * After approval the ride line changes and the family's confirmation appears in the thread — and
 * the note beside it says why *that* needed no second decision: it is an allow-listed template
 * with a time and a place in it, not words a model wrote. Free text to a parent is the one thing
 * §11.2 holds behind a human, and there is none in this flow.
 */
export function PhoneComposer({
  childKey,
  childFirstName,
  guardianName,
}: {
  childKey: string;
  childFirstName: string;
  guardianName: string;
}) {
  const [turnState, submitTurn, turnPending] = useActionState<TurnState, FormData>(runAgentTurn, {
    status: "idle",
  });
  const [approval, submitApproval, approvalPending] = useActionState<ApprovalState, FormData>(
    approveAgentProposal,
    { status: "idle" },
  );
  const [declined, setDeclined] = useState(false);

  const answered = turnState.status === "answered" ? turnState : null;
  const turn = answered?.turn;

  return (
    <section className={styles.composer} aria-label={fill(phonePanel.composerHeading, { adult: guardianName })}>
      <form action={submitTurn} className={styles.composerForm}>
        <input type="hidden" name="child" value={childKey} />
        <label className={styles.composerLabel} htmlFor="composer-text">
          {fill(phonePanel.composerHeading, { adult: guardianName })}
        </label>
        <textarea
          id="composer-text"
          name="text"
          className={styles.composerInput}
          rows={2}
          defaultValue={fill(phonePanel.composerExample, { child: childFirstName })}
        />
        <p className={styles.composerHint}>{phonePanel.composerHint}</p>
        <button type="submit" className={styles.primary} disabled={turnPending}>
          {turnPending ? phonePanel.composerSending : fill(phonePanel.composerSend, { adult: guardianName })}
        </button>
      </form>

      {turnState.status === "refused" ? <p className={styles.turnLead}>{turnState.message}</p> : null}

      {turn ? (
        <div className={styles.turn} data-verdict={turn.verdict} data-source={turn.source}>
          <h3 className={styles.turnHeading}>{phonePanel.turnHeading}</h3>
          <p className={styles.turnSource}>
            {turn.source === "model" && turn.model
              ? fill(phonePanel.answeredByModel, { model: turn.model })
              : phonePanel.answeredByKeyword}
          </p>

          {turn.verdict === "BLOCK" ? (
            <>
              <p className={styles.turnLead}>{phonePanel.blockedLead}</p>
              <p className={styles.turnNote}>{phonePanel.nothingHappened}</p>
            </>
          ) : null}

          {turn.verdict === "PROPOSAL" ? (
            <>
              <p className={styles.turnLead}>{phonePanel.proposalLead}</p>
              {turn.dropoff && approval.status !== "approved" && !declined ? (
                <>
                  <p className={styles.turnChange}>
                    {fill(phonePanel.proposalChange, {
                      child: childFirstName,
                      before: turn.dropoff.plannedWindowText ?? "",
                      // The plan writes a time in 24 hours; no screen prints one (COPY-GUIDE §3).
                      after: clockLabel(turn.dropoff.requestedHhmm),
                    })}
                  </p>
                  <form action={submitApproval} className={styles.turnActions}>
                    <input type="hidden" name="child" value={childKey} />
                    <input type="hidden" name="text" value={answered?.text ?? ""} />
                    <button type="submit" className={styles.primary} disabled={approvalPending}>
                      {phonePanel.approve}
                    </button>
                    <button type="button" className={styles.secondary} onClick={() => setDeclined(true)}>
                      {phonePanel.decline}
                    </button>
                  </form>
                </>
              ) : null}
              {turn.dropoff === null ? <p className={styles.turnNote}>{phonePanel.proposalNoChange}</p> : null}
            </>
          ) : null}

          {turn.verdict === "ALLOW" && turn.source === "keyword" ? (
            <p className={styles.turnNote}>{phonePanel.nothingHappened}</p>
          ) : null}

          {declined ? <p className={styles.turnNote}>{phonePanel.declined}</p> : null}

          {approval.status === "approved" ? (
            <div className={styles.approved}>
              <p className={styles.turnLead}>
                {fill(phonePanel.approvedLead, {
                  child: childFirstName,
                  after: approval.applied.afterWindowText,
                })}
              </p>
              {/* The board's own line for that ride, as it reads after the change. */}
              <p className={`${styles.boardLine} tabularNums`}>
                {fill(phonePanel.approvedBoardLine, {
                  child: approval.applied.childLabel,
                  van: approval.applied.vanLabel ?? "",
                  after: approval.applied.afterWindowText,
                  place: approval.applied.place,
                })}
              </p>
              {/* …and the family's confirmation, in the thread, in the outbox's own words. */}
              <p className={styles.bubble}>{approval.applied.reply.body}</p>
              <p className={styles.turnNote}>{phonePanel.approvedReplyNote}</p>
            </div>
          ) : null}
          {approval.status === "refused" ? <p className={styles.turnLead}>{approval.message}</p> : null}
        </div>
      ) : null}
    </section>
  );
}
