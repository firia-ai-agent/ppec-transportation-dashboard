/**
 * THE ONE PLACE A MODEL'S OWN WORDS MAY REACH A FAMILY — and the shape they have to have.
 *
 * Firia, 2026-10-18 11:04 AM ET: the drop-off reply card was a fixed template ("PPEC: Yes —
 * {childName} gets off at {stopLabel} today.") and it did not answer what the parent asked. Dara
 * asked for five o'clock; the card confirmed a place. So the reply is **model-written** now: the
 * model that proposes the change also writes the sentence a coordinator approves.
 *
 * That is a change to one rule and to no other. "No free text to a family" was never a ban on
 * prose, it is §11.2's "free-text to parents **without human approval**" — so prose is allowed on
 * exactly one path, the staff-approval path (`propose_dropoff_change` → `ops.approval_request` →
 * `decideApproval`), and is still banned everywhere else: the GPS late notice, the HELP/STOP
 * answers and every other auto-send stay fixed templates with code-shaped vars.
 *
 * ## What this module is for
 *
 * A bounded, checkable shape for that one prose field, read by the four places that have to agree
 * about it:
 *
 *  - `agent/tools.ts` — the `reply` argument of `propose_dropoff_change`, so a reply that breaks
 *    the shape is refused at the gateway as invalid arguments and never becomes a proposal;
 *  - `agent/run/exec/proposals.ts` — the proposal writer, which stores it as `reply_text`;
 *  - `outbox/outbox.ts` — the `replyText` var rule on the one template that carries it, so the
 *    egress door refuses it at enqueue and blocks it at drain exactly as it does every other var;
 *  - `messaging/templates.ts` — the display rule, so a row written around the door still cannot
 *    render a sentence that breaks the shape.
 *
 * ## What the shape bans, and the one thing it deliberately does not
 *
 * Banned: anything longer than `REPLY_TEXT_MAX`, a line break, a phone number, a street address, a
 * URL or an email, a uuid, an upper-case code or enum (`PARENT_REQUEST`, `OKEE-PARK`,
 * `BOARDED_VERIFIED`), a template placeholder, and the `PPEC:` prefix the fixed templates carry —
 * the prefix is the machine's voice and this sentence is meant to read as a person's.
 *
 * **Not** banned: the parent's and the child's first names. That is the point of the ruling — the
 * reply says "Hi Dara, yes, we'll drop Noah off at 5 today" — and it is why this field is not in
 * `staffTextFields`: `redact()` would replace both names with `[REDACTED:NAME]`, which is right
 * for a note that is kept in a log and wrong for the sentence a family reads. The names are not a
 * leak here: the recipient is the child's own guardian, resolved at send time from the family's
 * file, and a message to a family about their own child is what this system exists to send.
 *
 * No imports, for the same reason `approvals/dropoff-change.ts` has none: a shape check must not
 * drag a database handle, a copy table or the fixture roster behind it.
 */

/** The longest reply a model may write. Two SMS segments' worth, before the send step's footer. */
export const REPLY_TEXT_MAX = 320;

