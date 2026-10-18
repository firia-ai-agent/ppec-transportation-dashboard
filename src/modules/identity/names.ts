/**
 * Name tokenization for a prompt (PRD §11.1 "tiers … tokenized through the identity vault",
 * TEST-SEC-01 "token-only prompts").
 *
 * `identity/phone.tokenizeBody` already replaces the contact details a family types — a number, an
 * email — and that is what `ops.message.body_tokenized` holds, because a coordinator reading a
 * thread has to read the family's own words. A **prompt** is the other direction: the gateway
 * refuses any prompt carrying a name on the fixture roster (`redact.validatePromptTokensOnly`,
 * which fails closed), and it is right to — so the text has to arrive there with the people in it
 * replaced by the tokens the operational tables use.
 *
 * That replacement is this module, and it is deliberately **not** `redact()`: redaction destroys
 * ("[name]"), tokenization substitutes the identifier the rest of the system already uses, so a
 * model reading "can C2 be dropped at grandma's at 5" can answer about C2 — the same token the
 * tool schemas take, the same one the policy engine scope-checks. A redacted message would leave
 * the model unable to say which child it is about, which is the one thing it must be able to say.
 *
 * P1's roster is the synthetic fixture set, exactly as `redact.ts` uses it and for the same
 * reason: in P1 every person is a fixture, so a name in a message is a fixture's name. When real
 * data arrives the roster is swapped for the vault's name index behind this same function; no
 * caller changes.
 */
import { CHILDREN, EXTERNAL_PEOPLE, FAMILIES } from "@/modules/demo/fixtures/standard";

/** One name a message might carry, and the token the operational tables know that person by. */
export type RosterEntry = { readonly name: string; readonly token: string };

/**
 * The shortest name worth substituting. Two letters is not a name you can safely replace — "Ed"
 * appears inside no word thanks to the boundary check, but "Al", "Jo" and "Bo" are also ordinary
 * words in a family's text, and mangling a message is its own kind of dishonesty. A display name
 * this short falls back to the roster, and the gateway's own guard still stands behind it.
 */
const SHORTEST_NAME = 3;

/**
 * The entries one operational display name contributes: the label as stored ("Noah O."), the same
 * without its trailing dot, and the given name on its own — the three shapes a family writes,
 * mirroring what `roster()` builds for a fixture child.
 *
 * This is the **minimum token mapping** B-08 needs while the identity vault (B-07) is not wired:
 * the name a demo deployment actually holds for a child lives in `ops.child_profile.display_name`,
 * not in the fixture file, so a thread that names that child has to be tokenized from the row. The
 * caller supplies the rows (see `agent/run/assembler.ts`), because this module reads no database.
 */
export function rosterFromDisplayName(displayName: string, token: string): RosterEntry[] {
  const label = displayName.trim();
  const given = label.split(/\s+/)[0]?.replace(/\.$/, "") ?? "";
  if (given.length < SHORTEST_NAME) return [];
  return Array.from(new Set([label, label.replace(/\.$/, ""), given]))
    .filter((name) => name.length > 0)
    .map((name) => ({ name, token }));
}

/**
 * Every name the roster holds, longest first.
 *
 * Longest first matters: "Noah O." has to be replaced before "Noah", or the label is left as
 * "C2 O." — a token with a stray initial after it, which is neither a token nor a name. Children
 * carry their own key, a guardian carries their family's, and an external person carries theirs;
 * what each token *means* is the fixture key the operational rows are seeded from
 * (`demoChildToken`), so a token in a prompt is a thing the tool catalog can take.
 */
function roster(): readonly RosterEntry[] {
  const entries: RosterEntry[] = [];
  for (const child of CHILDREN) {
    entries.push({ name: child.label, token: child.key });
    entries.push({ name: `${child.firstName} ${child.lastInitial}`, token: child.key });
    entries.push({ name: child.firstName, token: child.key });
  }
  for (const family of FAMILIES) {
    const { firstName, lastInitial } = family.guardian;
    entries.push({ name: `${firstName} ${lastInitial}.`, token: family.key });
    entries.push({ name: `${firstName} ${lastInitial}`, token: family.key });
    entries.push({ name: firstName, token: family.key });
  }
  for (const person of EXTERNAL_PEOPLE) {
    entries.push({ name: `${person.firstName} ${person.lastInitial}.`, token: person.key });
    entries.push({ name: `${person.firstName} ${person.lastInitial}`, token: person.key });
    entries.push({ name: person.firstName, token: person.key });
  }
  return entries.sort((a, b) => b.name.length - a.name.length);
}

const ROSTER = roster();

