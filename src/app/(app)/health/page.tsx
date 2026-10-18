import { requirePage } from "@/auth/page-guard";
import { StubPage } from "@/ui/StubPage";

/** The guard reads a session, so this route is never statically rendered. */
export const dynamic = "force-dynamic";

/**
 * SURF-06 Health & SURF-07 ROI (PRD §14). Off the menu as of Firia's 8:36 PM ET ruling
 * (REDESIGN-SPEC §9.2: Health is a tab inside Today once #60 lands, not a menu item) and
 * otherwise **untouched** in this PR, by the same ruling: no redirect to Today, no Health tab on
 * Today, and the row in the access table exactly as it was. A typed URL is answered as before.
 *
 * Its title is the frame's now (src/ui/PageHeader.tsx) and the helper line under it is gone
 * (audit §4 item 9), so what is left is the screen itself — which is the four `Right now` tiles,
 * and they are #60's.
 */
export default async function Page() {
  await requirePage("/health");
  return <StubPage />;
}
