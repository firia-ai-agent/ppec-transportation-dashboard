"use client";

import { useActionState } from "react";
import { SendHorizontal } from "lucide-react";
import { approval, familyTexts, fill } from "@/ui/copy";
import { icon } from "@/ui/tokens";
import type { DecideAction, DecisionState } from "./actions";
import styles from "./texts.module.css";

/**
 * THE ONE COMPOSE BAR (mockups/family-texts.html `.cmp`), pinned to the bottom of the thread.
 *
 * Firia's gate 3: *a person pressing Send is the approval.* So when a proposal is open, this bar's
 * Send is that proposal's "Approve and send" — the same server action, the same single write path
 * as the card above it (gate 1). A coordinator who has read the drafted reply and presses Send has
 * signed it, and that is the whole of what approving one means.
 *
 * When nothing is open there is nothing for Send to approve, and the bar says so rather than
 * looking live. It is not a stub for its own sake: free text from staff to a family has no path in
 * this app at all — `outbox.enqueue` composes from a template id and codes and refuses prose in a
 * var, and `free-text-egress.test.ts` holds that door shut for routes and server actions alike. A
 * Send that pretended to deliver a typed sentence would be the first hole in it. So the control is
 * honest about the state it is in, in the one wording this repo uses for a control that is not
 * wired (`familyTexts.composeNoProposal`), and the open proposal above is the way to answer this
 * family today.
 */
export function Composer({
  adultName,
  approvalId,
  draftText,
  editedTime,
  decide,
}: {
  readonly adultName: string;
  /** The proposal this bar's Send approves, or null when nothing is waiting. */
  readonly approvalId: string | null;
  /** The exact words Send would put on the family's phone, shown in the bar itself. */
  readonly draftText: string;
  /** The time the card currently shows, so Send approves what is on screen. */
  readonly editedTime: string | null;
  readonly decide: DecideAction;
}) {
  const [state, submit, pending] = useActionState<DecisionState, FormData>(decide, { status: "idle" });
  const ready = approvalId !== null;

  return (
    <>
      <form action={submit} className={styles.compose}>
        <input type="hidden" name="approval" value={approvalId ?? ""} />
        <input type="hidden" name="decision" value="APPROVED" />
        <input type="hidden" name="time" value={editedTime ?? ""} />
        <label className="srOnly" htmlFor="compose">
          {fill(familyTexts.composePlaceholder, { adult: adultName })}
        </label>
        {/*
          * Read-only on purpose. With a proposal open the bar shows the words Send would put on
          * the family's phone, so pressing it is signing something a person has read; with
          * nothing open there is nothing to send and the field is inert.
          */}
        <input
          id="compose"
          name="draft"
          className={styles.composeField}
          readOnly
          disabled={!ready}
          value={ready ? draftText : ""}
          placeholder={fill(familyTexts.composePlaceholder, { adult: adultName })}
        />
        <button type="submit" className={styles.composeSend} disabled={!ready || pending}>
          <SendHorizontal size={icon.inline} aria-hidden="true" />
          {familyTexts.composeAction}
        </button>
      </form>
      <p className={styles.composeNote} role="status">
        {noteOf(state, ready)}
      </p>
    </>
  );
}

function noteOf(state: DecisionState, ready: boolean): string {
  if (state.status === "refused") return state.message;
  if (state.status === "decided") {
    if (state.decision === "DECLINED") return approval.declined;
    return state.queued === 0 ? approval.sentToNobody : approval.sent;
  }
  return ready ? approval.nothingUntilApproved : familyTexts.composeNoProposal;
}
