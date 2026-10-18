import { Suspense, type ReactNode } from "react";
import type { StaffRole } from "@/auth/core";
import { app } from "./copy";
import { NavRail, type RailAccount } from "./NavRail";
import { NoticeToast } from "./NoticeToast";
import { PageHeader } from "./PageHeader";
import { TabBar } from "./TabBar";
import styles from "./AppShell.module.css";

/**
 * DESIGN-DIRECTION §2 global shell. The DEMO banner and the one §7.1 Simulated chip are
 * rendered by the root layout, so they also cover /login (§7, §7.1, NFR-09); the header sits
 * directly beneath them.
 *
 * **There is no app header.** Vera's audit of production at ef4bfb3 (§2 items 1, 3 and 5) found
 * a full-width white band with the words "PPEC transportation" in it, above a rail that began
 * with nothing and ended in whitespace, with an outlined "Dana ⌄" pill at the band's far right.
 * The band is deleted at every width. Everything it held has a home that is already on screen:
 *  - the product's name → the brand block at the head of the rail (src/ui/NavRail.tsx);
 *  - the account → the block at the rail's foot, and below 768, where the rail is a tab bar
 *    with no room for words, the 36 px disc at the trailing end of the page header bar
 *    (src/ui/PageHeader.tsx). One identity location per width, never two;
 *  - the screen's title → the 64 px page header bar, in Teal Ink at the 20 px step, which is
 *    what the founder's mockups draw there (png/shell-flow-1440.png, png/shell-flow-390.png).
 * What left earlier and has not come back: the four per-adapter freshness pills and their note
 * (one Simulated chip on a screen, the one in the DEMO bar), the dead "Demo day · Not started"
 * readout and its inert "Start demo day" (the demo's one control is the bar's), global search
 * (it searches the board, so it is on the board), and §2's service date (it belongs to the
 * thing that has a day).
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
  account,
  role,
  title,
  forYouWaiting,
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
   * The title for the page header bar, for the one screen whose path has no row in the access
   * table to read one from: the refusal (src/ui/RefusedPage.tsx). Every other screen's title is
   * its own row's label and nothing passes this.
   */
  title?: string;
  /**
   * How many things are waiting in Family texts · For you, for the menu's one count badge.
   *
   * There is no live count yet, so nothing passes one and the badge does not render (#61 is the
   * read, and until it lands a number here would be a fixture claiming work that does not
   * exist — Firia, on Veri's S2). `null` and `undefined` both draw nothing; a count above zero
   * draws the disc for the roles that can act on it (src/ui/menu-badge.ts).
   */
  forYouWaiting?: number | null;
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
      <Suspense fallback={null}>
        <NoticeToast />
      </Suspense>
      <div className={styles.body}>
        <NavRail role={role} account={account} waiting={forYouWaiting} />
        {/*
          The content column: the page header bar, then the screen. The bar is the frame's — one
          title, one place, every screen — and the screen below it brings its own body and
          nothing above it (audit §2 item 1).
        */}
        <div className={styles.column}>
          <PageHeader account={account} title={title} />
          <Content id="content" className={pageOwnsMain ? styles.contentSlot : styles.main}>
            {children}
          </Content>
        </div>
      </div>
      <TabBar role={role} waiting={forYouWaiting} />
    </div>
  );
}
