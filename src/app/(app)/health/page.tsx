import { requirePage } from "@/auth/page-guard";
import { nav, stub } from "@/ui/copy";
import { StubPage } from "@/ui/StubPage";

/** The guard reads a session, so this route is never statically rendered. */
export const dynamic = "force-dynamic";

/**
 * Health & ROI (SURF-06/07). Its title and one line about what it will hold, and no data: an
 * empty panel here would read as "every adapter is fine", which is the one thing a health
 * screen must never say without having checked.
 *
 * On the menu since REDESIGN-SPEC §0 ("nothing 404s from the menu"), which is why it is a
 * `StubPage` rather than the "isn't built yet" `Placeholder`.
 *
 * Server-side role guard first, before anything is rendered: /health is in the access table
 * (src/auth/access.ts), and a role that is not in its row gets the no-access page and a 403
 * (forbidden.tsx beside this file), never this frame.
 */
export default async function Page() {
  await requirePage("/health");
  return <StubPage title={nav.health} line={stub.health} />;
}
