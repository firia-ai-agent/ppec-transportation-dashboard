import { APPROVAL_ROLES } from "@/auth/access";
import type { StaffRole } from "@/auth/core";

/**
 * THE ONE COUNT ON THE MENU — the Family texts badge (REDESIGN-SPEC §9.2, audit §2 item 2).
 *
 * Both rails ask this and neither one counts anything itself: the 232 px rail draws a 20 px Teal
 * disc at the end of the row, the phone's tab bar draws the same disc over the icon, and the
 * number is the same number because there is one function behind it.
 *
 * **The count has to be real.** It used to be a fixture — `FOR_YOU_WAITING = 2`, in
 * src/fixtures/for-you.ts — so every role with the item on their menu was shown "2 waiting" and
 * "Family texts, 2 waiting", above a screen with nothing waiting on it (Veri's S2 on #74;
 * issue #61 is the read that will make it true). A count with no work behind it is worse than
 * no count: it is the badge a founder clicks, and the one thing it says is wrong. So the fixture
 * is deleted and the number arrives from the caller: `waiting` is a live count, and until #61
 * lands there is none to pass.
 *
 * Who sees it: the roles that can act on what is waiting, which is `APPROVAL_ROLES` — the same
 * constant the `/approvals` row and the "For you" tab read (src/auth/access.ts). The front desk
 * is not one of them and does not have Family texts on their menu at all, so the badge cannot
 * appear for them by either route: the count is withheld *and* the item is absent.
 *
 * Nothing is drawn for zero, and nothing for a count that could not be read: a badge saying
 * nothing is waiting is a badge that means nothing, and "waiting" said of an unknown number is
 * a claim the app cannot make — in words either, which is why this is the one answer both the
 * disc and the accessible name are built from (src/ui/NavRail.tsx, src/ui/TabBar.tsx).
 */
export function menuBadgeFor(
  href: string,
  role: StaffRole | null,
  /** A live count of what is waiting in Family texts · For you. Unknown until #61 lands. */
  waiting?: number | null,
): number | null {
  if (href !== "/family-texts") return null;
  if (!role || !APPROVAL_ROLES.includes(role)) return null;
  if (typeof waiting !== "number" || !Number.isFinite(waiting) || waiting <= 0) return null;
  return waiting;
}