/** The patterns a reply may not contain, each with the name of what it is. Order is not meaningful. */
const BANNED: readonly { readonly what: string; readonly re: RegExp }[] = [
  { what: "line break", re: /[\r\n]/ },
  { what: "template placeholder", re: /[{}]/ },
  { what: "machine prefix", re: /PPEC\s*:/i },
  { what: "url", re: /https?:\/\/|\bwww\.|\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/i },
  { what: "uuid", re: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i },
  /*
   * A phone number in any of the shapes a human writes one. Narrower than `agent/redact.ts`'s set
   * on purpose — this text has already been checked for the long digit runs that module cares
   * about by the time it is stored — but the same fail-closed reading: a digit run that looks like
   * a number is treated as one, and a reply that loses on it is one proposal, not a PHI egress.
   */
  { what: "phone number", re: /\+\d[\d\s().-]{7,}\d|\(\d{3}\)\s*\d{3}[.\-\s]?\d{4}|\b\d{3}[.\-\s]\d{3}[.\-\s]\d{4}\b|\b\d{3}[-.]\d{4}\b/ },
  /*
   * PPE-97: the shapes the line above misses. Seven or more digits run together ("5615550177"),
   * and ten or more digits with a single space, dot or dash between them ("5 6 1 5 5 5 0 1 7 7").
   * Full-width digits ("５６１…") reach these too, because the text is NFKC-normalized first.
   */
  { what: "phone number", re: /\d{7,}|(?:\d[\s.\-]){9,}\d/ },
  /*
   * PPE-97: a web address without a scheme. A bare domain ("tokos.app/pay") and one spelled out
   * to get past a filter ("example dot com", "example (dot) com") are both a link to a family.
   */
  {
    what: "url",
    re: /\b[a-z0-9-]+\s*(?:\.|[([]?\s*dot\s*[)\]]?)\s*(?:com|net|org|app|io|co|us|info|biz|me|ly|link|xyz|gov|edu)\b/i,
  },
  {
    what: "street address",
    re: /\b\d{1,6}\s+(?:[A-Za-z0-9.'-]+\s+){0,3}(?:St|Street|Rd|Road|Ave|Avenue|Blvd|Boulevard|Dr|Drive|Ln|Lane|Ct|Court|Cir|Circle|Way|Pl|Place|Ter|Terrace|Pkwy|Parkway|Hwy|Highway|Trl|Trail)\b\.?|\b[A-Z]{2}\s+\d{5}(?:-\d{4})?\b/,
  },
  /*
   * An internal code or token: two or more upper-case runs joined by `_` or `-`. This is what
   * keeps `rationale_code`'s values, the state machine's names and the centre's own stop tokens
   * ("OKEE-PARK") out of a family's text — COPY-GUIDE §2, held on the model's prose as it is held
   * on every template body (`templates.test.ts`).
   */
  { what: "internal code", re: /\b[A-Z][A-Z0-9]*[_-][A-Z0-9]{2,}\b/ },
];

/**
 * A SPELLED-OUT PHONE NUMBER (PPE-105) — the one shape no regex above can see.
 *
 * Every digit rule in `BANNED` is a rule about *digits*, so "five six one five five five oh one
 * seven seven" walks straight through them and a family gets a number anyway. Writing it out in
 * words is also the obvious next move for anything trying to get one past a filter, and a mixed
 * line ("561 five five five 0177") beats both halves at once.
 *
 * So the digits are counted rather than matched: a run of adjacent **digit tokens** — a
 * spelled-out digit, "oh" for zero, or a short numeral group — is a phone number when it is as
 * long as a local number (`PHONE_DIGITS`, seven). Anything that is not a digit token ends the run,
 * which is what keeps ordinary sentences out of it: "we'll be there at five" is one digit, "five
 * thirty" is one ("thirty" is not a digit), and "Noah is one of six riders" is two runs of one.
 *
 * At least one of the digits has to be a **word**, because a run of numerals alone is already the
 * `\d{7,}` rule's and the spaced-digits rule's above — this is the gap they leave, not a second
 * opinion about them.
 */
const PHONE_DIGITS = 7;

/** The digits as words. "oh" and a lone "o" are how a person reads a zero out loud. */
const DIGIT_WORDS: ReadonlySet<string> = new Set([
  "zero", "oh", "o", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine",
]);

/** How many digits this token is worth, or 0 when it is not one. */
function digitsIn(token: string): number {
  if (DIGIT_WORDS.has(token)) return 1;
  return /^\d+$/.test(token) ? token.length : 0;
}

/** True when some unbroken run of digit tokens is as long as a phone number, words included. */
function spelledOutPhone(text: string): boolean {
  let digits = 0;
  let words = 0;
  for (const token of text.toLowerCase().split(/[^a-z0-9]+/)) {
    const worth = digitsIn(token);
    if (worth === 0) {
      digits = 0;
      words = 0;
      continue;
    }
    digits += worth;
    if (DIGIT_WORDS.has(token)) words += 1;
    if (digits >= PHONE_DIGITS && words > 0) return true;
  }
  return false;
}

/**
 * Why this value may not be sent to a family, or null when it may.
 *
 * Names what is wrong and never echoes the value: the reason a reply is refused is that it may
 * carry something that must not be in a log line.
 */
export function replyTextIssue(value: unknown): string | null {
  if (typeof value !== "string") return "not text";
  // NFKC first, so full-width digits and letters ("５５５", "ｅｘａｍｐｌｅ") meet the same rules.
  const text = value.normalize("NFKC").trim();
  if (text === "") return "empty";
  if (text.length > REPLY_TEXT_MAX) return `longer than ${REPLY_TEXT_MAX} characters`;
  const hit = BANNED.find((b) => b.re.test(text));
  if (hit) return `contains a ${hit.what}`;
  return spelledOutPhone(text) ? "contains a phone number" : null;
}

/** Whether this value is a sendable model-written reply. The var rule and the schema both use it. */
export function isReplyText(value: unknown): boolean {
  return replyTextIssue(value) === null;
}
