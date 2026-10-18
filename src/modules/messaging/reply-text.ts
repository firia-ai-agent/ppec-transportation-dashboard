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
 * Why this value may not be sent to a family, or null when it may.
 *
 * Names what is wrong and never echoes the value: the reason a reply is refused is that it may
 * carry something that must not be in a log line.
 */
export function replyTextIssue(value: unknown): string | null {
  if (typeof value !== "string") return "not text";
  const text = value.trim();
  if (text === "") return "empty";
  if (text.length > REPLY_TEXT_MAX) return `longer than ${REPLY_TEXT_MAX} characters`;
  const hit = BANNED.find((b) => b.re.test(text));
  return hit ? `contains a ${hit.what}` : null;
}

/** Whether this value is a sendable model-written reply. The var rule and the schema both use it. */
export function isReplyText(value: unknown): boolean {
  return replyTextIssue(value) === null;
}
