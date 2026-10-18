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
 *  2. **no model answered** — no key, an unconfirmed deployment, a chain that failed. There is no
 *     reader behind the model (founder, 2026-10-17), so no proposal card renders at all and the
 *     screen says a person has to take this one;
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
  modelReachKind: "model" | "unavailable";
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
  /*
   * Which reader answered — and only that. The model's id is deliberately not read here: Vera's
   * review (2026-10-17 14:40 ET) rules it off a staff screen, and the way to keep it off is for
   * the render path not to touch `turn.model` at all rather than for the copy to stop having a
   * `{model}` placeholder. The id is still on the turn, for the server-side record.
   */
  const sourceLine = turn && !turn.modelUnavailable ? familyTexts.answeredByModel : null;

  return (
    <section className={styles.composer} aria-label={fill(familyTexts.composerHeading, { adult: guardianName })}>
      {/*
        Said before anybody presses the button, not only after a turn and not only in a server log
        (Vera's review, 2026-10-17): a deployment whose model is unreachable used to look perfectly
        healthy here, and an answer arrived with no sign that no model had seen the text.
        `role="status"` because it is a condition of the screen rather than a heading, and it is
        announced if it appears after load.
      */}
      {modelReachKind === "model" ? null : (
        <p className={styles.reachNotice} role="status" data-reach={modelReachKind}>
          {familyTexts.assistantUnavailable}
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
        <div
          className={styles.turn}
          data-verdict={turn.verdict}
          data-source={turn.modelUnavailable ? "none" : "model"}
        >
          <h3 className={styles.turnHeading}>{familyTexts.turnHeading}</h3>
          {/*
            Who answered — said once, and only when a model did. When none did, the notice above
            the composer has already said so and the card carries no proposal to label.
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
              {turn.dropoff && !turn.modelUnavailable && approval.status !== "approved" && !declined ? (
                <>
                  <p className={styles.turnChange}>
                    {fill(familyTexts.proposalChange, {
                      child: childFirstName,
                      before: turn.dropoff.plannedWindowText ?? "",
                      // The plan writes a time in 24 hours; no screen prints one (COPY-GUIDE §3).
                      after: turn.dropoff.requestedHhmm ? clockLabel(turn.dropoff.requestedHhmm) : "",
                    })}
                  </p>
                  {/* Vera's rule: the reassurance comes before either button, because the fear a
                      coordinator brings to this card is that reading it already sent something. */}
                  <p className={styles.turnNote}>{approvalCopy.nothingUntilApproved}</p>
                  <form action={submitApproval} className={styles.turnActions}>
                    <input type="hidden" name="child" value={childKey} />
                    <input type="hidden" name="tool" value={turn.tool} />
                    <input type="hidden" name="args" value={JSON.stringify(turn.args)} />
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

          {turn.verdict === "ALLOW" && turn.modelUnavailable ? (
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
