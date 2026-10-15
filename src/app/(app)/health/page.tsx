import { requirePage } from "@/auth/page-guard";
import { nav, unbuilt } from "@/ui/copy";
import { Placeholder } from "@/ui/Placeholder";

/** The guard reads a session, so this route is never statically rendered. */
export const dynamic = "force-dynamic";

/**
 * Health & ROI (SURF-06/07). Not built yet, and it says so rather than render an empty
 * panel, which would read as "every adapter is fine".
 *
 * Server-side role guard first, before anything is rendered: /health is in the access table
 * (src/auth/access.ts), and a role that is not in its row gets the no-access page and a 403
 * (forbidden.tsx beside this file), never this frame.
 */
export default async function Page() {
  await requirePage("/health");
  return <Placeholder page={nav.health} body={unbuilt.health} />;
}