/** Regex-escape a roster name; `Mia R.` carries a dot that must match a dot. */
function escape(name: string): string {
  return name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The text with every roster name replaced by that person's token.
 *
 * Word-bounded and case-insensitive: a family types "noah" as often as "Noah", and a name inside
 * another word ("Noahs" is a name, "Lenawee" is a place) must not be split. The boundary is
 * checked on the left and on the right, so "Ava" does not match inside "Available".
 *
 * `extra` is the caller's own mapping, applied together with the roster and longest-first with it:
 * the operational display names of the people this particular message could be about
 * (`rosterFromDisplayName`). It comes *first* on ties so a deployment's own row wins over a
 * fixture of the same name.
 */
export function tokenizeNames(text: string, extra: readonly RosterEntry[] = []): string {
  let out = text;
  const entries = extra.length === 0 ? ROSTER : [...extra, ...ROSTER].sort((a, b) => b.name.length - a.name.length);
  for (const entry of entries) {
    out = out.replace(new RegExp(`(?<![A-Za-z])${escape(entry.name)}(?![A-Za-z])`, "gi"), entry.token);
  }
  return out;
}

/** The tokens this text names, in roster order. What the message is *about*, for a scope check. */
export function namedTokens(text: string): string[] {
  const seen = new Set<string>();
  for (const entry of ROSTER) {
    if (new RegExp(`(?<![A-Za-z])${escape(entry.name)}(?![A-Za-z])`, "i").test(text)) seen.add(entry.token);
  }
  return [...seen];
}

/* ───────────────────────── the way back: a token as a name ───────────────────────── */

/**
 * THE ONE NAME HELPER FOR THIS DIRECTION — a token as the first name a person reads.
 *
 * `tokenizeNames` is how a name gets *into* a prompt safely; this is the only way one comes back
 * out. It exists because of the shape of the whole path and not as a convenience:
 *
 *  - every prompt this app sends is token-only, and `redact.validatePromptTokensOnly` fails closed
 *    on a roster name, so the model is given "F2 asked whether C2 can be dropped at 17:00";
 *  - what a coordinator must read is "Dara asked if Noah can be dropped at 5" (Firia, 2026-10-18
 *    11:13 AM ET) — **real first names, never a code**, which is also the §9 no-codes rule;
 *  - so the tokens in the model's own sentence are turned back into names here, by the same
 *    roster that replaced them, rather than by a screen holding its own idea of who C2 is.
 *
 * A **first** name, because that is what the founder's sentence is: a staff screen may name a
 * child in full ("Noah O."), but a reply read aloud beside an alert is one name per person. The
 * mapping is the fixture roster's own `firstName`, so the two directions cannot disagree about
 * who a token is.
 *
 * Unknown tokens come back null rather than as themselves: a caller that cannot name somebody has
 * to decide what to say instead, and silently printing "C2" on a screen is the one outcome the
 * no-codes rule forbids.
 */
export function firstNameOfToken(token: string): string | null {
  const child = CHILDREN.find((c) => c.key === token);
  if (child) return child.firstName;
  const family = FAMILIES.find((f) => f.key === token);
  if (family) return family.guardian.firstName;
  const person = EXTERNAL_PEOPLE.find((p) => p.key === token);
  return person ? person.firstName : null;
}

/** Every token this roster knows, longest first — so "C10" is replaced before "C1". */
const TOKENS: readonly string[] = [
  ...CHILDREN.map((c) => c.key),
  ...FAMILIES.map((f) => f.key),
  ...EXTERNAL_PEOPLE.map((p) => p.key),
].sort((a, b) => b.length - a.length);

/**
 * A sentence the model wrote in tokens, as a sentence a coordinator reads in names.
 *
 * Word-bounded on both sides and **case-sensitive**, which is the opposite of `tokenizeNames` and
 * is deliberate: a fixture token is upper-case by construction (`C2`, `F2`, `T1`), and a
 * case-insensitive pass would rewrite the ordinary English word "c2"… it would not, but it *would*
 * rewrite "D1" inside a layout code and "T1" inside the tier labels, which are the two codes this
 * system writes in prose. Matching the token exactly as the prompt spelled it is the narrow rule.
 *
 * Longest first for the reason `roster()` sorts longest first: "C10" replaced after "C1" leaves
 * "Mia0", which is a name this app just invented.
 */
export function detokenizeNames(text: string): string {
  let out = text;
  for (const token of TOKENS) {
    const name = firstNameOfToken(token);
    if (!name) continue;
    out = out.replace(new RegExp(`(?<![A-Za-z0-9])${token}(?![A-Za-z0-9])`, "g"), name);
  }
  return out;
}

/**
 * A token this roster could not name, still sitting in a sentence: "C7", "F12", "T1". Shaped rather
 * than listed, so a token nobody has heard of is caught too.
 */
const LEFTOVER_TOKEN = /(?<![A-Za-z0-9])[A-Z]\d{1,3}(?![A-Za-z0-9])/;

/**
 * The model's sentence with every token turned back into a first name — or null when that cannot
 * be done completely.
 *
 * Null rather than a repaired sentence: a token left over means the model is talking about somebody
 * this roster cannot name, and a screen or a family reading "C7" is the one outcome the no-codes
 * rule forbids. The gateway refuses such a call outright (`agent/tools.ts`), so a proposal carries
 * the model's own words in names or it is not a proposal at all — never a template in their place.
 */
export function namedOrNull(text: unknown): string | null {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  if (trimmed === "") return null;
  const named = detokenizeNames(trimmed);
  return LEFTOVER_TOKEN.test(named) ? null : named;
}
