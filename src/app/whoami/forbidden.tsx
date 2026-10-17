/**
 * The 403 boundary for this page: what a signed-in person sees when this page is not part of
 * their role. `forbidden()` in src/auth/page-guard.ts throws to here, so the response really is
 * a 403 rather than a 200 with an empty screen.
 *
 * One boundary per page, next to the page, because the card names who the page *is* for and
 * that answer is per page. The path below is this page's key in the access table
 * (src/auth/access.ts), which is where the sentence is generated from; access.test.ts fails if
 * a guarded page has no boundary, or if a boundary names a path the table does not hold.
 *
 * The frame around the card — the header, the account menu with Sign out in it, and this role's
 * own menu — comes from the one shared component every boundary in this app renders
 * (src/ui/RefusedPage.tsx), so a refusal is not the dead end the founder's walk of production
 * found (Vera's review, 2026-10-17 4:19 PM ET).
 *
 * This folder holds no layout of its own, so the frame can only come from the boundary. Until
 * 2026-10-17 it did not: measured on a production build, the card here came back with no
 * header, no menu and one link off it.
 */
import { RefusedPage } from "@/ui/RefusedPage";

export default function Forbidden() {
  return <RefusedPage path="/whoami" />;
}
