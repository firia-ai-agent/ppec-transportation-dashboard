/**
 * A confirm card as the bubble draws it, and the approval kind it is stored under (ledger #74 d).
 * A leaf — no imports — because the client components that draw the card import its type, and a
 * client bundle must not reach the agent's runtime through a type.
 */
export type ConfirmView = { readonly approvalId: string; readonly summary: string };

/** `approval_request.proposal.kind` for a change the agent prepared for a person to confirm. */
export const STAFF_ACTION_KIND = "STAFF_ACTION";
