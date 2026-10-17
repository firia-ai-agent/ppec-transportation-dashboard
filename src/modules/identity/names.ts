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
