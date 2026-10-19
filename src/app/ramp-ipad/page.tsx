/**
 * /ramp-ipad — the van arrival (redesign spec §2, demo goal 2; PRD §14 SURF-04).
 *
 * This file is the guard and the day: it checks the role, reads the date, the **leg** and the van
 * out of the address (§9.3's `?date=`, `?leg=` and `?van=`), loads the same board the coordinator
 * plans on for that leg, and hands the van being counted to the screen that draws it.
 *
 * Behind staff sign-in, and open to **all three roles**: SURF-04 is the front desk's own surface
 * (PRD §6.2, ARCHITECTURE §1), and a coordinator or director walking the ramp uses the same one.
 * What a role may *write* still differs, and the endpoint enforces it — the front desk may
 * confirm what arrived and may not plan a van (src/modules/plan/api.ts). Links to screens they
 * cannot open are hidden rather than refused (§9.3), which is what `canOpenPage` answers here.
 *
 * The DEMO banner and the one NFR-09 source chip come from the root layout, on every route — this
 * page must not mount a second pair.
 */
import { canOpenPage } from "@/auth/access";
import { requirePage } from "@/auth/page-guard";
import { loadBoard, planStore } from "@/modules/plan/store";
import { siteOf } from "@/modules/plan/api";
import { LEG_PARAM, resolveDate, resolveLeg, VAN_PARAM } from "@/modules/plan/when";
import { flow, vanArrival } from "@/ui/copy";
import VanArrival from "./arrival/VanArrival";
import { arrivalVans, noPlanView, selectedVan } from "./arrival/view";
import styles from "./arrival/arrival.module.css";

export const metadata = { title: vanArrival.documentTitle };

/** The guard reads a session, so this route is never statically rendered. */
export const dynamic = "force-dynamic";

export default async function RampIpadPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const caller = await requirePage("/ramp-ipad");
  const params = await searchParams;
  const one = (value: string | string[] | undefined): string | undefined =>
    Array.isArray(value) ? value[0] : value;

  const date = resolveDate(one(params.date));
  /*
   * The leg the address names, and Morning when it names none (Firia's ruling of 2026-10-18
   * 1:34 AM ET). It used to be the constant "PM", so the ramp showed the afternoon's riders
   * whatever leg the board's own link had just handed it (#79 lane 6, the DATA item).
   */
  const leg = resolveLeg(one(params[LEG_PARAM]));

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
        <p className={styles.banner}>{flow.error.load}</p>
      </main>
    );
  }

  /*
   * Nothing saved for this leg: one line and one button, and none of the rest of the screen.
   * The ramp does not auto-plan a leg to have something to draw (Firia's S1 ruling).
   */
  if (view.savedAt === null) {
    const empty = noPlanView(date, leg);
    return (
      <main className={styles.page}>
        <p className={styles.empty} data-no-plan="">
          {empty.line}
        </p>
        {canOpenPage(caller, "/plan-routes") ? (
          <a className={styles.emptyAction} href={empty.href} data-plan-routes="">
            {empty.action}
          </a>
        ) : null}
      </main>
    );
  }

  const vans = arrivalVans(view.day, view.plan, view.departs);
  const selected = selectedVan(vans, one(params[VAN_PARAM]));

  if (!selected) {
    return (
      <main className={styles.page}>
        <p className={styles.banner}>{flow.empty.noVans}</p>
      </main>
    );
  }

  return (
    <VanArrival
      vans={vans}
      selected={selected}
      date={date}
      leg={leg}
      canPlan={canOpenPage(caller, "/plan-routes")}
    />
  );
}
