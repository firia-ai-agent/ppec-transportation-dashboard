"use client";

/**
 * One proposal, and the decision (Vera's review, 2026-10-17 12:59 PM ET; PRD §11.2 human tier).
 *
 * Three things she settled, and each is a rule rather than a preference:
 *
 *  - **the exact text comes first.** Not a description of the change, not a diff of two times —
 *    the words the family's phone will show, in a bubble, rendered by the outbox's own renderer
 *    (`approvals.bodyOf`). What a coordinator is deciding *is* that sentence, so that sentence is
 *    what the screen leads with.
 *  - **"The family hears nothing until you approve" sits above both buttons**, because the fear a
 *    person brings to this screen is that reading it already sent something.
 *  - **the buttons say what happens**: "Approve and send", not "Approve" (which leaves "and then
 *    what?" open), and "Don't send", not "Decline" or "Reject" (which name a verdict on the
 *    assistant rather than an outcome for the family).
 *
 * ## What Edit edits
 *
 * The time, and only the time. Free text to a family is the one thing §11.2 holds behind a human
 * and there is none in this flow: the body is an allow-listed template with a date, a clock time
 * and a stop token in it, and no var on it can carry prose (Veri #12). So Edit reveals a time
 * field, the bubble above re-renders through the same renderer as you change it, and what you
 * approve is what you just read. `editHint` says that out loud, because a coordinator who expected
 * a textarea deserves to know why there isn't one rather than to think the screen is broken.
 *
 * A row the current copy cannot render shows `draftFailed` instead of an empty bubble, and both
 * buttons go: there is nothing to approve if nobody can see what would be sent.
 */
import { useActionState, useState } from "react";
import { approval as approvalCopy, board, fill } from "@/ui/copy";
import { clockLabel } from "@/ui/service-date";
import { decideApprovalAction, type DecisionState } from "./actions";
import type { PendingApproval } from "./approvals";
import styles from "./approvals.module.css";

export function ApprovalCard({ item, bodyFor }: {
  item: PendingApproval;
  /**
   * The body for a given time, rendered on the server and handed down as a map, so the client
   * never carries the outbox's copy or its renderer and the screen cannot drift from the send.
   */
  bodyFor: Readonly<Record<string, string>>;
}) {
  const [state, submit, pending] = useActionState<DecisionState, FormData>(decideApprovalAction, {
    status: "idle",
  });
  const [editing, setEditing] = useState(false);
  const [time, setTime] = useState(item.requestedTime ?? "");

  const text = bodyFor[time] ?? item.text;
  const ride = item.direction === "AM" ? board.amSpoken : board.pmSpoken;

  if (state.status === "decided") {
    return (
      <li className={styles.card} data-decision={state.decision}>
        <h3 className={styles.cardHeading}>{fill(approvalCopy.cardHeading, { child: item.childLabel, ride })}</h3>
        <p className={styles.outcome}>
          {state.decision === "DECLINED"
            ? approvalCopy.declined
            : state.queued > 0
              ? approvalCopy.sent
              : approvalCopy.sentToNobody}
        </p>
      </li>
    );
  }

  return (
    <li className={styles.card}>
      <h3 className={styles.cardHeading}>{fill(approvalCopy.cardHeading, { child: item.childLabel, ride })}</h3>
      <p className={styles.reason}>{reasonFor(item.rationaleCode)}</p>

      <h4 className={styles.textHeading}>{approvalCopy.exactTextHeading}</h4>
      {text ? (
        <p className={styles.bubble}>{text}</p>
      ) : (
        <p className={styles.outcome}>{approvalCopy.draftFailed}</p>
      )}

      {editing ? (
        <div className={styles.edit}>
          <label className={styles.editLabel} htmlFor={`time-${item.id}`}>
            {approvalCopy.editTimeLabel}
          </label>
          <select
            id={`time-${item.id}`}
            className={styles.editInput}
            value={time}
            onChange={(e) => setTime(e.target.value)}
          >
            {Object.keys(bodyFor).map((hhmm) => (
              <option key={hhmm} value={hhmm}>
                {clockLabel(hhmm)}
              </option>
            ))}
          </select>
          <p className={styles.hint}>{approvalCopy.editHint}</p>
          <button
            type="button"
            className={styles.secondary}
            onClick={() => {
              setTime(item.requestedTime ?? "");
              setEditing(false);
            }}
          >
            {approvalCopy.editCancel}
          </button>
        </div>
      ) : null}

      {/* Above both buttons, always, and never only in a tooltip. */}
      <p className={styles.reassurance}>{approvalCopy.nothingUntilApproved}</p>

      {text ? (
        <form action={submit} className={styles.actions}>
          <input type="hidden" name="approval" value={item.id} />
          <input type="hidden" name="time" value={time} />
          <button type="submit" name="decision" value="APPROVED" className={styles.primary} disabled={pending}>
            {approvalCopy.approveAndSend}
          </button>
          {editing ? null : (
            <button type="button" className={styles.secondary} onClick={() => setEditing(true)}>
              {approvalCopy.edit}
            </button>
          )}
          <button type="submit" name="decision" value="DECLINED" className={styles.secondary} disabled={pending}>
            {approvalCopy.dontSend}
          </button>
        </form>
      ) : null}

      {state.status === "refused" ? <p className={styles.outcome}>{state.message}</p> : null}
    </li>
  );
}

/** The family's reason in words. An unknown code reads as the general case, never as the code. */
function reasonFor(code: string): string {
  const reasons: Readonly<Record<string, string>> = approvalCopy.reasons;
  return reasons[code] ?? approvalCopy.reasons.OTHER;
}
