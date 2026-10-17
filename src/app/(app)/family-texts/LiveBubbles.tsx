"use client";

/**
 * The turn, as bubbles, at the bottom of the thread (PRD §18.2 steps 9–10).
 *
 * This is the half of the demo item that is about *where* the answer appears. A coordinator types
 * a text as the family and the assistant answers; both belong under the bubbles already in the
 * frame, because "what did we say to them" is a question a person asks of the thread, not of a
 * card beside it. So the live pair renders here, inside the phone, continuing the conversation —
 * and the controls stay beside the phone, over the same state (`LiveTurn.tsx`).
 *
 * Two bubbles, at most, and each one appears only when it is true:
 *
 *  - **the family's text**, as soon as the turn comes back. Not while it is in flight: a bubble
 *    that appeared before the assistant answered would be claiming a message arrived somewhere.
 *  - **the assistant's reply**, only once a person has approved it. That is the §11.2 rule made
 *    visual: a proposal is not a message, and a thread that showed the draft would be showing a
 *    family a text nobody had agreed to send. Until then the thread holds the family's text alone
 *    and the card beside it says what the assistant proposes.
 *
 * Neither carries a time or a delivery state, and both say so. The logged bubbles above them are
 * real rows with real timestamps and §3 ticks; these are this session's, on a simulated phone,
 * with nothing sent — so a time under them would be the one thing on this screen that could be
 * mistaken for a send that happened.
 */
import { familyTexts, places } from "@/ui/copy";
import { useLiveTurn } from "./live-turn";
import styles from "./phone.module.css";

export function LiveBubbles({ adult }: { adult: string }) {
  const { turnState, approval } = useLiveTurn();
  const typed = turnState.status === "answered" ? turnState.text : null;
  const reply = approval.status === "approved" ? approval.applied.reply.body : null;
  if (!typed && !reply) return null;

  return (
    <ol className={styles.liveThread} aria-label={familyTexts.liveHeading}>
      {typed ? <LiveBubble who={adult} direction="IN" body={typed} /> : null}
      {reply ? <LiveBubble who={places.center} direction="OUT" body={reply} /> : null}
      <li className={styles.liveNote}>{familyTexts.liveNote}</li>
    </ol>
  );
}

function LiveBubble({ who, direction, body }: { who: string; direction: "IN" | "OUT"; body: string }) {
  return (
    <li className={styles.bubbleRow} data-direction={direction} data-live="true">
      <p className={styles.bubbleWho}>{who}</p>
      <p className={styles.bubble}>{body}</p>
    </li>
  );
}
