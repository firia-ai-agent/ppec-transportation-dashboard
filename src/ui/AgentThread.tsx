import type { DecideAction } from "@/app/(app)/family-texts/actions";
import type { ProposalView } from "@/app/(app)/family-texts/conversations";
import { ProposalCard as DecisionCard } from "@/app/(app)/family-texts/ProposalCard";
import { FAMILY_TEXTS_FOR_YOU } from "@/auth/access";
import { agentBubble, fill } from "./copy";
import { Pill, PillLabel } from "./Pill";
import styles from "./AgentThread.module.css";

/**
 * THE THREAD INSIDE THE BUBBLE — the same conversation Family texts → For you shows, drawn the
 * way Vera's mockup draws it (mockups/agent-bubble.html `.msgs`, and png/agent-bubble-open-1440
 * .png / -open-390.png):
 *
 *  - a centred day separator ("Today");
 *  - a driver's message as a **grey bubble on the left**, with "Name · Van N" above it;
 *  - a staff message as a **teal bubble on the right**;
 *  - the agent's own reply as a grey bubble on the left with no name above it;
 *  - a proposal as the **compact card** from mockups/family-texts.html (`.prop`): the question is
 *    the title and the one row under it is a single amber "Needs approval" chip, which is plain
 *    text and not a control of any kind. No details table and no clock times — that is the full
 *    For you card (mockups/approvals.html), which this is not; and no Approve · Edit · Skip, which
 *    is the ruling below.
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
   * The agent answering: grey, left, and with no name above it — the one that speaks here is the
   * panel the person is typing into, so naming it would be labelling the app (and no screen in
   * this app says "AI" or names a vendor). On this branch the only thing it ever says is that it
   * cannot answer (src/ui/agent-ask-state.ts).
   */
  | { readonly kind: "agent"; readonly id: string; readonly text: string }
  /**
   * A change the agent has proposed and nobody has decided yet. `question` is the one line the
   * card is titled with. There is no `decide` here: deciding is a write, and the write path is
   * not on this branch (see the three actions below).
   */
  | { readonly kind: "proposal"; readonly id: string; readonly question: string };

export function AgentThread({
  items,
  cards = [],
  decide,
}: {
  items: readonly AgentThreadItem[];
  /**
   * THE REAL CARDS, for the proposals in `items` (founder, 2026-10-18: "the card shows up fully
   * rendered in two places: the bubble and Family texts"). The same `ProposalView`s Family texts
   * draws — read once by the shell through the same queue (`family-texts/queue.ts`) — and the same
   * card component, so the draft, the plan line and Approve are one thing in two places.
   */
  cards?: readonly ProposalView[];
  /** The one decision action (`family-texts/actions.ts`). Without it a proposal stays compact. */
  decide?: DecideAction;
}) {
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
          case "agent":
            return (
              <p key={item.id} className={`${styles.bubble} ${styles.inbound}`}>
                {item.text}
              </p>
            );
          case "proposal": {
            const card = cards.find((c) => c.approvalId === item.id);
            return card && decide ? (
              <DecisionCard
                key={item.id}
                proposal={card}
                decide={decide}
                // Edit opens the thread on Family texts, where the time field lives.
                editHref={`${FAMILY_TEXTS_FOR_YOU}&thread=${encodeURIComponent(card.threadKey)}`}
              />
            ) : (
              <ProposalCard key={item.id} question={item.question} />
            );
          }
        }
      })}
    </div>
  );
}

/**
 * The compact proposal card, and the two things that are NOT on it: Approve / Edit / Skip, and a
 * destination.
 *
 * FIRIA AND VERA, 2026-10-18 9:17 AM ET. The mockup draws the three buttons (png/agent-bubble-
 * open-1440.png), and this branch cannot honour any of them: approving, editing and skipping all
 * change a row, and the module that writes that change (`modules/approvals/decide.ts`) is being
 * rebuilt on #75 and is not on main. Three buttons that quietly navigate instead of deciding are
 * a worse answer than no buttons — somebody presses Approve, lands on another screen, and does not
 * know whether the thing was approved. So the row is one **amber chip** reading "Needs approval",
 * which is a statement of where the proposal is rather than an offer to act on it here.
 *
 * FIRIA, 2026-10-18 9:21 AM ET, which overrides the 9:17 reading of that same chip: the chip is
 * **plain text until #75 merges**. It is a `<span>` — no anchor, no `href`, no `Link`, no
 * `role="link"`, no `onClick`, no `tabIndex`. The earlier ruling left it as a link to Family texts
 * → For you, and a link is still an offer: the eye reads an amber pill inside a proposal card as
 * the thing to press, and pressing it leaves the panel for a screen whose decide path is #75's and
 * is not on main. A label that says where the proposal stands makes no offer at all, and that is
 * the whole of what this branch can honestly say. The chip becomes a control again — with #75's
 * writer behind it, and with the three words beside it — when #75 merges.
 *
 * The visibility guard is unchanged and is a separate rule: the bubble as a whole is only drawn
 * for somebody `canOpenForYou` allows (src/ui/agent-bubble-state.ts), so a role that may not
 * decide never sees a proposal at all.
 *
 * And now that it is plain text, it is THE ONE PILL (src/ui/Pill.tsx) with §8's `warn` tone on it
 * rather than a chip of its own. While it was a link it could not be — `Pill` renders a `<span>`
 * and nothing else — so this stylesheet carried a second pill-shaped rule, which is exactly what
 * src/ui/pill.test.ts exists to catch ("two of them drift"). Amber is the tone the Plan routes
 * board's own hints wear: the system's "this is waiting on somebody", which is what the words say.
 */
function ProposalCard({ question }: { question: string }) {
  return (
    <div className={styles.proposal} data-agent-proposal>
      <p className={styles.question}>{question}</p>
      <p className={styles.actions}>
        <Pill tone="warn">
          <PillLabel>{agentBubble.needsApproval}</PillLabel>
        </Pill>
      </p>
    </div>
  );
}
