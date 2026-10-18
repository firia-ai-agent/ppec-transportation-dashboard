import { requirePage } from "@/auth/page-guard";
import { nav, stub } from "@/ui/copy";
import { StubPage } from "@/ui/StubPage";

/** The guard reads a session, so this route is never statically rendered. */
export const dynamic = "force-dynamic";

/**
 * SURF-05 Exceptions & Approvals (§4.1). Its title and one line about what it will hold, and no
 * data at all: an empty list here would read as "nothing needs action", which is a claim about
 * the day that this page is in no position to make.
 *
 * On the menu since REDESIGN-SPEC §0 ("nothing 404s from the menu"), which is why it is a
 * `StubPage` rather than the "isn't built yet" `Placeholder`: a founder clicking a menu item
 * mid-demo should land on a screen with the page's own name at the top of it.
 *
 * Server-side role guard first, before anything is rendered: /exceptions is in the access table
 * (src/auth/access.ts), and a role that is not in its row gets the no-access page and a 403
 * (forbidden.tsx beside this file), never this frame.
 */
export default async function Page() {
  await requirePage("/exceptions");
  return <StubPage title={nav.exceptions} line={stub.exceptions} />;
}
