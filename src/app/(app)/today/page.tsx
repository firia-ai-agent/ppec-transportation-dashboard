import { requirePage } from "@/auth/page-guard";
import { nav, unbuilt } from "@/ui/copy";
import { Placeholder } from "@/ui/Placeholder";

/** The guard reads a session, so this route is never statically rendered. */
export const dynamic = "force-dynamic";

/**
 * SURF-01 board (§4.1). There is no data layer yet, so this says the board is not built
 * rather than render an empty board, which would read as "no child rides today".
 *
 * Server-side role guard first, before anything is rendered: /today is in the access table
 * (src/auth/access.ts), and a role that is not in its row gets the no-access page and a 403
 * (forbidden.tsx beside this file), never this frame.
 */
export default async function Page() {
  await requirePage("/today");
  return <Placeholder page={nav.today} body={unbuilt.today} />;
}
