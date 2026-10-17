"use client";

/**
 * The turn's state, mounted once above the whole panel (PRD §18.2 steps 9–10).
 *
 * Split from `live-turn.ts` so that reading a turn costs nothing: this file imports the two server
 * actions, and through them Auth.js and `next/server`, which is a graph the thread and its bubbles
 * have no business pulling in. The page mounts this; everything inside reads the context.
 *
 * It wraps **server-rendered children** — the phone frame, its header, the logged bubbles with
 * their §3 delivery chips — and that is deliberate: those bubbles stay on the server, so nothing
 * about the message log (a state descriptor, an icon component, a delivery state) has to cross into
 * the browser as data.
 */
import { useActionState, useState, type ReactNode } from "react";
import { approveAgentProposal, runAgentTurn, type ApprovalState, type TurnState } from "./actions";
import { LiveTurnContext } from "./live-turn";

export function LiveTurnProvider({ children }: { children: ReactNode }) {
  const [turnState, submitTurn, turnPending] = useActionState<TurnState, FormData>(runAgentTurn, {
    status: "idle",
  });
  const [approval, submitApproval, approvalPending] = useActionState<ApprovalState, FormData>(
    approveAgentProposal,
    { status: "idle" },
  );
  const [declined, setDeclined] = useState(false);

  return (
    <LiveTurnContext.Provider
      value={{
        turnState,
        submitTurn,
        turnPending,
        approval,
        submitApproval,
        approvalPending,
        declined,
        decline: () => setDeclined(true),
      }}
    >
      {children}
    </LiveTurnContext.Provider>
  );
}
