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
 * No database read on this slice and no writes ever: the positions come from the simulated/demo
 * source behind the domain location interface (src/modules/live-map/day.ts), which is what the
 * one "Simulated" chip in the DEMO bar says on this screen as on every other (§7.1, NFR-09).
 *
 * It is behind staff sign-in. A deployed URL is guessable and this page draws a whole fleet, so
 * the route is guarded exactly as the other protected pages are, by the one access table
 * (src/auth/access.ts); the role then decides which data the viewer actually gets
 * (src/domain/access/map-view.ts holds that matrix).
 */

import LiveMapScreen from "@/modules/live-map/LiveMapScreen";
import { liveMap } from "@/ui/copy";
import { mapViewerOf } from "@/auth/access";
import { canSeeMapData } from "@/domain/access/map-view";
import { requirePage } from "@/auth/page-guard";
import { siteHour } from "@/ui/service-date";
import styles from "@/modules/live-map/live-map.module.css";

export const metadata = { title: liveMap.documentTitle };

/** The guard reads a session, so this route is never statically rendered. */
export const dynamic = "force-dynamic";

/**
 * Which leg the screen opens on, from the site's own clock rather than the browser's: before
 * noon in New York the morning run is the one in progress, after it the afternoon
 * (src/ui/service-date.ts holds the one time zone). A coordinator can switch, and the switch is
 * the segmented control in the header bar.
 */
function legNow(): "AM" | "PM" {
  return siteHour() < 12 ? "AM" : "PM";
}

export default async function LiveMapPage() {
  // Signed out is a redirect to sign-in; a role the table does not list is a 403 and the
  // no-access page (forbidden.tsx beside this file). Which *data* the role then sees is
  // src/domain/access/map-view.ts.
  const caller = await requirePage("/live-map");
  const viewer = mapViewerOf(caller);

  return (
    <main className={styles.main}>
      <LiveMapScreen leg={legNow()} familyLabels={canSeeMapData(viewer, "familyLabels")} />
    </main>
  );
}
