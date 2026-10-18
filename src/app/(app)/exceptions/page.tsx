import { permanentRedirect } from "next/navigation";
import { MOVED_PAGES } from "@/auth/access";
import { requirePage } from "@/auth/page-guard";

/** The guard reads a session, so this route is never statically rendered. */
export const dynamic = "force-dynamic";

/**
 * `/exceptions` → `/today`, permanently (308). Firia, 2026-10-17 8:36 PM ET, and Vera's audit
 * §2 item 2, which lists the redirect beside taking the item off the menu: Exceptions &
 * Approvals is not a destination of the day — what needs action belongs on Today as the §9.2
 * "Needs you" card — so the address still answers and lands on the board rather than on a page
 * with a title and an apology.
 *
 * **The guard runs first, and that is the whole design of this file.** A redirect configured in
 * next.config.ts would fire before anything knows who is asking, which leaks the fact that the
 * target exists to a signed-out visitor and bounces a role that may not open it onto a page it
 * then has to refuse. In this order instead:
 *  - signed out → `/login` (307), and they never learn what is at `/today`;
 *  - front desk → their own home, the live map, with the "Not on your menu" toast (§9.3): a
 *    screen they can see, not a 403 and not the board;
 *  - director, coordinator → 308 to `/today`.
 * The row in the access table is untouched (src/auth/access.ts), and the page file stays here
 * because it is what makes that order possible.
 *
 * 308 and not 307: the address has moved for good, so a browser may cache it, and the method is
 * preserved either way (`permanentRedirect`, Next's 308).
 */
export default async function Page() {
  await requirePage("/exceptions");
  // The destination is read from the one table that holds this app's addresses, so a redirect
  // cannot point at a screen the access table does not have (src/auth/access.ts MOVED_PAGES).
  permanentRedirect(MOVED_PAGES["/exceptions"]);
}
