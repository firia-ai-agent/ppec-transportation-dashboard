import { ROLE_LADDER } from "@/auth/access";
import { roleNames } from "./copy";

/**
 * THE NAME ON SCREEN — "Dana", not "SYN Dana Director".
 *
 * The demo accounts are stored with both markers on them (src/auth/demo-accounts.ts): `SYN`,
 * the synthetic-data prefix every seeded row carries (ADR-015, synthetic-seed-data-rules), and
 * the role, so a developer reading `ops.app_user` can tell the three apart. Neither belongs in
 * the header: a founder signed in as the director knows they are the director — the rail they
 * are looking at is that role's rail — and `SYN` is a word about the database.
 *
 * One helper, used by the one place that turns a caller into what the shell renders
 * (src/ui/ConsoleShell.tsx), so the header and the phone's account row cannot disagree about a
 * person's name.
 *
 * The role words are read from the role names the app already has rather than listed again
 * here, so a fourth role is stripped the day it is added.
 */
const SYNTHETIC_PREFIX = "SYN";

const roleWords = new Set(
  ROLE_LADDER.flatMap((role) => [role.replace(/_/g, " "), role.replace(/_/g, ""), roleNames[role].one])
    .flatMap((words) => words.split(/\s+/))
    .map((word) => word.toLowerCase()),
);

/**
 * The person, out of the stored name.
 *
 * Trailing role words come off, and the `SYN` marker with them. What is never dropped is the
 * last thing left: a session that carries only a role as its name — the browser-test session,
 * whose display name *is* "Director" (src/auth/caller.ts) — keeps those words, because the
 * alternative is a header with an empty name in it.
 */
export function personName(displayName: string): string {
  const words = displayName.trim().split(/\s+/).filter(Boolean);
  if (words[0] === SYNTHETIC_PREFIX) words.shift();
  const lastKept = words.reduce(
    (last, word, index) => (roleWords.has(word.toLowerCase()) ? last : index),
    -1,
  );
  // Nothing but role words: that is the whole name, so say it rather than nothing.
  if (lastKept === -1) return words.join(" ") || displayName.trim();
  return words.slice(0, lastKept + 1).join(" ");
}
