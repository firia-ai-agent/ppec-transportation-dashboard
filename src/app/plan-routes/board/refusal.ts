import type { RejectReason } from "@/config/equipment";

/**
 * The one refused drop on the board, and which card it belongs to.
 *
 * A type and a lookup, in a file of their own so the two columns and the board agree on it
 * without importing each other (the board renders both columns; neither may import the board).
 *
 * **One at a time**, deliberately: a refusal is the answer to the drop a person just made, and a
 * board carrying three stale coral lines is a board arguing with itself. It is cleared when the
 * next drag starts (Vera's taste spec, 2026-10-18).
 */
export type Refusal = {
  childToken: string;
  reason: RejectReason;
  /** "Van 1 wheelchair full" — built once, by src/app/plan-routes/board/lines.ts. */
  line: string;
};

/** The refusal line for this card, or nothing — which is the usual answer. */
export function refusalLineFor(
  refusal: Refusal | null | undefined,
  childToken: string,
): string | undefined {
  return refusal && refusal.childToken === childToken ? refusal.line : undefined;
}
