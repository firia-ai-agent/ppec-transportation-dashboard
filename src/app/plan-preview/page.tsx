/**
 * /plan-preview — gone, and still answering.
 *
 * This was Plan routes's address until Vera's review (2026-10-17) took "preview" out of every menu
 * label and address: the word named how finished the build was, in a URL a founder reads out
 * loud. The screen is at `/plan-routes` now, and this page is a permanent redirect (308) to it, so
 * a bookmark, a demo link or a line in an older pull request still lands on the screen instead
 * of the 404.
 *
 * Behind the same door as the destination, and that is the point of doing this in a page rather
 * than in next.config.ts: the guard runs first, from the old address's own row in the one access
 * table (src/auth/access.ts), which carries the same roles the destination's row does. Signed
 * out is a redirect to sign-in; a role the row omits gets the no-access page and a 403
 * (forbidden.tsx beside this file), never a redirect. A redirect is an answer, and an
 * unguarded one would tell a caller who may not open Plan routes that it exists.
 */
import { permanentRedirect } from "next/navigation";
import { MOVED_PAGES } from "@/auth/access";
import { requirePage } from "@/auth/page-guard";

/** The guard reads a session, so this route is never statically rendered. */
export const dynamic = "force-dynamic";

export default async function MovedPage() {
  await requirePage("/plan-preview");
  permanentRedirect(MOVED_PAGES["/plan-preview"]);
}
