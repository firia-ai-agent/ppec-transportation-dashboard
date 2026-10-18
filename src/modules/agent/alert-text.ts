/**
 * `alert_text` — THE ONE LINE THE MODEL WRITES FOR A COORDINATOR, and what it is allowed to be.
 *
 * Firia, 2026-10-18 11:15 AM ET: the words on a waiting drop-off proposal must be **the model's
 * own**, not a sentence this app assembled about it. A coordinator reading the alert beside the
 * thread is reading what the thing that read the family's text has to say about it; the named
 * copy line (`ui/copy.agentBubble.dropoffWaiting`) is what they read when no model answered, and
 * nothing reads the old general "A family asked for a different drop-off" row any more.
 *
 * Which makes this validator the whole of the safety story, because the one field in the catalog
 * that carries the model's own prose to a screen is the one field a hijacked model would put
 * something else in. Four rules, all of them checkable without a database:
 *
 *  1. **Bounded.** One sentence for a card, not a paragraph: {@link ALERT_TEXT_MIN} to
 *     {@link ALERT_TEXT_MAX} characters, on one line.
 *  2. **A sentence.** It has a space and it ends the way a sentence ends. A fragment, a label or
 *     a bare code cannot pass as the line a person reads.
 *  3. **No codes, no machinery** (COPY-GUIDE §2, `ui/no-codes.test.ts`). No SNAKE_CASE constant,
 *     no uuid, no template id, no URL, no `{placeholder}` and no markup. Those are the shapes a
 *     code reaches a screen in, and a screen in this app never shows one.
 *  4. **Names only, and not even those yet.** Every prompt this app sends is token-only
 *     (`redact.validatePromptTokensOnly` fails closed), so the model writes "F2 asked…" and the
 *     writer turns the tokens back into first names (`identity/names.detokenizeNames`) before the
 *     row is written. A `[name]`-shaped placeholder from `redact()` is rejected by rule 3's
 *     bracket check, which is how a *leaked* real name — redacted by the policy engine on the way
 *     in — lands on the fallback line rather than on a card as "[name] asked…".
 *
 * No imports, on purpose: `tools.ts` is on the gateway's graph and three regexes should not drag
 * the copy table, the fixtures or a database handle behind them.
 */

/** Shorter than this is a label, not the line a person reads. */
export const ALERT_TEXT_MIN = 12;

/**
 * Longer than this is not a line. Vera's card gives the alert two lines at 400 px, and a sentence
 * that overruns them is a sentence a coordinator skims instead of reading.
 */
export const ALERT_TEXT_MAX = 160;

/**
 * The shapes a code, an id or a piece of machinery arrives in. Each one is a thing that must never
 * be on a screen in this app, and each one is also a thing a model asked for prose will emit if
 * it is allowed to.
 */
const NOT_FOR_A_SCREEN: readonly RegExp[] = [
  /** `DROPOFF_CHANGE`, `NO_SUCH_LEG`, `PARENT_REQUEST` — every rationale and refusal code. */
  /[A-Z][A-Z0-9]*_[A-Z0-9_]+/,
  /** A uuid, or enough of one to be one. */
  /[0-9a-f]{8}-[0-9a-f]{4}/i,
  /** A template id or a module path: `dropoff.changed`. Two real words, so "p.m." is a sentence. */
  /\b[a-z]{3,}\.[a-z]{3,}\b/i,
  /** A link. */
  /\bhttps?:\/\//i,
  /** `{parent}`, `<b>`, `$1`, a pipe table, a backtick — placeholders, markup, prompt furniture. */
  /[{}<>[\]|\\$`]/,
];

/**
 * Is this the model's own line, fit to put on a card? `false` sends the caller to the named copy
 * line, which is the fallback and is never a reason to drop the proposal.
 *
 * Takes the text as the row would store it. It does **not** trim, lower-case or repair anything:
 * a validator that fixes its input is a validator nobody can reason about, and the caller has one
 * `trim()` of its own before it asks.
 */
export function isAlertText(text: string): boolean {
  if (text.length < ALERT_TEXT_MIN || text.length > ALERT_TEXT_MAX) return false;
  // One line. A card is one line; a newline here is somebody formatting a document into it.
  if (/[\r\n\t]/.test(text)) return false;
  // A sentence: more than one word, and finished.
  if (!/\s/.test(text) || !/[.?!]$/.test(text)) return false;
  return !NOT_FOR_A_SCREEN.some((re) => re.test(text));
}
