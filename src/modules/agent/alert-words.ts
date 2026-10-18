/**
 * WHAT A WAITING DROP-OFF PROPOSAL SAYS, in one place.
 *
 * Firia, 2026-10-18 11:15 AM ET: the alert on a drop-off proposal is **the model's own sentence**
 * when a model wrote one, and the named copy line only when none did. This is that choice, as one
 * function, because two callers make it — the agent's own writer (`run/exec/proposals.ts`) and the
 * demo seed (`demo/approval-seed.ts`, which has no model and therefore always lands on the
 * fallback) — and a second copy of it is how a seeded card and a live one end up worded
 * differently for no reason a coordinator could explain.
 *
 * THE ORDER, and every step of it is a refusal rather than a repair:
 *
 *  1. **The model's words**, if the call carried words fit for a screen: `alert_text`, bounded and
 *     code-free (`alert-text.ts`), already redacted by the policy engine on the way in.
 *  2. **Detokenized**, because every prompt this app sends is token-only, so the model wrote "F2
 *     asked to move C2's drop-off" and a coordinator must read "Dara asked to move Noah's". The
 *     roster that replaced the names is the one that puts them back
 *     (`identity/names.detokenizeNames`), so the two directions cannot disagree about who C2 is.
 *  3. **A token left over is the whole sentence thrown away.** Not patched, not stripped: a token
 *     this roster cannot name means the model is talking about somebody the screen cannot name,
 *     and a card reading "C7 asked…" is the one thing §9's no-codes rule forbids outright. The
 *     named line is used instead, which says less and nothing false.
 *  4. **The named line** (`ui/copy.agentBubble.dropoffWaiting`), filled from *structured fields of
 *     the row* — the child, the family behind the child, and `requested_dropoff_time` through
 *     `sayClock`. Nothing in it is read out of anybody's words: there is no keyword fallback in
 *     this app (`agent/no-keyword-fallback.test.ts`) and this is not one.
 *
 * What is NOT here, at any step, is the old general "A family asked for a different drop-off"
 * (`agentTasks.proposedDropoffChange`). It words no drop-off proposal anywhere any more.
 */
import { sayClock } from "@/domain/eta/eta";
import { childByKey } from "@/modules/demo/fixtures/standard";
import { detokenizeNames, firstNameOfToken } from "@/modules/identity/names";
import { agentBubble, fill } from "@/ui/copy";
import { isAlertText } from "./alert-text";
import { demoTokenForId } from "./run/scope-tokens";

/**
 * A token the roster could not name, still sitting in a sentence: "C7", "F12", "T1". Any one of
 * them sends the whole line to the fallback (step 3 above).
 *
 * Shaped rather than listed, so a token this file has never heard of is caught too — the point is
 * that nothing code-shaped reaches a screen, not that these particular prefixes do not.
 */
const LEFTOVER_TOKEN = /(?<![A-Za-z0-9])[A-Z]\d{1,3}(?![A-Za-z0-9])/;

export type DropoffAlertInput = {
  /** `alert_text` as the call row stored it — the model's words, or nothing at all. */
  readonly alertText?: unknown;
  /** `ops.trip_leg.child_token`: whose ride this is, as the operational tables name them. */
  readonly childToken: string;
  /** `requested_dropoff_time`, "HH:MM", or null when only the place moves. */
  readonly requestedTime: string | null;
};

/** The one line the task row and the card carry. Never empty. */
export function dropoffAlertWords(a: DropoffAlertInput): string {
  const written = typeof a.alertText === "string" ? a.alertText.trim() : "";
  if (isAlertText(written)) {
    const named = detokenizeNames(written);
    if (!LEFTOVER_TOKEN.test(named)) return named;
  }
  return namedLine(a);
}

/** The fallback, from the row's own fields. */
function namedLine(a: DropoffAlertInput): string {
  const childKey = demoTokenForId(a.childToken);
  const child = childKey ? firstNameOfToken(childKey) : null;
  const parent = childKey ? parentFirstName(childKey) : null;
  if (!child || !parent) return agentBubble.dropoffWaitingUnnamed;
  const time = a.requestedTime ? sayClock(a.requestedTime) : null;
  return time === null
    ? fill(agentBubble.dropoffWaitingNoTime, { parent, child })
    : fill(agentBubble.dropoffWaiting, { parent, child, time });
}

/** The guardian who asked, through the child's own family — never read off a message. */
function parentFirstName(childKey: string): string | null {
  try {
    return firstNameOfToken(childByKey(childKey).familyKey);
  } catch {
    // A fixture key this roster no longer holds. Say less rather than guess at a name.
    return null;
  }
}
