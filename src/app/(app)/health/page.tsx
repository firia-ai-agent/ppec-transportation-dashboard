import { requirePage } from "@/auth/page-guard";
import { StubPage } from "@/ui/StubPage";

/** The guard reads a session, so this route is never statically rendered. */
export const dynamic = "force-dynamic";

/**
 * SURF-06 Health & SURF-07 ROI (PRD §14). Off the menu as of Firia's 8:36 PM ET ruling
 * (REDESIGN-SPEC §9.2: Health is not a menu item). The four Right now tiles live on Today's
 * Health tab (Firia ruling 2026-10-17). This address stays the stub it was: a typed URL is
 * still answered here, and nothing redirects it, so the access row is unchanged.
 *
 * Its title is the frame's (src/ui/PageHeader.tsx).
 */
export default async function Page() {
  await requirePage("/health");
  return <StubPage />;
}
