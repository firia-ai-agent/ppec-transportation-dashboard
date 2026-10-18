"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowUp } from "lucide-react";
import { API } from "@/auth/access";
import { sendAsk } from "./agent-ask-state";
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
 * The address comes from the access table's own `API` constant rather than being written here:
 * no screen in this app may contain an endpoint path (src/ui/no-internals.test.ts).
 */
export function AgentCompose() {
  const router = useRouter();
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);

  async function send(event: React.FormEvent) {
    event.preventDefault();
    const ask = text.trim();
    if (!ask || sending) return;
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

  return (
    <form className={styles.compose} onSubmit={send}>
      <div className={styles.row}>
        <input
          className={styles.field}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={agentBubble.ask}
          aria-label={agentBubble.ask}
        />
        <button type="submit" className={styles.send} aria-label={agentBubble.send} disabled={sending}>
          <ArrowUp size={18} aria-hidden="true" />
        </button>
      </div>
    </form>
  );
}
