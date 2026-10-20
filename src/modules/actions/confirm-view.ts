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
  /** What it does to the day, one line each — a re-plan draft's moves, fit and texts (ledger #76). */
  readonly impact: readonly string[];
};

/** What a confirm press answers with, for the panel (a leaf, so client code can name it). */
export type ConfirmState =
  | { readonly status: "idle" }
  | { readonly status: "done"; readonly decision: "APPROVED" | "DECLINED" }
  | { readonly status: "refused"; readonly message: string; readonly fix?: { readonly label: string; readonly href: string } };

/** The confirm action's shape, named in a leaf for the same reason. */
export type ConfirmAction = (previous: ConfirmState, form: FormData) => Promise<ConfirmState>;

/** `approval_request.proposal.kind` for a change the agent prepared for a person to confirm. */
export const STAFF_ACTION_KIND = "STAFF_ACTION";
