import { requirePage } from "@/auth/page-guard";
import { nav, unbuilt } from "@/ui/copy";
import { Placeholder } from "@/ui/Placeholder";

/** The guard reads a session, so this route is never statically rendered. */
export const dynamic = "force-dynamic";

/**
 * SURF-05 Exceptions & Approvals (§4.1). Not built yet, and it says so rather than
 * render an empty list, which would read as "nothing needs action".
 *
 * Server-side role guard first, before anything is rendered: /exceptions is in the access table
 * (src/auth/access.ts), and a role that is not in its row gets the no-access page and a 403
 * (forbidden.tsx beside this file), never this frame.
 */
export default async function Page() {
  await requirePage("/exceptions");
  return <Placeholder page={nav.exceptions} body={unbuilt.exceptions} />;
}
