/**
 * /live-map — where every van is right now.
 *
 * The founder's screen (mockups/live-map.html; png/live-map.png at 1440, png/live-map-390.png
 * at 390): a list of vans beside the map at 1440 and under it at 390, each with its number, its
 * driver, its next stop, the kids still aboard and **one state chip** — On route, At stop, Late,
 * No GPS. The map draws each van's route, pin and stops in that van's own colour, the basemap's
 * credits collapse behind an (i), and there is no ETA anywhere on it (REDESIGN-SPEC §3, which
 * deletes the 13-field ETA line and the 41-word "Decisions only…" paragraph this page used to
 * open with; Firia's goal-5 brief deletes the rest).
 *
 * What left with them: the per-screen scenario clock and its Pause / ×1 / ×10 / ×60 / Restart
 * (the demo's clock is the DEMO bar's, Firia 8:36 PM ET), the "Open Ramp iPad" and "Open Plan
 * routes" links (both are in the menu on every screen now), the notification-decision log and
 * the injected-fault list. There are **no scenario or demo controls on this screen at all**,
 * which is part of what makes it safe as the front desk's home page.
 *
 * ───────────────────────────────── the hard gate ─────────────────────────────────
 *
 * **It is locked until a plan is saved for this leg** (REDESIGN-SPEC §9.1: "Plan saved → Live
 * map", hard — "No saved plan = no routes"). This page reads `ops.plan_run` / `ops.plan_assignment`
 * for the date and leg in the address, and with nothing saved it draws the centre pin and the
 * "No routes yet" card over the map (§9.5) rather than a fleet nobody committed to. It is a
 * **read**: there is no save path on this screen and nothing here writes a row.
 *
 * Where the positions come from, as always on this screen: the simulated/demo source behind the
 * domain location interface (src/modules/live-map/day.ts). No real provider, no paid service —
 * which is what the one "Simulated" chip in the DEMO bar says here as on every route (§7.1,
 * NFR-09).
 *
 * It is behind staff sign-in, and the access table is the guard (src/auth/access.ts): all three
 * staff roles, because a person at the door needs to see where the vans are, and anybody else —
 * signed out, or signed in with no membership — gets the refusal page and a 403. The role then
 * decides which *data* the viewer gets (src/domain/access/map-view.ts).
 */

import LiveMapScreen from "@/modules/live-map/LiveMapScreen";
import { LockedCard } from "@/modules/live-map/LockedCard";
import { liveMap } from "@/ui/copy";
import { canOpenPage, mapViewerOf } from "@/auth/access";
import { canSeeMapData } from "@/domain/access/map-view";
import { requirePage } from "@/auth/page-guard";
import {
  demoVehicleId,
  isUnlocked,
  kidsPerVan,
  loadSavedPlan,
  siteOf,
} from "@/modules/live-map/plan-read";
import { DATE_PARAM, LEG_PARAM, resolveDate, resolveLeg } from "@/modules/plan/when";
import { dateOverrideAllowed } from "@/domain/board/day";
import { LIVE_FLEET_VEHICLE_IDS } from "@/modules/live-map/fleet";
import styles from "@/modules/live-map/live-map.module.css";

export const metadata = { title: liveMap.documentTitle };

/** The guard reads a session and the plan is a row, so this route is never statically rendered. */
export const dynamic = "force-dynamic";

/** One `?p=` value, which Next hands over as a string or an array of them. */
function one(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * `?at=<scenario second>` — the browser check's clock, and nothing else's.
 *
 * Each of the four chips is a moment of the simulated day, and a browser check that waits for
 * one to come round is a check that fails on a slow machine. So the same test path the board
 * already has for its own clock, read through the *same* gate: `dateOverrideAllowed` wants
 * `APP_DATA_CLASS=SYNTHETIC`, `DEMO_MODE=1` and an explicit `E2E_DATE_OVERRIDE=1`, and refuses
 * outright whenever `VERCEL_ENV` is set — which it is on every deployment. So on anything the
 * platform runs this is a parameter nothing reads, exactly like `?date=` on the board.
 *
 * There is no clock control on this screen either way (the demo's clock is the DEMO bar's).
 */
const AT_PARAM = "at";

function pinnedSecondsFrom(raw: string | undefined): number | undefined {
  if (!dateOverrideAllowed(process.env)) return undefined;
  const seconds = Number(raw);
  return raw !== undefined && Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}

export default async function LiveMapPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // Signed out is a redirect to sign-in; a role the table does not list is a 403 and the
  // no-access page (forbidden.tsx beside this file). Which *data* the role then sees is
  // src/domain/access/map-view.ts.
  const caller = await requirePage("/live-map");
  const viewer = mapViewerOf(caller);

  /*
   * The day and the leg, from the address and defaulted in the CENTRE's time zone — never the
   * server's idea of local time and never the browser's (§9.3, src/modules/plan/when.ts, which
   * is #73's file byte-identical so the board and this screen cannot disagree about "today").
   */
  const params = await searchParams;
  const date = resolveDate(one(params[DATE_PARAM]));
  const leg = resolveLeg(one(params[LEG_PARAM]));

  // The saved plan for that leg: the gate, and the kid counts. Read only.
  const plan = await loadSavedPlan(siteOf(caller as { memberships?: readonly { siteId: string }[] }), date, leg);
  const unlocked = isUnlocked(plan);

  /*
   * The saved plan counts children by `ops.vehicle.id`; the simulated runs are keyed by the
   * fixture's own van key. Joined here, once, so nothing below this line has to know that the
   * two naming systems exist (src/modules/live-map/plan-read.ts `demoVehicleId`).
   */
  const byVehicleId = kidsPerVan(plan);
  const kidsByVan: Record<string, number> = {};
  // The screen's own three vans (Firia: the demo has exactly 3), never the four-run fixture.
  for (const key of LIVE_FLEET_VEHICLE_IDS) {
    const id = demoVehicleId(key);
    if (id && id in byVehicleId) kidsByVan[key] = byVehicleId[id];
  }

  return (
    <main className={styles.main}>
      <LiveMapScreen
        date={date}
        leg={leg}
        familyLabels={canSeeMapData(viewer, "familyLabels")}
        unlocked={unlocked}
        kidsByVan={kidsByVan}
        pinnedSeconds={pinnedSecondsFrom(one(params[AT_PARAM]))}
        locked={
          unlocked ? null : <LockedCard canPlan={canOpenPage(caller, "/plan-routes")} />
        }
      />
    </main>
  );
}
