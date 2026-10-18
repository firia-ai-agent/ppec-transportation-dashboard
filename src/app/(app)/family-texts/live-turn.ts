"use client";

/**
 * ONE TURN, SHARED BY THE THREAD AND THE COMPOSER — the shape of it (PRD §18.2 steps 9–10).
 *
 * The problem this solves is a layout one with a correctness edge. A coordinator types a text *as
 * the family*, and what comes back has to appear **in the thread** — under the bubbles already
 * there, inside the phone frame — because that is where a person looks for "what did we say to
 * them". But the thing that owns the turn is the composer, and the composer sits beside the phone
 * (§6.3: the thread is the family's and the composer is the centre's, and a coordinator must never
 * be in doubt which side they are writing on).
 *
 * Two client components, then, in two places, over one piece of state — which is what a context is
 * for. `LiveTurnProvider` holds the turn and the approval; `useLiveTurn` is how the bubbles inside
 * the frame and the controls beside it read the same answer. Nothing is duplicated, so the thread
 * and the card cannot disagree about what the assistant did.
 *
 * The *provider* is in `LiveTurnProvider.tsx` and this file is only the type, the context and the
 * hook — because this one imports nothing but types from `./actions`, while the provider has to
 * import the actions themselves. A component that only *reads* a turn should not drag a server
 * action's whole import graph (Auth.js, `next/server`) in behind it; the panel and the thread read,
 * so they import this.
 */
import { createContext, useContext } from "react";
import type { ApprovalState, TurnState } from "./actions";

export type LiveTurn = {
  readonly turnState: TurnState;
  readonly submitTurn: (form: FormData) => void;
  readonly turnPending: boolean;
  readonly approval: ApprovalState;
  readonly submitApproval: (form: FormData) => void;
  readonly approvalPending: boolean;
  readonly declined: boolean;
  readonly decline: () => void;
};

/**
 * The context itself, exported so a test can render the thread against a turn it chose.
 *
 * `useActionState` cannot be driven from outside a browser, and what `phone-panel.test.ts` is
 * asking is a placement question — *which element are the bubbles inside* — so it supplies a value
 * directly rather than simulating a submit. The component under test is then the real one.
 */
export const LiveTurnContext = createContext<LiveTurn | null>(null);

/**
 * The turn, for a component inside the provider.
 *
 * Throws rather than handing back a null-ish default: a composer rendered outside the provider
 * would silently never submit anything, which is a bug that looks like a quiet screen. The
 * provider is mounted once, by the panel, so this cannot happen at runtime — and if it ever does,
 * it fails where the mistake is.
 */
export function useLiveTurn(): LiveTurn {
  const value = useContext(LiveTurnContext);
  if (!value) throw new Error("useLiveTurn: no LiveTurnProvider above this component");
  return value;
}
