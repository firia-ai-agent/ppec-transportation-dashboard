"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowUp } from "lucide-react";
import { API } from "@/auth/access";
import { canSendAsk, sendAsk } from "./agent-ask-state";
import { agentBubble } from "./copy";
import styles from "./AgentCompose.module.css";

/**
 * THE COMPOSE BAR, pinned to the foot of the panel (mockups/agent-bubble.html `.cmp`, and
 * png/agent-bubble-open-{1440,390}.png): a rounded field reading "Ask the agent…" and a round
 * teal send button.
 *
 * EVERY ASK SHOWS, RIGHT AWAY (Firia and Vera, 2026-10-18 9:17 AM ET). Pressing send puts the
 * words in the thread as a teal bubble and empties the field in the same breath, before the
 * request leaves and whatever comes back of it. The field is cleared here rather than on a
 * successful response for exactly that reason: the ask is in the thread now, so leaving it in the
 * box as well would be the same sentence twice and an invitation to send it again.
 *
 * One ask, one POST, and the server decides everything else (src/modules/agent/ask/staff-ask.ts):
 * a preview writes nothing, a deployment with no runner raises the staff alert, and a run that
 * proposes something leaves it for a person. Nothing here interprets the answer — the order of
 * the two things that happen, and the one line said when nothing could be answered, are both in
 * src/ui/agent-ask-state.ts, which is where they can be tested.
 *
 * THE SEND BUTTON IS GREY UNTIL THERE IS SOMETHING TO SEND. A bright teal disc over an empty
 * field is an offer the app cannot keep — `askAgent` writes nothing for an empty ask, so pressing
 * it would put a teal bubble of nothing in the thread and a grey "I can't answer right now." under
 * it, the panel answering a question nobody asked. Whitespace counts as empty: three spaces look
 * exactly like none. §4.2's rule is that a control nobody can use has to look like one *before* it
 * is clicked, and the disabled pair in tokens.ts is what it looks like (AgentCompose.module.css
 * `.send:disabled`) — a real `disabled` attribute, so it is out of the tab order too, with
 * `aria-disabled` beside it for the readers that announce the state rather than skip the node.
 *
 * Enter is the other way in, and it is guarded in the same breath: a one-field form submits on
 * Enter, so the handler asks `canSendAsk` the same question the button's `disabled` asked, and
 * `sendAsk` asks it a third time in front of the fetch. One predicate, three readers, no way for
 * them to disagree.
 *
 * The address comes from the access table's own `API` constant rather than being written here:
 * no screen in this app may contain an endpoint path (src/ui/no-internals.test.ts).
 */
export function AgentCompose() {
  const router = useRouter();
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);

  async function send(event: React.FormEvent) {
    event.preventDefault();
    // The same question the button's `disabled` asked, because Enter does not ask the button.
    if (!canSendAsk(text) || sending) return;
    const ask = text.trim();
    setSending(true);
    // The ask is in the thread from here on, so the box it was typed into is empty from here on.
    setText("");
    try {
      await sendAsk(ask, (body) =>
        fetch(API.agentAsk, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: body }),
        }),
      );
      // Whatever the ask left on the board — the staff alert, or a proposal waiting — is read by
      // the server component above this one, so the thread catches up by re-rendering it. The
      // teal bubble and its reply are the client's and survive that refresh.
      router.refresh();
    } finally {
      setSending(false);
    }
  }

  return <ComposeBar text={text} sending={sending} onChangeText={setText} onSubmit={send} />;
}

/**
 * The bar itself, as a pure function of the two values above it.
 *
 * It is split out for one reason: this repo's vitest runs in node, with no DOM and no
 * testing-library, so "the button is grey over three spaces and teal over 'hi'" can only be an
 * assertion about rendered markup if the text can be handed in rather than typed. Everything that
 * decides anything is still one line — `canSendAsk(text)` — and it is the same line `send` above
 * and `sendAsk` both read.
 */
export function ComposeBar({
  text,
  sending,
  onChangeText,
  onSubmit,
}: {
  /** What is in the field right now. */
  text: string;
  /** A request is in flight: the button is grey for that too, so one ask cannot become two. */
  sending: boolean;
  onChangeText: (next: string) => void;
  onSubmit: (event: React.FormEvent) => void;
}) {
  /** Nothing to send, or something already going: either way the disc is grey and inert. */
  const blocked = !canSendAsk(text) || sending;

  return (
    <form className={styles.compose} onSubmit={onSubmit}>
      <div className={styles.row}>
        <input
          className={styles.field}
          value={text}
          onChange={(e) => onChangeText(e.target.value)}
          placeholder={agentBubble.ask}
          aria-label={agentBubble.ask}
        />
        <button
          type="submit"
          className={styles.send}
          aria-label={agentBubble.send}
          disabled={blocked}
          aria-disabled={blocked}
        >
          <ArrowUp size={18} aria-hidden="true" />
        </button>
      </div>
    </form>
  );
}
