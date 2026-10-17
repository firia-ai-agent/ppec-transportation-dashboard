"use client";

import { approval as approvalCopy, fill, familyTexts } from "@/ui/copy";
import { clockLabel } from "@/ui/service-date";
import { useLiveTurn } from "./live-turn";
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
  modelReachKind,
}: {
  childKey: string;
  childFirstName: string;
  guardianName: string;
  /**
   * Which reader will answer on this deployment (`agent/run/deps.modelReach`), as a kind and
   * nothing else. The refusal's own `reason` names an environment variable and is for the server
   * log; this prop is the shape that makes "the reason is never rendered" structural rather than a
   * rule somebody has to remember — there is no reason here to render.
   */
  modelReachKind: "model" | "keyword" | "unavailable";
}) {
  /*
   * The turn is the panel's, not this component's: the bubbles inside the phone frame render the
   * same answer (`LiveTurn.tsx`), so the thread and these controls cannot disagree about what the
   * assistant did.
   */
  const { turnState, submitTurn, turnPending, approval, submitApproval, approvalPending, declined, decline } =
    useLiveTurn();

  const answered = turnState.status === "answered" ? turnState : null;
  const turn = answered?.turn;
  const sourceLine =
    turn?.source === "model" && turn.model
      ? fill(familyTexts.answeredByModel, { model: turn.model })
      : modelReachKind === "model"
        ? familyTexts.answeredByKeyword
        : null;

  return (
    <section className={styles.composer} aria-label={fill(familyTexts.composerHeading, { adult: guardianName })}>
      {/*
        Said before anybody presses the button, not only after a turn and not only in a server log
        (Vera's review, 2026-10-17): a deployment whose model is unreachable used to look perfectly
        healthy here, and the keyword reader's answer arrived with no sign that no model had seen
        the text. `role="status"` because it is a condition of the screen rather than a heading, and
        it is announced if it appears after load.
      */}
      {modelReachKind === "model" ? null : (
        <p className={styles.reachNotice} role="status" data-reach={modelReachKind}>
          {modelReachKind === "keyword" ? familyTexts.answeredByKeyword : familyTexts.assistantUnavailable}
        </p>
      )}
      <form action={submitTurn} className={styles.composerForm}>
        <input type="hidden" name="child" value={childKey} />
        <label className={styles.composerLabel} htmlFor="composer-text">
          {fill(familyTexts.composerHeading, { adult: guardianName })}
        </label>
        <textarea
          id="composer-text"
          name="text"
          className={styles.composerInput}
          rows={2}
          defaultValue={fill(familyTexts.composerExample, { child: childFirstName })}
        />
        <p className={styles.composerHint}>{familyTexts.composerHint}</p>
        <button type="submit" className={styles.primary} disabled={turnPending}>
          {turnPending ? familyTexts.composerSending : fill(familyTexts.composerSend, { adult: guardianName })}
        </button>
      </form>

      {turnState.status === "refused" ? <p className={styles.turnLead}>{turnState.message}</p> : null}

      {turn ? (
        <div className={styles.turn} data-verdict={turn.verdict} data-source={turn.source}>
          <h3 className={styles.turnHeading}>{familyTexts.turnHeading}</h3>
          {/*
            Who answered — said once. When no model is reachable at all, the notice above the
            composer has already said so, and a card that repeated the sentence would read as two
            different failures. What is left for the card is the case the notice cannot know: a
            deployment whose model *is* reachable, where this particular call still fell through to
            the keyword reader (a 429, a timeout, a dropped connection — providers/remote.ts).
          */}
          {sourceLine ? <p className={styles.turnSource}>{sourceLine}</p> : null}

          {turn.verdict === "BLOCK" ? (
            <>
              <p className={styles.turnLead}>{familyTexts.blockedLead}</p>
              <p className={styles.turnNote}>{familyTexts.nothingHappened}</p>
            </>
          ) : null}

          {turn.verdict === "PROPOSAL" ? (
            <>
              <p className={styles.turnLead}>{familyTexts.proposalLead}</p>
              {turn.dropoff && approval.status !== "approved" && !declined ? (
                <>
                  <p className={styles.turnChange}>
                    {fill(familyTexts.proposalChange, {
                      child: childFirstName,
                      before: turn.dropoff.plannedWindowText ?? "",
                      // The plan writes a time in 24 hours; no screen prints one (COPY-GUIDE §3).
                      after: clockLabel(turn.dropoff.requestedHhmm),
                    })}
                  </p>
                  {/* Vera's rule: the reassurance comes before either button, because the fear a
                      coordinator brings to this card is that reading it already sent something. */}
                  <p className={styles.turnNote}>{approvalCopy.nothingUntilApproved}</p>
                  <form action={submitApproval} className={styles.turnActions}>
                    <input type="hidden" name="child" value={childKey} />
                    <input type="hidden" name="text" value={answered?.text ?? ""} />
                    <button type="submit" className={styles.primary} disabled={approvalPending}>
                      {approvalCopy.approveAndSend}
                    </button>
                    <button type="button" className={styles.secondary} onClick={decline}>
                      {approvalCopy.dontSend}
                    </button>
                  </form>
                </>
              ) : null}
              {turn.dropoff === null ? <p className={styles.turnNote}>{familyTexts.proposalNoChange}</p> : null}
            </>
          ) : null}

          {turn.verdict === "ALLOW" && turn.source === "keyword" ? (
            <p className={styles.turnNote}>{familyTexts.nothingHappened}</p>
          ) : null}

          {declined ? <p className={styles.turnNote}>{familyTexts.declined}</p> : null}

          {approval.status === "approved" ? (
            <div className={styles.approved}>
              <p className={styles.turnLead}>
                {fill(familyTexts.approvedLead, {
                  child: childFirstName,
                  after: approval.applied.afterWindowText,
                })}
              </p>
              {/* The board's own line for that ride, as it reads after the change. */}
              <p className={`${styles.boardLine} tabularNums`}>
                {fill(familyTexts.approvedBoardLine, {
                  child: approval.applied.childLabel,
                  van: approval.applied.vanLabel ?? "",
                  after: approval.applied.afterWindowText,
                  place: approval.applied.place,
                })}
              </p>
              {/* …and the family's confirmation, in the thread, in the outbox's own words. */}
              <p className={styles.bubble}>{approval.applied.reply.body}</p>
              <p className={styles.turnNote}>{familyTexts.approvedReplyNote}</p>
            </div>
          ) : null}
          {approval.status === "refused" ? <p className={styles.turnLead}>{approval.message}</p> : null}
        </div>
      ) : null}
    </section>
  );
}
