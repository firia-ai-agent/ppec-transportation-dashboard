import { Suspense, type ReactNode } from "react";
import type { StaffRole } from "@/auth/core";
import { app } from "./copy";
import { AvatarMenu } from "./AvatarMenu";
import { NavRail } from "./NavRail";
import { NoticeToast } from "./NoticeToast";
import { TabBar } from "./TabBar";
import styles from "./AppShell.module.css";

/**
 * DESIGN-DIRECTION §2 global shell. The DEMO banner and the one §7.1 Simulated chip are
 * rendered by the root layout, so they also cover /login (§7, §7.1, NFR-09); the header sits
 * directly beneath them.
 *
 * **The header is one row** (Vera's review, 2026-10-17 2:44 PM ET): the site name and one
 * identity location at the trailing end. What left it, and why:
 *  - the four per-adapter freshness pills ("SMS · Simulated", "Teams · Simulated", …) and the
 *    "Times are simulated…" line under them — **one** Simulated chip on a screen, the one in
 *    the DEMO bar. Five of them saying it was four too many;
 *  - the scenario clock — a "Demo day · Not started" readout of a state nothing sets, with an
 *    inert "Start demo day" beside it, which could not start anything because the demo-controls
 *    dock was never built. The demo's one control is the DEMO bar's now, and it is the reset
 *    the app already has ("Restart demo day", src/ui/DemoRestart.tsx, REDESIGN-SPEC §0). The
 *    header holds no demo chrome at all: the bar above it is where the demo lives;
 *  - global search, which moved into Today, under the board's own title: it searches the board,
 *    so it belongs to the board (src/app/(app)/today/TodayBoard.tsx).
 * §2's service date is not in here either: it belongs to the board, which is the thing that has
 * a day (docs/ui/B12-SLICE1-DEFERRED.md §5).
 *
 * Nav, and this is Firia's final ruling of 2026-10-17 3:08 PM ET: `NavRail` at 768 and up (232
 * px labelled at ≥1280, a 64 px icon rail below it), and **below 768 a bottom tab bar** that is
 * always on screen — no hamburger, no drawer, nothing to open. Both are given the caller's role
 * and offer only the destinations that role's row in the access table opens, and only those
 * whose screen is built (`navItemsFor`) — a courtesy on top of the per-page server guard, never
 * instead of it.
 *
 * `NoticeToast` says the one line a redirect could not: a typed URL for a page this person's
 * menu does not carry lands on their own home, and the toast there says "Not on your menu"
 * (§9.3, src/auth/page-guard.ts). It reads `?notice=` from the client, so it is wrapped in a
 * Suspense boundary of its own and can never hold up the screen behind it.
 *
 * One shell, every signed-in screen. It used to wrap only the four routes inside src/app/(app),
 * which left Plan routes, the live map and the ramp iPad with no menu at all: the founder's
 * 2026-10-17 walk of production reached each of them and found the browser's Back button was
 * the only way out. Each of those three now has a layout.tsx of its own mounting this shell
 * through ConsoleShell.tsx, so the header, the nav and the identity are the same objects on all
 * of them. (§2 calls the ramp iPad "its own full-screen route"; that line is what the walk
 * disproved.)
 */
export function AppShell({
  displayName,
  role,
  pageOwnsMain = false,
  alertCount = 0,
  children,
}: {
  displayName: string;
  /** The caller's role, so the menu offers only the pages they can open. `null` shows none. */
  role: StaffRole | null;
  /**
   * True for a screen that renders its own `<main>` — the three that were built before this
   * shell reached them. §9 allows one `main` landmark per page, so the shell hands them a plain
   * wrapper that still carries `#content` for the skip link, and keeps its own padding off
   * surfaces that already have their own (the ramp iPad is laid out edge to edge).
   */
  pageOwnsMain?: boolean;
  /**
   * How many family texts are waiting for a person (`agent/staff-alert.ts`). Rendered as a count
   * beside Exceptions & Approvals and nowhere else; 0 renders nothing at all. The server decides
   * it — a role that may not open that page is handed 0 rather than a number it must then hide.
   *
   * Both shapes of the one menu carry it: the rail at ≥768 and the bottom tab bar below it. A
   * count that only one width shows is a count a phone never sees.
   */
  alertCount?: number;
  children: ReactNode;
}) {
  const Content = pageOwnsMain ? "div" : "main";
  return (
    <div className={styles.shell}>
      {/* §9 keyboard-only walk: the rail and header come before the board, so give it a bypass. */}
      <a href="#content" className="skipLink">
        {app.skipToContent}
      </a>
      <header className={styles.header}>
        {/* Below 768 the screen's own <h1> names where you are; the product name yields the row. */}
        <span className={styles.siteName}>{app.siteName}</span>
        <div className={styles.spacer} />
        {/*
          One identity location, at every width now. It used to be hidden below 768 because the
          hamburger drawer carried the name and Sign out; the drawer is gone, so this is where
          they are on a phone too — compact (initials and the first name), with Sign out inside
          it (Firia, 3:08 PM ET: "reachable on phone").
        */}
        <AvatarMenu displayName={displayName} />
      </header>
      <Suspense fallback={null}>
        <NoticeToast />
      </Suspense>
      <div className={styles.body}>
        <NavRail role={role} alertCount={alertCount} />
        <Content id="content" className={pageOwnsMain ? styles.contentSlot : styles.main}>
          {children}
        </Content>
      </div>
      <TabBar role={role} alertCount={alertCount} />
    </div>
  );
}
