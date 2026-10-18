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

/**
 * THE INITIALS IN A DISC — "DM" for Dana Mercer, "S" for the brand mark.
 *
 * The deleted avatar menu had its own copy of this and the rail's account block would have been
 * a second; the founder's mockups draw the same two letters in both (png/shell-flow-1440.png:
 * `DM` beside "Dana M." at the foot of the rail, png/shell-flow-390.png: `DM` alone at the
 * trailing end of the page header bar). One function, so the two cannot disagree about a person
 * — and `max` is here for the brand mark, which is the same rule over one letter.
 *
 * Built on the name a screen *shows* rather than the row's: "SYN Dana Mercer Director" would
 * otherwise read "SD", which is the marker and the person's family name.
 */
export function initialsOf(displayName: string, max = 2): string {
  return shortName(displayName)
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, max)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

/**
 * THE TWO LINES OF AN ACCOUNT BLOCK — "Dana M." over "Director".
 *
 * Three surfaces print a person and their role: the rail's account block, the phone's avatar,
 * and /whoami ("Dana M. · Director"). The rule they share is the one about *not* printing it
 * twice. A session with no user row behind it has a role for its whole display name — the
 * synthetic browser-test session, whose name is literally "Director" (src/auth/caller.ts) — and
 * a block built naively from it reads "Director" over "Director", which is the one thing on the
 * screen that tells a reader nothing. So the role comes back `null` there and the surfaces print
 * the role alone: the role label, never the role twice, and never a person who does not exist.
 */
export function accountLines(
  displayName: string | undefined,
  roleLabel: string | null,
): { name: string; role: string | null } {
  const name = shortName(displayName ?? "");
  if (!name) return { name: roleLabel ?? "", role: null };
  if (roleLabel && name === roleLabel) return { name, role: null };
  return { name, role: roleLabel };
}
