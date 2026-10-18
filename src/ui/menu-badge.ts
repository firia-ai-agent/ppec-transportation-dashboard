import { APPROVAL_ROLES } from "@/auth/access";
import type { StaffRole } from "@/auth/core";
import { FOR_YOU_WAITING } from "@/fixtures/for-you";

/**
 * THE ONE COUNT ON THE MENU — the Family texts badge (REDESIGN-SPEC §9.2, audit §2 item 2).
 *
 * Both rails ask this and neither one counts anything itself: the 232 px rail draws a 20 px Teal
 * disc at the end of the row, the phone's tab bar draws the same disc over the icon, and the
 * number is the same number because there is one function behind it.
 *
 * Who sees it: the roles that can act on what is waiting, which is `APPROVAL_ROLES` — the same
 * constant the `/approvals` row and the "For you" tab read (src/auth/access.ts). The front desk
 * is not one of them and does not have Family texts on their menu at all, so the badge cannot
 * appear for them by either route: the count is withheld *and* the item is absent.
 *
 * Zero is `null`, not "0": a badge saying nothing is waiting is a badge that means nothing.
 */
export function menuBadgeFor(href: string, role: StaffRole | null): number | null {
  if (href !== "/family-texts") return null;
  if (!role || !APPROVAL_ROLES.includes(role)) return null;
  return FOR_YOU_WAITING > 0 ? FOR_YOU_WAITING : null;
}
