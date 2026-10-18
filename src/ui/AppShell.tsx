import { Suspense, type ReactNode } from "react";
import type { StaffRole } from "@/auth/core";
import { app } from "./copy";
import { AvatarMenu } from "./AvatarMenu";
import { NavRail, type RailAccount } from "./NavRail";
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
 * **The header is gone above 1280** (Firia's final call, 2026-10-17 7:55 PM ET). It held two
 * things and the labelled rail now holds both: the product's name, which the rail's brand block
 * says under a mark, and the account pill, which is the block at the rail's foot. What was left
 * was an empty white band over a rail that the founder's mockup draws running full height from
 * under the DEMO bar (png/shell-flow-1440.png), so the band goes rather than stays empty, and
 * each screen's own `h1` row is the top of the page — which is what the mockup draws there.
 * Below 1280 the rail has no room for words, so the header comes back with the name at one end
 * and the account menu at the other, and Sign out stays one tap away on a phone.
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
  account,
  role,
  pageOwnsMain = false,
  children,
}: {
  /**
   * Who is signed in, already turned into the words a screen shows (src/ui/ConsoleShell.tsx).
   * `null` for a caller with no name at all, which draws no identity block anywhere.
   */
  account: RailAccount | null;
  /** The caller's role, so the menu offers only the pages they can open. `null` shows none. */
  role: StaffRole | null;
  /**
   * True for a screen that renders its own `<main>` — the three that were built before this
   * shell reached them. §9 allows one `main` landmark per page, so the shell hands them a plain
   * wrapper that still carries `#content` for the skip link, and keeps its own padding off
   * surfaces that already have their own (the ramp iPad is laid out edge to edge).
   */
  pageOwnsMain?: boolean;
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
          The identity location below 1280, where the rail is an icon strip or a tab bar and has
          nowhere to put a name. Compact on a phone (initials only), with Sign out inside it, so
          the way to stop being signed in is one tap away at every width (Firia, 3:08 PM ET:
          "reachable on phone"). Above 1280 the rail's own account block is this instead, and
          the stylesheet hides this one: one identity entry point per width, never two.
        */}
        {account ? <AvatarMenu account={account} /> : null}
      </header>
      <Suspense fallback={null}>
        <NoticeToast />
      </Suspense>
      <div className={styles.body}>
        <NavRail role={role} account={account} />
        <Content id="content" className={pageOwnsMain ? styles.contentSlot : styles.main}>
          {children}
        </Content>
      </div>
      <TabBar role={role} />
    </div>
  );
}
