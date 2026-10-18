"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowUp } from "lucide-react";
import { API } from "@/auth/access";
import { agentAsk, agentBubble } from "./copy";
import styles from "./AgentCompose.module.css";

/**
 * THE COMPOSE BAR, pinned to the foot of the panel (mockups/agent-bubble.html `.cmp`, and
 * png/agent-bubble-open-{1440,390}.png): a rounded field reading "Ask the agent…" and a round
 * teal send button.
 *
 * One ask, one POST, and the server decides everything else (src/modules/agent/ask/staff-ask.ts):
 * a preview writes nothing, a deployment with no runner raises the staff alert, and a run that
 * proposes something leaves it for a person. Nothing here interprets the answer — it says one of
 * two lines and refreshes, so whatever landed on the board shows up in the thread above.
 *
 * The address comes from the access table's own `API` constant rather than being written here:
 * no screen in this app may contain an endpoint path (src/ui/no-internals.test.ts).
 */
export function AgentCompose() {
  const router = useRouter();
  const [text, setText] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  async function send(event: React.FormEvent) {
    event.preventDefault();
    if (!text.trim() || sending) return;
    setSending(true);
    setNotice(null);
    try {
      const res = await fetch(API.agentAsk, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
      });
      const body: unknown = await res.json().catch(() => null);
      const ok = typeof body === "object" && body !== null && (body as { ok?: unknown }).ok === true;
      setNotice(ok ? agentAsk.sent : agentAsk.unavailableNotice);
      if (res.ok) setText("");
      // Whatever the ask left on the board — the staff alert, or a proposal waiting — is read by
      // the server component above this one, so the thread catches up by re-rendering it.
      router.refresh();
    } catch {
      setNotice(agentAsk.unavailableNotice);
    } finally {
      setSending(false);
    }
  }

  return (
    <form className={styles.compose} onSubmit={send}>
      {notice === null ? null : (
        <p className={styles.notice} role="status">
          {notice}
        </p>
      )}
      <div className={styles.row}>
        <input
          className={styles.field}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={agentBubble.ask}
          aria-label={agentBubble.ask}
          disabled={sending}
        />
        <button type="submit" className={styles.send} aria-label={agentBubble.send} disabled={sending}>
          <ArrowUp size={18} aria-hidden="true" />
        </button>
      </div>
    </form>
  );
}
