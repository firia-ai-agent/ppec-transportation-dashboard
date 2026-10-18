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
import { firstNameOfToken, namedOrNull } from "@/modules/identity/names";
import { replyTextIssue } from "@/modules/messaging/reply-text";
import { agentBubble, familyTexts, fill } from "@/ui/copy";
import { isAlertText } from "./alert-text";
import { demoTokenForId } from "./run/scope-tokens";

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
  return modelAlertWords(a.alertText) ?? namedLine(a);
}

/**
 * The model's alert line in names, or null. This is what a live proposal stores: the gateway has
 * already refused an `alert_text` this cannot name, so on the agent's own path it is never null and
 * the named fallback below is reached only by the seed fixture, which has no model.
 */
export function modelAlertWords(alertText: unknown): string | null {
  const written = typeof alertText === "string" ? alertText.trim() : "";
  return isAlertText(written) ? namedOrNull(written) : null;
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

/* ───────────────────────────── the reply on the card ───────────────────────────── */

export type DropoffReplyInput = {
  /** `reply` as the call carried it — the model's sentence in the prompt's tokens, or nothing. */
  readonly reply?: unknown;
  readonly childToken: string;
  /** `requested_dropoff_time`, "HH:MM", or null when only the place moves. */
  readonly requestedTime: string | null;
};

export type DropoffReply = {
  /** The words the family would get. **Never empty**, and always sendable. */
  readonly text: string;
  /** True when those words are the model's own. */
  readonly modelWritten: boolean;
  /**
   * Why they are not, as a class — "no reply written", "not in names", or `replyTextIssue`'s own
   * phrase ("contains a phone number"). For the server log; it never carries the value it refused,
   * and there is no screen that shows it. Null when the model wrote them.
   */
  readonly reason: string | null;
};

/**
 * THE WORDS ON THE CARD'S BUBBLE — the model's reply, or the copy line, and never nothing.
 *
 * The writer used to throw the whole proposal away when the model's `reply` could not be named or
 * broke the shape (`NO_REPLY_IN_NAMES`): the run went on to succeed, no approval row was written,
 * no task was raised, and a coordinator was told nothing at all. That is the one outcome worse
 * than a plainer sentence — the family asked for something, a model understood it well enough to
 * propose the change, and the card it should have produced existed nowhere.
 *
 * So a reply that does not pass lands on the copy fallback, exactly as the alert line does
 * (`dropoffAlertWords` above), and the row records which of the two it was. What has NOT changed
 * is the egress rule: both sentences are code-owned or model-written-and-checked, the fallback is
 * held to the same `replyTextIssue` shape as the model's own, and nothing here reads a word of
 * what the family typed.
 */
export function dropoffReplyWords(a: DropoffReplyInput): DropoffReply {
  const named = namedOrNull(a.reply);
  if (named === null) {
    const wrote = typeof a.reply === "string" && a.reply.trim() !== "";
    return fallbackReply(a, wrote ? "not in names" : "no reply written");
  }
  const issue = replyTextIssue(named);
  return issue === null ? { text: named, modelWritten: true, reason: null } : fallbackReply(a, issue);
}

/** The copy line, filled from the row's own fields — and held to the shape the model's is held to. */
function fallbackReply(a: DropoffReplyInput, reason: string): DropoffReply {
  const childKey = demoTokenForId(a.childToken);
  const childName = childKey ? firstNameOfToken(childKey) : null;
  const parentName = childKey ? parentFirstName(childKey) : null;
  const eta = a.requestedTime ? sayClock(a.requestedTime) : null;
  const named =
    childName && parentName && eta
      ? fill(familyTexts.dropoffReplyFallback, { parentName, childName, eta })
      : null;
  // A filled line that cannot be sent is not a line: a roster name with a digit run or a bracket
  // in it would fail the same check the model's sentence fails, and the plain line is the floor.
  const text = named !== null && replyTextIssue(named) === null ? named : familyTexts.dropoffReplyFallbackPlain;
  return { text, modelWritten: false, reason };
}
