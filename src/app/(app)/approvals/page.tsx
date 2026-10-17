import { requirePage } from "@/auth/page-guard";
import { nav, stub } from "@/ui/copy";
import { StubPage } from "@/ui/StubPage";

/** The guard reads a session, so this route is never statically rendered. */
export const dynamic = "force-dynamic";

/**
 * Approvals — the "For you" half of Family texts (REDESIGN-SPEC §9.2: "Approvals is the For you
 * tab inside Family texts, not a menu item"). Its title and one line, and no data: a queue that
 * showed invented proposals would be asking somebody to approve something that does not exist.
 *
 * Not on the menu, and reachable: the one link to it is on Family texts, inside the frame. It
 * has a row in the access table and a 403 boundary like every other page, so a typed URL is
 * answered the same way every other address is.
 */
export default async function Page() {
  await requirePage("/approvals");
  return <StubPage title={nav.approvals} line={stub.approvals} />;
}
