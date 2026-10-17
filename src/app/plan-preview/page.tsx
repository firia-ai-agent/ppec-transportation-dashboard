/**
 * /plan-preview — Plan routes (PRD B-09 VEH-01…05, B-13) on its own route, so the planning
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
 * The one thing a request may carry here is a ramp check (`?arrival=`), which is how the ramp
 * iPad hands this screen a van it has just looked at: the parameter is decoded by the domain
 * module that produced it and answers `null` for anything this day cannot be about — a van on no
 * lane, a configuration that van is not built with, a place it does not have, a child who is not
 * riding it. An unreadable one is a parameter nothing reads, exactly as the board's `?date=` is,
 * so the screen opens on the plan it always opens on.
 *
 * The DEMO banner and the one NFR-09 source chip come from the root layout, on every route —
 * this page must not mount a second pair.
 */
import { requirePage } from "@/auth/page-guard";
import { ARRIVAL_PARAM, decodeFinding } from "@/domain/plan/arrival";
import { planRoutes } from "@/ui/copy";
import PlanRoutes from "./PlanRoutes";

export const metadata = { title: planRoutes.documentTitle };

/** The guard reads a session, so this route is never statically rendered. */
export const dynamic = "force-dynamic";

export default async function PlanPreviewPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requirePage("/plan-preview");

  const params = await searchParams;
  const one = params[ARRIVAL_PARAM];

  return <PlanRoutes arrival={decodeFinding(Array.isArray(one) ? one[0] : one)} />;
}
