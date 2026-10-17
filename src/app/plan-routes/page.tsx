/**
 * /plan-routes — Plan routes (PRD B-09 VEH-01…05, B-13) on its own route, so the planning
 * surface can be walked before Setup and Exceptions exist. The screen itself is PlanRoutes.tsx;
 * this file is only its guard.
 *
 * Behind staff sign-in, and behind the two console roles: PRD §6.2 gives the attendance plan and
 * the legs to coordinators, and ARCHITECTURE §1 gives the web console to the coordinator and the
 * director — the front desk's surface is the ramp iPad, where a van is checked rather than
 * planned. src/auth/caller.ts answers who is asking and the access table (src/auth/access.ts)
 * decides whether they may look; a role the row omits gets the no-access page and a 403
 * (forbidden.tsx beside this file).
 *
 * The DEMO banner and the one NFR-09 source chip come from the root layout, on every route —
 * this page must not mount a second pair.
 */
import { requirePage } from "@/auth/page-guard";
import BackToToday from "@/ui/BackToToday";
import { planRoutes } from "@/ui/copy";
import PlanRoutes from "./PlanRoutes";

export const metadata = { title: planRoutes.documentTitle };

/** The guard reads a session, so this route is never statically rendered. */
export const dynamic = "force-dynamic";

export default async function PlanRoutesPage() {
  const caller = await requirePage("/plan-routes");
  return (
    <>
      {/* The one way back to the board, on all three rail-less screens (src/ui/BackToToday.tsx). */}
      <BackToToday caller={caller} />
      <PlanRoutes />
    </>
  );
}
