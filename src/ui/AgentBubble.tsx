"use client";

import { useEffect, useSyncExternalStore, type ReactNode } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { MessageCircle, X } from "lucide-react";
import { agentBubble, fill } from "./copy";
import {
  AGENT_BUBBLE_OPEN_KEY,
  agentBubbleHidden,
  getAgentBubbleOpen,
  getAgentBubbleOpenOnServer,
  getAgentSeen,
  getAgentSeenOnServer,
  hasUnseen,
  setAgentBubbleOpen,
  setAgentSeen,
  subscribeAgentBubbleOpen,
  subscribeAgentSeen,
} from "./agent-bubble-state";
import { getAsked, getAskedOnServer, subscribeAsked } from "./agent-ask-state";
import type { PanelView } from "./panel";
import { AgentThread, type AgentThreadItem } from "./AgentThread";
import styles from "./AgentBubble.module.css";

/**
 * THE AGENT CHAT BUBBLE — the founder's ask of 2026-10-18: "a floating chat bubble at the bottom
 * right, inside the app frame, that opens the agent chat from any screen."
 *
 * Vera's binding mockup is /workspace/ppec-redesign/mockups/agent-bubble.html, with
 * png/agent-bubble-closed-1440.png, -open-1440.png, -closed-390.png and -open-390.png. What it
 * draws, and where each part of it is:
 *
 *  - **closed**: a 56 px teal disc with a chat icon and no visible label, 16 px from the frame's
 *    bottom-right corner (`.fab`). Below 768 it sits 16 px *above* the tab bar. A coral dot with
 *    a white ring rides on it while a proposal is waiting;
 *  - **open at 1440**: a 400 px white panel down the right-hand side, starting under the DEMO bar
 *    and with **no dark overlay** behind it (`.pnl`), and the disc is hidden while it is open;
 *  - **open at 390**: the same panel as a full sheet, over the tab bar, with a 44 px close X.
 *
 * MOUNTED ONCE, by src/ui/ConsoleShell.tsx, which is the component all four layouts render — so
 * it is on every app route, and a navigation between tabs re-renders the page inside the shell
 * without unmounting this. Open/closed is therefore not in the URL, which every link on the page
 * would rewrite; it is one value in src/ui/agent-bubble-state.ts, read here as an external store
 * and kept in sessionStorage so it also survives a full document load.
 *
 * WHAT IT IS NOT. It is not a second agent: a staff ask goes into the one run loop this app has
 * (src/modules/agent/run/loop.ts) through the one gateway, and every change it proposes waits for
 * a person on the existing approval path. Nothing here applies anything.
 */
export function AgentBubble({
  canDecide,
  waiting = 0,
  stamp = "",
  items = [],
  compose,
  panels = [],
}: {
  /**
   * `canOpenForYou(caller)` — resolved on the server by the layout that mounts the shell, never
   * by a list of roles in a component. False draws nothing at all (agent-bubble-state.ts).
   */
  canDecide: boolean;
  /**
   * How many proposals are waiting for a decision. The coral dot is drawn **iff** this is above
   * zero, and the count is in the button's accessible name rather than left to the dot.
   */
  waiting?: number;
  /**
   * The thread's pulse stamp (`ask/pulse.ts`, ledger #75 b). When it has moved past what this
   * browser last saw with the panel open, the closed bubble carries the dot: something new.
   */
  stamp?: string;
  /**
   * The thread, already read from what this app stores (src/modules/agent/ask/thread.ts) and
   * turned into what the panel draws. Nothing is invented here: a day with nothing in it renders
   * the empty line rather than a fixture conversation.
   */
  items?: readonly AgentThreadItem[];
  /** The compose bar, which is a form and therefore the server's to render. */
  compose?: ReactNode;
  /** Everything waiting for a person, as the one agent panel (ledger #79). */
  panels?: readonly PanelView[];
}) {
  const pathname = usePathname();
  const tab = useSearchParams().get("tab");
  const open = useSyncExternalStore(
    subscribeAgentBubbleOpen,
    getAgentBubbleOpen,
    getAgentBubbleOpenOnServer,
  );
  /*
   * EVERY ASK SHOWS, RIGHT AWAY (Firia and Vera, 2026-10-18 9:17 AM ET). `items` is the thread the
   * server read from what this app stores; `asked` is what this tab has asked since it loaded,
   * which the server has no row for — an ask is an `ops.task`, not a message
   * (src/modules/agent/ask/staff-ask.ts), so a `router.refresh()` cannot bring it back and the
   * bubble is the one place it can live. This component is mounted once by the shell and is not
   * unmounted by a navigation, which is what makes that true across a tab change.
   */
  const asked = useSyncExternalStore(subscribeAsked, getAsked, getAskedOnServer);
  const seen = useSyncExternalStore(subscribeAgentSeen, getAgentSeen, getAgentSeenOnServer);
  // Open is looking; a first visit starts from now. Either way this browser has seen `stamp`.
  useEffect(() => {
    if (stamp !== "" && (open || seen === null) && seen !== stamp) setAgentSeen(stamp);
  }, [open, seen, stamp]);

  if (agentBubbleHidden({ pathname, tab, canDecide })) return null;

  const unseen = !open && hasUnseen(stamp, seen);
  const dot = waiting > 0 || unseen;
  const label =
    waiting > 0 ? fill(agentBubble.openWaiting, { count: waiting }) : unseen ? agentBubble.openNew : agentBubble.open;

  return (
    /*
     * `data-agent-bubble` is the hook the browser check measures the disc's box by, and
     * `data-state` is the state it reads (MOCKUP-TEST-CONTRACT rule 4: `data-*` for state, never
     * for layout — the copy and the roles are what everything else is selected by).
     */
    <div className={styles.root} data-agent-bubble data-state={open ? "open" : "closed"}>
      {open ? null : (
        <button type="button" className={styles.bubble} aria-label={label} onClick={() => setAgentBubbleOpen(true)}>
          <MessageCircle size={24} aria-hidden="true" />
          {dot ? <span className={styles.dot} aria-hidden="true" data-agent-waiting /> : null}
        </button>
      )}
      {open ? (
        <aside className={styles.panel} role="dialog" aria-label={agentBubble.title}>
          <div className={styles.head}>
            <h2 className={styles.title}>{agentBubble.title}</h2>
            <button
              type="button"
              className={styles.close}
              aria-label={agentBubble.close}
              onClick={() => setAgentBubbleOpen(false)}
            >
              <X size={22} aria-hidden="true" />
            </button>
          </div>
          <AgentThread items={mergeAsked(items, asked)} panels={panels} />
          {compose}
        </aside>
      ) : null}
    </div>
  );
}

/** Re-exported so a test can name the one key without reaching past the component. */
export { AGENT_BUBBLE_OPEN_KEY };

/**
 * The server's thread, then what this tab asked that the server has not read back yet. One id per
 * ask on both sides (`agent-ask-state.addAsk`), so an ask, its answer and its "couldn't answer"
 * line each appear once whether the refresh has landed or not.
 */
function mergeAsked(items: readonly AgentThreadItem[], asked: readonly AgentThreadItem[]): readonly AgentThreadItem[] {
  if (asked.length === 0) return items;
  const idOf = (item: AgentThreadItem) => ("id" in item ? item.id : null);
  const seen = new Set(items.map(idOf));
  return [...items, ...asked.filter((item) => !seen.has(idOf(item)))];
}
