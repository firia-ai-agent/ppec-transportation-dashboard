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

/**
 * The synthetic marker off the front of anything a seeded row is named — a person, a provider,
 * a site. ADR-015 puts `SYN` on every row this app writes so a developer reading the database
 * can tell synthetic data from real; a coordinator reading "SYN Palm Lift Transport" on Plan
 * routes is reading a note about the database, in a sentence about who is driving.
 *
 * One function, used by the three things that print a seeded name: the person in the shell
 * (below), the provider behind a van (src/domain/board/scenario.ts), and the account page.
 */
export function withoutSyntheticMarker(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words[0] === SYNTHETIC_PREFIX) words.shift();
  return words.join(" ");
}

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
  const words = withoutSyntheticMarker(displayName).split(/\s+/).filter(Boolean);
  const lastKept = words.reduce(
    (last, word, index) => (roleWords.has(word.toLowerCase()) ? last : index),
    -1,
  );
  // Nothing but role words: that is the whole name, so say it rather than nothing.
  if (lastKept === -1) return words.join(" ") || displayName.trim();
  return words.slice(0, lastKept + 1).join(" ");
}

/**
 * THE NAME THE CONSOLE SHOWS — "Dana M.", and this is the only function that decides it.
 *
 * The founder's mockups write a person as a first name and a family initial (png/shell-flow-*:
 * "Dana M." over "Director" in the rail, "DM" in the phone avatar, "Dana M. · Director" on the
 * account page). Three surfaces print it, so there is one function: the identity menu in the
 * shell, the avatar's initials, and /whoami. A second rule for one of them is how a person ends
 * up with two names in one app.
 *
 * Built on {@link personName}, so the synthetic marker and the trailing role are already gone,
 * and honest about a name it cannot shorten: a stored name with no family name in it (the
 * browser-test session, whose whole name is "Director") comes back as it is rather than as an
 * initial of nothing.
 */
export function shortName(displayName: string): string {
  const words = personName(displayName).split(/\s+/).filter(Boolean);
  if (words.length < 2) return words.join(" ");
  const family = words[words.length - 1];
  // Already an initial ("Dana M."): leave it, rather than making it "Dana M".
  const initial = /^[A-Za-z]\.$/.test(family) ? family : `${family[0].toUpperCase()}.`;
  return `${words[0]} ${initial}`;
}
