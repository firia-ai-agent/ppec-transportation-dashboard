/**
 * Who did it, in the words a screen may print.
 *
 * The three tables hold a **user id** in `set_by` and `saved_by`; a board that says "Changed by
 * Dana M. · Reload" needs a name. This is the one translation, and it is built on the frame's
 * own name helper (src/ui/display-name.ts `shortName`) rather than a second rule of its own —
 * "Dana M." is decided in one place for the whole app (Firia's rule 6; the frame owns it since
 * #71).
 *
 * A session with no user behind it — the browser check's synthetic role — writes null and gets
 * null back, and the screen says "Ramp staff" or "Someone else", which is true, rather than
 * inventing a person.
 */
import { DEMO_ACCOUNTS } from "@/auth/demo-accounts";
import { shortName } from "@/ui/display-name";

export function staffLabel(userId: string | null | undefined): string | null {
  if (!userId) return null;
  const account = DEMO_ACCOUNTS.find((candidate) => candidate.id === userId);
  return account ? shortName(account.name) : null;
}
