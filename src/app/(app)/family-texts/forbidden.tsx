/**
 * The 403 boundary for this page: what a signed-in person sees when the family texts panel is not
 * part of their role. `forbidden()` in src/auth/page-guard.ts throws to here, so the response
 * really is a 403 rather than a 200 with an empty screen.
 *
 * One boundary per page, next to the page, because the card names who the page *is* for and that
 * answer is per page. The path below is this page's key in the access table (src/auth/access.ts),
 * which is where the sentence is generated from.
 */
import { NoAccess } from "@/ui/NoAccess";

export default function Forbidden() {
  return <NoAccess path="/family-texts" />;
}
