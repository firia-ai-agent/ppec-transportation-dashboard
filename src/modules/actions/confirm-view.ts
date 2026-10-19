/**
 * A confirm card as the bubble draws it, and the approval kind it is stored under (ledger #74 d).
 * A leaf — no imports — because the client components that draw the card import its type, and a
 * client bundle must not reach the agent's runtime through a type.
 */
export type ConfirmView = {
  readonly approvalId: string;
  /** What Confirm would do, from the tool and its arguments (summary.ts). */
  readonly summary: string;
  /** The model's own sentence for the card, in names (ledger #75 c). Null when it wrote none. */
  readonly note: string | null;
};

/** `approval_request.proposal.kind` for a change the agent prepared for a person to confirm. */
export const STAFF_ACTION_KIND = "STAFF_ACTION";
