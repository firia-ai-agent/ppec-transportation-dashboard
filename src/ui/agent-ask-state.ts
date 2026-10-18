import type { AgentThreadItem } from "./AgentThread";
import { agentBubble } from "./copy";

/**
 * EVERY ASK SHOWS, RIGHT AWAY (Firia and Vera, 2026-10-18 9:17 AM ET).
 *
 * The rule is one sentence: when staff press send, their words are in the thread before anything
 * is known about what will happen to them, and they stay there whatever happens. An ask that
 * disappears while a request is in flight is the worst thing a chat panel can do — the person
 * cannot tell whether they typed it, whether it sent, or whether to type it again.
 *
 * What the server does with the ask is unchanged and is not this file's business
 * (src/modules/agent/ask/staff-ask.ts): a preview writes nothing, a deployment with no runner
 * raises the staff alert, and a run that proposes something leaves it for a person. All this file
 * holds is what the *panel* shows while and after that happens.
 *
 * WHY A MODULE AND NOT A `useState`. The compose bar is a form rendered by the server (it is
 * handed to the bubble as a `ReactNode`), and the thread is drawn by the bubble — two components
 * on opposite sides of that boundary, with no shared parent on the client to hold a state between
 * them. One external store is the smallest thing that joins them, it is the shape
 * `useSyncExternalStore` already takes (see src/ui/agent-bubble-state.ts, which does the same for
 * open/closed), and — the reason that matters here — it is a plain value, so every rule below is
 * testable in node, which is where this repo's vitest runs.
 *
 * It is DELIBERATELY NOT persisted. An ask that could not be answered is not a message this app
 * stores, so remembering it past the tab's life would be the panel inventing a history; the thread
 * a reload reads is the one src/modules/agent/ask/thread.ts can actually account for.
 */

/** The two kinds this store can hold. A day separator is the server thread's, never an ask's. */
export type AskItem = Extract<AgentThreadItem, { kind: "staff" } | { kind: "agent" }>;

const EMPTY: readonly AskItem[] = [];

let asked: readonly AskItem[] = EMPTY;
let counter = 0;

const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function subscribeAsked(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => void listeners.delete(onChange);
}

/** What this tab has asked since it loaded, oldest first. */
export function getAsked(): readonly AskItem[] {
  return asked;
}

/**
 * The server's answer, and it is always nothing: a server has no tab to have asked in, and an
 * optimistic bubble rendered into the HTML would be markup the browser then has to take back.
 */
export function getAskedOnServer(): readonly AskItem[] {
  return EMPTY;
}

/** Tests only: the store is module state, so each case starts from an empty thread. */
export function resetAsked(): void {
  asked = EMPTY;
  counter = 0;
  emit();
}

/**
 * The teal bubble, added BEFORE the request leaves. Returns the id it was given, which is how the
 * reply below finds the ask it belongs under — ids rather than "the last one", because two asks
 * can be in flight and the second may well answer first.
 */
export function addAsk(text: string): string {
  counter += 1;
  const id = `ask:${counter}`;
  asked = [...asked, { kind: "staff", id, text }];
  emit();
  return id;
}

/**
 * The grey reply: "I can't answer right now." — one line, directly under the ask it answers.
 *
 * It says what is true and nothing else. It does not say why, because every why is a vendor, a
 * key or an outage and none of those is a coordinator's to read; and it does not guess at an
 * answer, because there is NO keyword fallback in this app and a sentence assembled from the
 * words of the question would be the panel pretending to have understood it.
 *
 * At most one reply per ask, whatever happens upstream: a retried or doubled response cannot put
 * the same sentence under the same question twice.
 */
export function addNoAnswer(askId: string): void {
  const id = `${askId}:no-answer`;
  if (asked.some((item) => item.id === id)) return;
  const at = asked.findIndex((item) => item.id === askId);
  if (at < 0) return;
  asked = [
    ...asked.slice(0, at + 1),
    { kind: "agent", id, text: agentBubble.noAnswer },
    ...asked.slice(at + 1),
  ];
  emit();
}

/** How the ask is sent. The address is the caller's (`API.agentAsk`): no screen holds a path. */
export type AskPost = (text: string) => Promise<Response>;

/**
 * ONE ASK, END TO END — the whole of what the compose bar does, as a function of its one
 * dependency, so the order of the two things it does is a thing a test can state.
 *
 * The order is the rule: the bubble is added, *then* the request is awaited. Nothing between those
 * two lines can remove the bubble, and nothing after them does either.
 *
 * Everything that is not an answer is the same answer. A network error, a 500, a 503, a preview
 * that wrote nothing (`previewSkip`), a runner that is not ok, a gateway PROVIDER_ERROR, a missing
 * key — the panel says one line for all of them, because the difference between them is the
 * server's to record and a coordinator's to be spared. The route already reduces them to `ok`
 * (src/app/api/agent/ask/route.ts), so this reads that and never a reason, a code or a status.
 */
export async function sendAsk(text: string, post: AskPost): Promise<void> {
  const id = addAsk(text);
  try {
    const res = await post(text);
    if (!res.ok) {
      addNoAnswer(id);
      return;
    }
    const body: unknown = await res.json().catch(() => null);
    const answered = typeof body === "object" && body !== null && (body as { ok?: unknown }).ok === true;
    if (!answered) addNoAnswer(id);
  } catch {
    addNoAnswer(id);
  }
}
