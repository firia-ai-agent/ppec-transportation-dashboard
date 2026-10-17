/**
 * /ramp-ipad — the SURF-04 ramp iPad on its own route, so the §4.4 checklist can be walked
 * on a tablet before the real surface exists. The screen itself is RampCheck.tsx; this file is
 * only its guard.
 *
 * Behind staff sign-in, for the same reason /live-map is: a deployed URL is
 * guessable, and this page lists children by first name and last initial, the transport needs
 * derived from their intake, and which seat each of them is in. src/auth/caller.ts answers who
 * is asking and the access table (src/auth/access.ts) decides whether they may look — SURF-04
 * is the front desk's own surface, so every staff role is in and anonymous is not.
 *
 * The DEMO banner and the one NFR-09 source chip come from the root layout, on every route —
 * this page must not mount a second pair.
 */
import { requirePage } from "@/auth/page-guard";
import RampCheck from "./RampCheck";

/** The guard reads a session, so this route is never statically rendered. */
export const dynamic = "force-dynamic";

export default async function RampIpadPage() {
  const caller = await requirePage("/ramp-ipad");
  /*
   * The role the guard just read, handed to the screen the way the console shell is handed one
   * (src/app/(app)/layout.tsx). The screen shows the same check to every staff role; the role
   * decides only which of the re-plan panel's two onward links is offered, because the front
   * desk cannot open Plan routes or the board (./onward.ts).
   */
  return <RampCheck role={caller.kind === "STAFF" ? caller.role : null} />;
}
