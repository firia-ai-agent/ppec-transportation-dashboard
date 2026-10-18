/**
 * /plan-routes — the plan board (redesign spec §1, BUILD-READY; PRD B-09 VEH-01…05, B-13).
 *
 * This file is the guard and the day: it checks the role, reads the date and the leg out of the
 * address (§9.3's `?date=` and `?leg=`, defaulted in centre time), loads the board from the three
 * tables migration 0009 adds, and hands the whole thing to the client component that draws it.
 *
 * Behind staff sign-in and behind the two console roles: PRD §6.2 gives the attendance plan and
 * the legs to coordinators, ARCHITECTURE §1 gives the web console to the coordinator and the
 * director, and the front desk's surface is the ramp iPad, where a van is counted rather than
 * planned. src/auth/caller.ts answers who is asking and the access table (src/auth/access.ts)
 * decides whether they may look; a role the row omits gets the no-access page and a 403
 * (forbidden.tsx beside this file). §1.7 #5's other half is the endpoint, which refuses the same
 * role in the same words.
 *
 * The DEMO banner and the one NFR-09 source chip come from the root layout, on every route — this
 * page must not mount a second pair.
 *
 * Load failure is a state, not a stack trace (§9.3's last rows): the module says "Couldn't load ·
 * Retry" and the shell around it stays, because a screen that cannot read its day must not take
 * the menu down with it.
 */
import { API, apiOutcome } from "@/auth/access";
import { requirePage } from "@/auth/page-guard";
import { loadBoard, planStore } from "@/modules/plan/store";
import { siteOf } from "@/modules/plan/api";
import { resolveDate, resolveLeg, VAN_PARAM } from "@/modules/plan/when";
import { flow, planBoard } from "@/ui/copy";
import PlanBoard from "./board/PlanBoard";
import styles from "./board/board.module.css";

export const metadata = { title: planBoard.documentTitle };

/** The guard reads a session, so this route is never statically rendered. */
export const dynamic = "force-dynamic";

export default async function PlanRoutesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const caller = await requirePage("/plan-routes");
  const params = await searchParams;
  const one = (value: string | string[] | undefined): string | undefined =>
    Array.isArray(value) ? value[0] : value;

  const date = resolveDate(one(params.date));
  const leg = resolveLeg(one(params.leg) ?? one(params.direction));
  // `?van=` is how the ramp iPad hands a leg back ("Re-plan") and how the board's own
  // "Check vans" round trip returns: the van it names is the one the board opens on (§9.3).
  const van = one(params[VAN_PARAM]);

  /*
   * The read is in the try and the rendering is not: a component's own render errors do not reach
   * a `catch` around the JSX that created it (React renders later), so wrapping the element would
   * be a boundary that catches nothing. What this handles is the thing that can actually fail
   * here — reading the day out of the database.
   */
  let view: Awaited<ReturnType<typeof loadBoard>> | null = null;
  try {
    view = await loadBoard(planStore(), siteOf(caller), date, leg);
  } catch {
    view = null;
  }

  if (!view) {
    return (
      <main className={styles.page}>
        {/* The frame draws this screen's one `h1` (src/ui/PageHeader.tsx, #74). */}
        <p className={styles.chip} data-tone="crit">
          {flow.error.load}
        </p>
      </main>
    );
  }

  // Director and coordinator plan; nobody else reaches this page at all (the row above). The
  // same component is read-only on Today for the front desk (src/app/(app)/today/page.tsx).
  /*
   * Who may start the demo day: the one role `POST /api/demo/reset` allows, read from the same
   * access table the endpoint is guarded by rather than from a second list here (Firia's final
   * scope, 2026-10-18 1:50 AM ET). The server checks it again when the button is pressed.
   */
  const canStartDay = apiOutcome(caller, API.demoReset) === "ALLOW";
  return (
    <PlanBoard
      view={view}
      selectedVanId={van ?? null}
      canEdit
      canStartDay={canStartDay}
    />
  );
}
