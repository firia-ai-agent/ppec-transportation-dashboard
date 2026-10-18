/**
 * How a person is named on a staff screen — the one place that decides it (PRD §15.2, COPY-GUIDE
 * §1 "name people; do not stand in for a name").
 *
 * Two different columns hold the two kinds of name this app has, and they are not interchangeable:
 *
 *  - `ops.child_profile.display_name` is already "first name plus initial" by schema comment and
 *    by §15.2 — "Noah O." — because a child's surname is stored nowhere in `ops`. So the shortening
 *    a screen needs from it is the *other* direction: the sentence "about Noah's drop-off" wants
 *    the given name alone, and gluing "'s" onto "Noah O." reads as a typo.
 *  - `identity.guardian_contact.legal_name` is a *legal* name in the identity schema, and the
 *    synthetic rows carry the ADR-015 marker with them ("Dara O. (SYN)", `synLegalName`). A staff
 *    screen may not print either the full surname or the marker, so it is cut down to the same
 *    "first name plus initial" shape the rest of the app uses.
 *
 * Neither helper reads a database and neither knows about fixtures: they take the stored string
 * and return the displayable one, so the call site is a projection and the rule has one home.
 * Used by the model-unavailable staff alert (`agent/staff-alert.ts`), whose copy names both
 * people — a coordinator has to know whose text is waiting and which child it is about.
 *
 * Both fail *soft*, returning "" for a name that is missing or unreadable, because the alternative
 * is worse: an alert that throws is an alert nobody sees, and a half-rendered name is still a
 * worse outcome than a card that says it cannot name the person. The caller decides what an empty
 * name means for its own sentence.
 */

/** The ADR-015 marker a synthetic legal name carries (`fixtures/standard.synLegalName`). */
const SYN_SUFFIX = " (SYN)";

/** Collapse whitespace and drop the synthetic marker. The shared first step of both helpers. */
function clean(name: string | null | undefined): string {
  const trimmed = (name ?? "").replace(/\s+/g, " ").trim();
  return trimmed.endsWith(SYN_SUFFIX) ? trimmed.slice(0, -SYN_SUFFIX.length).trim() : trimmed;
}

/**
 * A guardian as a staff screen names them: "Dara O." from "Dara O. (SYN)" or "Dara Okafor".
 *
 * The initial is taken from whatever follows the given name — a surname, an already-shortened
 * initial, or a middle name followed by a surname (the last word wins, because that is the family
 * name). A one-word name has no initial and is returned as it stands: "Dara." would be an initial
 * this row does not have, and inventing one is the kind of quiet fiction §15.2 is about.
 */
export function guardianShortName(legalName: string | null | undefined): string {
  const name = clean(legalName);
  if (name === "") return "";
  const parts = name.split(" ");
  if (parts.length === 1) return parts[0];
  const initial = parts[parts.length - 1].replace(/[^A-Za-z]/g, "").charAt(0).toUpperCase();
  return initial === "" ? parts[0] : `${parts[0]} ${initial}.`;
}

/**
 * A child by their given name alone: "Noah" from "Noah O.".
 *
 * For the possessive in a sentence ("about Noah's drop-off"). The full `display_name` is what a
 * list or a row heading shows; this is for the middle of a sentence, where the initial reads as a
 * stray letter rather than as part of the name.
 */
export function childFirstName(displayName: string | null | undefined): string {
  const name = clean(displayName);
  if (name === "") return "";
  return name.split(" ")[0].replace(/\.$/, "");
}
