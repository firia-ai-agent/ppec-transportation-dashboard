/**
 * /ramp-ipad — the van arrival (redesign spec §2, demo goal 2; PRD §14 SURF-04).
 *
 * This file is the guard and the day: it checks the role, reads the date and the van out of the
 * address (§9.3's `?date=` and `?van=`), loads the same board the coordinator plans on, and hands
 * the van being counted to the screen that draws it.
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
import { dayDataSource, loadBoard, planStore } from "@/modules/plan/store";
import { siteOf } from "@/modules/plan/api";
import { resolveDate, VAN_PARAM } from "@/modules/plan/when";
import { flow, vanArrival } from "@/ui/copy";
import VanArrival from "./arrival/VanArrival";
import { arrivalVans, selectedVan } from "./arrival/view";
import { RAMP_DIRECTION } from "./arrival/when";
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

  let view: Awaited<ReturnType<typeof loadBoard>> | null = null;
  try {
    view = await loadBoard(planStore(), siteOf(caller), date, RAMP_DIRECTION);
  } catch {
    view = null;
  }

  const vans = view ? arrivalVans(view.day, view.plan, dayDataSource(), view.savedAt !== null) : [];
  const selected = selectedVan(vans, one(params[VAN_PARAM]));

  if (!view || !selected) {
    return (
      <div className={styles.page}>
        <h1 className={styles.heading}>{vanArrival.heading}</h1>
        <p className={styles.banner}>{view ? flow.empty.noVans : flow.error.load}</p>
      </div>
    );
  }

  return (
    <VanArrival
      vans={vans}
      selected={selected}
      date={date}
      canPlan={canOpenPage(caller, "/plan-routes")}
      planSaved={view.savedAt !== null}
    />
  );
}
