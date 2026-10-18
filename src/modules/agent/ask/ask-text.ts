/**
 * THE WORDS OF AN ASK, AND THE TWO CATEGORIES ITS ROW CAN HAVE — a leaf module, on purpose.
 *
 * All three of these used to live in `staff-ask.ts`, which is the right place for them to be read
 * from and the wrong place for them to be *defined*: `staff-ask.ts` imports the run loop and
 * `run/deps.ts`, `run/deps.ts` builds the context assembler, and the assembler now needs the
 * words of an ask to put them in T1 (`run/staff-ask-context.ts`). That is a cycle, and a cycle
 * through a module that constructs a provider is the kind that bites at import time rather than at
 * type-check time.
 *
 * So the three values with no dependencies of their own sit here, and `staff-ask.ts` re-exports
 * them — every existing caller and every test keeps importing them from where they were.
 */
import { agentAsk } from "@/ui/copy";

/** `ops.task.category` for the ask itself. Free text in the column; no migration. */
export const STAFF_ASK_TASK_CATEGORY = "STAFF_ASK";

/**
 * `ops.task.category` for the staff alert (docs/DATA-MODEL.md: "kind NEEDS_PERSON, reason
 * MODEL_UNAVAILABLE"). Severity RED, state OPEN, no proposal attached — it is read in Family
 * texts → For you by the two roles that may decide, which is the same gate the bubble itself is
 * drawn behind.
 */
export const STAFF_ALERT_TASK_CATEGORY = "NEEDS_PERSON";

/**
 * The words of the ask, back out of the row it was stored in.
 *
 * `raiseTask` has one `summary` column and a board row has to say *what it is*, so an ask is
 * stored as "<what this row is>: <what was asked>". The thread in the bubble wants only the
 * second half — it already knows what the row is, because it is drawing it as a message — so the
 * prefix is taken off here rather than parsed at the far end. One function, both directions, and
 * now also the function the context assembler reads the ask back with.
 */
export function askTextOf(summary: string): string {
  for (const prefix of [agentAsk.asked.summary, agentAsk.unavailable.summary]) {
    if (summary.startsWith(`${prefix}: `)) return summary.slice(prefix.length + 2);
  }
  return summary;
}
