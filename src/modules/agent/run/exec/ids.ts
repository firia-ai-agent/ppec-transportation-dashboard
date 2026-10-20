/** Deterministic ids for the rows an effect writes — a leaf, so light modules can name them too. */
import { sha256Hex } from "../../redact";

/**
 * The id of a row this call writes, derived from the call's idempotency key rather than freshly
 * generated, so re-driving an interrupted call computes the *same* id and `ON CONFLICT (id) DO
 * NOTHING` is the no-op the resume contract needs. `suffix` separates two rows written by one call
 * (a change request and the exception that points at it).
 *
 * The value is a syntactically valid UUID (version 8, "custom") because that is what the columns
 * are; it is deliberately *not* a uuidv7, since a time-ordered id could not be recomputed.
 */
export function effectId(idempotencyKey: string, suffix = ""): string {
  const h = sha256Hex(`${idempotencyKey}#${suffix}`);
  const variant = ((parseInt(h.slice(16, 18), 16) & 0x3f) | 0x80).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-8${h.slice(13, 16)}-${variant}${h.slice(18, 20)}-${h.slice(20, 32)}`;
}
