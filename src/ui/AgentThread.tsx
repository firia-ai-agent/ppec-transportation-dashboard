import Link from "next/link";
import { FAMILY_TEXTS_FOR_YOU } from "@/auth/access";
import { agentBubble, fill } from "./copy";
import styles from "./AgentThread.module.css";

/**
 * THE THREAD INSIDE THE BUBBLE — the same conversation Family texts → For you shows, drawn the
 * way Vera's mockup draws it (mockups/agent-bubble.html `.msgs`, and png/agent-bubble-open-1440
 * .png / -open-390.png):
 *
 *  - a centred day separator ("Today");
 *  - a driver's message as a **grey bubble on the left**, with "Name · Van N" above it;
 *  - a staff message as a **teal bubble on the right**;
 *  - a proposal as the **compact card** from mockups/family-texts.html (`.prop`): the question is
 *    the title and the one row under it is a single amber "Needs approval" chip. No details table
 *    and no clock times — that is the full For you card (mockups/approvals.html), which this is
 *    not; and no Approve · Edit · Skip, which is the ruling below.
 *
 * Presentational and pure: it renders the items it is handed and invents nothing. Where those
 * items come from is src/modules/agent/ask/thread.ts, which reads rows this app actually holds;
 * a day with no driver messages in it draws the day separator and the empty line, and that is the
 * honest answer rather than a fixture.
 */

export type AgentThreadItem =
  /** The centred day label above a group. */
  | { readonly kind: "day"; readonly label: string }
  /** A message from a driver: grey, left, with the speaker named above it. */
  | { readonly kind: "driver"; readonly id: string; readonly name: string; readonly van: number; readonly text: string }
  /** A message from staff: teal, right. */
  | { readonly kind: "staff"; readonly id: string; readonly text: string }
  /**
   * A change the agent has proposed and nobody has decided yet. `question` is the one line the
   * card is titled with. There is no `decide` here: deciding is a write, and the write path is
   * not on this branch (see the three actions below).
   */
  | { readonly kind: "proposal"; readonly id: string; readonly question: string };

export function AgentThread({ items }: { items: readonly AgentThreadItem[] }) {
  return (
    <div className={styles.thread}>
      {items.length === 0 ? <p className={styles.empty}>{agentBubble.empty}</p> : null}
      {items.map((item) => {
        switch (item.kind) {
          case "day":
            return (
              <p key={`day:${item.label}`} className={styles.day}>
                {item.label}
              </p>
            );
          case "driver":
            return (
              <div key={item.id} className={styles.group}>
                {/* "Marcus L. · Van 1" — the van is named, never numbered as a code (no-codes). */}
                <p className={styles.who}>{fill(agentBubble.speaker, { name: item.name, van: item.van })}</p>
                <p className={`${styles.bubble} ${styles.inbound}`}>{item.text}</p>
              </div>
            );
          case "staff":
            return (
              <p key={item.id} className={`${styles.bubble} ${styles.outbound}`}>
                {item.text}
              </p>
            );
          case "proposal":
            return <ProposalCard key={item.id} question={item.question} />;
        }
      })}
    </div>
  );
}

/**
 * The compact proposal card, and the one thing that is NOT on it: Approve, Edit and Skip.
 *
 * FIRIA AND VERA, 2026-10-18 9:17 AM ET. The mockup draws the three (png/agent-bubble-open-1440
 * .png), and this branch cannot honour any of them: approving, editing and skipping all change a
 * row, and the module that writes that change (`modules/approvals/decide.ts`) is being rebuilt on
 * #75 and is not on main. Three buttons that quietly navigate instead of deciding are a worse
 * answer than no buttons — somebody presses Approve, lands on another screen, and does not know
 * whether the thing was approved. So the row is one **amber chip** reading "Needs approval",
 * which is a statement of where the proposal is rather than an offer to act on it here.
 *
 * It is still a link, to the one place a decision is made and recorded: Family texts → For you,
 * which is what `/approvals` redirects to and which carries its own server guard. The bubble as a
 * whole is only drawn for somebody `canOpenForYou` allows, so this never offers a door the person
 * cannot open. The three come back, with their words and with #75's writer, when #75 merges.
 */
function ProposalCard({ question }: { question: string }) {
  return (
    <div className={styles.proposal} data-agent-proposal>
      <p className={styles.question}>{question}</p>
      <p className={styles.actions}>
        <Link className={styles.chip} href={FAMILY_TEXTS_FOR_YOU}>
          {agentBubble.needsApproval}
        </Link>
      </p>
    </div>
  );
}
