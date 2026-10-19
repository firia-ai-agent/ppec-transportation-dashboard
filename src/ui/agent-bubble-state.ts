import { FAMILY_TEXTS_FOR_YOU, FOR_YOU_TAB } from "@/auth/access";

/**
 * The three decisions the agent bubble makes that are not React — kept out of the component so
 * they can be tested in node, where this repo's vitest runs (no DOM, no testing-library).
 *
 * The component (src/ui/AgentBubble.tsx) is the markup and the one `useState`; everything here
 * is a pure function of its inputs, which is why "hidden on For you" and "the open/closed state
 * survives a navigation" are assertions about values rather than about a browser.
 */

/**
 * The path half of `FAMILY_TEXTS_FOR_YOU`, split off it rather than written again: the address of
 * the For you tab is one string in src/auth/access.ts and this file must not become a second.
 */
export const FAMILY_TEXTS_PATH = FAMILY_TEXTS_FOR_YOU.split("?")[0];

/**
 * WHERE THE BUBBLE IS NOT DRAWN.
 *
 * Two rules, and they are different rules:
 *
 *  1. **Family texts → For you** (`/family-texts?tab=for-you`). The bubble's thread *is* that
 *     screen — the same proposals, the same decisions — so a floating copy of a screen on top of
 *     itself is two places to approve the same thing. The founder's ask is "the agent from any
 *     screen"; this is the screen.
 *  2. **Anyone who may not open For you.** `canOpenForYou` is `APPROVAL_ROLES` (src/auth/access.ts)
 *     and the front desk is not in it: the bubble shows proposals waiting for a decision, so
 *     drawing it for a role that may not decide would put the approvals queue on the live map and
 *     the ramp iPad — the two screens the front desk has. This mirrors the server's answer rather
 *     than inventing a second one; the caller is resolved by the layout's own guard and handed to
 *     the component as a boolean, so no component ever holds a list of roles.
 *
 * Rule 2 is a *visibility* rule on top of a server rule, never instead of one: nothing the bubble
 * can reach is unguarded (the ask route and the For you page both check the caller again).
 */
export function agentBubbleHidden(where: {
  /** The current path, from `usePathname()`. */
  pathname: string;
  /** The `tab` query parameter, from `useSearchParams()`. `null` when there is none. */
  tab: string | null;
  /** `canOpenForYou(caller)`, resolved on the server by the layout that mounts the shell. */
  canDecide: boolean;
}): boolean {
  if (!where.canDecide) return true;
  return where.pathname === FAMILY_TEXTS_PATH && where.tab === FOR_YOU_TAB;
}

/**
 * WHERE THE OPEN/CLOSED STATE LIVES.
 *
 * The bubble is mounted by src/ui/ConsoleShell.tsx, which four layouts render, so a client-side
 * navigation between Today, Plan routes, Live map, Ramp iPad and Family texts does not unmount
 * it: React keeps the component — and its `useState` — across the route change, and that is the
 * primary answer to "the state survives navigation between tabs".
 *
 * `sessionStorage` is the second half, for the navigation React cannot keep: a full document load
 * (a typed URL, a reload, the back button after a server redirect). One key, one of two strings,
 * scoped to the tab and gone when it closes. Nothing about a person or a child is written here —
 * it is a boolean about a panel.
 */
export const AGENT_BUBBLE_OPEN_KEY = "ppec.agent-bubble.open";

/** The minimum of `Storage` this needs, so a test can pass a Map-backed stand-in. */
export type OpenStore = Pick<Storage, "getItem" | "setItem">;

export function readAgentBubbleOpen(store: OpenStore | null | undefined): boolean {
  if (!store) return false;
  try {
    return store.getItem(AGENT_BUBBLE_OPEN_KEY) === "1";
  } catch {
    // Private browsing and a blocked third-party context both throw here. A panel that cannot
    // remember it was open is a smaller problem than a screen that will not render.
    return false;
  }
}

export function writeAgentBubbleOpen(store: OpenStore | null | undefined, open: boolean): void {
  if (!store) return;
  try {
    store.setItem(AGENT_BUBBLE_OPEN_KEY, open ? "1" : "0");
  } catch {
    /* see above */
  }
}

/**
 * …AND HOW REACT READS IT: as an external store (`useSyncExternalStore`), not as a `useState`
 * seeded by an effect.
 *
 * Both would survive a tab change — the component is in the layout either way — but the effect
 * version has to call `setState` during the first commit to catch up with sessionStorage, which
 * is a cascading render and which this repo's lint rules out (react-hooks/set-state-in-effect).
 * An external store is the shape React provides for exactly this: one value, read on demand,
 * with a server snapshot that is always `false` so the markup the server sends and the markup
 * the browser hydrates with agree, and a re-render straight afterwards if they turn out not to.
 *
 * There is one bubble in the app (src/ui/ConsoleShell.tsx mounts it once), so one module-level
 * subscriber set is the whole of the store.
 */
const listeners = new Set<() => void>();

export function subscribeAgentBubbleOpen(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => void listeners.delete(onChange);
}

/** The browser's answer: whatever this tab last chose. */
export function getAgentBubbleOpen(): boolean {
  return readAgentBubbleOpen(globalThis.sessionStorage);
}

/**
 * The server's answer, and it is always closed: a server has no session storage, and a panel
 * that rendered open on the server would be markup the browser then has to take back.
 */
export function getAgentBubbleOpenOnServer(): boolean {
  return false;
}

export function setAgentBubbleOpen(open: boolean): void {
  writeAgentBubbleOpen(globalThis.sessionStorage, open);
  for (const listener of listeners) listener();
}

/**
 * WHAT THIS PERSON HAS ALREADY SEEN (ledger #75 b): the thread's pulse stamp (`ask/pulse.ts`) as it
 * was the last time the panel was open. When the thread moves past it — the agent heard an alert,
 * answered, drafted a card — the closed bubble carries the dot, the way a colleague's tap on the
 * shoulder says "something for you" before you know what. `localStorage`, so it holds across tabs
 * and reloads on this browser; a stamp, never anything about a person.
 */
export const AGENT_SEEN_KEY = "ppec.agent-bubble.seen";
const seenListeners = new Set<() => void>();

export function subscribeAgentSeen(onChange: () => void): () => void {
  seenListeners.add(onChange);
  return () => void seenListeners.delete(onChange);
}

export function getAgentSeen(): string | null {
  try {
    return globalThis.localStorage?.getItem(AGENT_SEEN_KEY) ?? null;
  } catch {
    return null;
  }
}

/** The server has seen nothing and claims nothing: no dot until the browser says otherwise. */
export function getAgentSeenOnServer(): string | null {
  return null;
}

export function setAgentSeen(stamp: string): void {
  try {
    globalThis.localStorage?.setItem(AGENT_SEEN_KEY, stamp);
  } catch {
    /* a browser that cannot remember shows no dot, which is the quiet failure */
  }
  for (const listener of seenListeners) listener();
}

/**
 * Is there something new? Only against a stamp this browser has recorded: a first visit has seen
 * nothing yet, and a dot for "everything that ever happened" would be noise, not a tap.
 */
export function hasUnseen(stamp: string, seen: string | null): boolean {
  return stamp !== "" && seen !== null && stamp > seen;
}
