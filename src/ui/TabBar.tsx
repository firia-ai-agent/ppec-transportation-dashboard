"use client";

import { usePathname } from "next/navigation";
import Link from "next/link";
import type { StaffRole } from "@/auth/core";
import { fill, flow, nav } from "./copy";
import { icon } from "./tokens";
import { isCurrent, navItemsFor } from "./nav-items";
import { menuBadgeFor } from "./menu-badge";
import styles from "./TabBar.module.css";

/**
 * THE MENU ON A PHONE — a bottom tab bar, always on screen, one tab per menu item.
 *
 * Firia's final ruling, 2026-10-17 3:08 PM ET: below 768 px the menu is a bottom tab bar, not a
 * hamburger and not a side panel. Both of those were deleted then. **The "More" tab and its
 * sheet are deleted now** (Firia, 8:36 PM ET), and for the same reason the hamburger was: the
 * menu is five items at every width, so the bar is five tabs and there is nothing left over to
 * put behind a sixth slot. The thing that made an overflow necessary — seven rail items — is
 * what audit §2 item 2 is about, and it is fixed in the list itself (src/ui/nav-items.ts).
 *
 * What the ruling asks for, and where each part is:
 *  - **every tab ≥44 px, icon over label** (§9 targets) — `.tab` in the stylesheet;
 *  - **the current page is marked**, and by more than colour: `aria-current="page"`, a 2 px Teal
 *    bar along the top of the tab and a Teal Ink label — and *no tinted block* behind it, which
 *    audit §2 item 6 calls out on production ("In prod the active tab is filled tint, which is
 *    wrong"). The bar and the weight are the cues, so it still reads in greyscale;
 *  - **only this role's own items**, from the same data-driven list the desktop rail renders
 *    (`navItemsFor`, src/ui/nav-items.ts) — the front desk gets Live map and Ramp iPad, two
 *    tabs, and there is no second list of destinations written down for the phone;
 *  - **the count on Family texts** (REDESIGN-SPEC §9.2, audit §2 item 2): a Teal disc over the
 *    icon, and the tab's accessible name says the number rather than leaving it to the eye —
 *    "Family texts, 2 waiting" (`flow.tabbar`, src/ui/menu-badge.ts for the count);
 *  - **clear of the iPhone home bar**: the bar pads itself by `env(safe-area-inset-bottom)` and
 *    the shell pads the page by the bar's height plus that same inset, so nothing hides behind
 *    it (src/ui/AppShell.module.css).
 *
 * A role with no destinations at all (signed in, no membership anywhere) gets no bar rather
 * than an empty strip across the bottom of their screen.
 */
export function TabBar({ role }: { role: StaffRole | null }) {
  const pathname = usePathname();
  // The same list, the same filter, the same order as the rail: one menu, two shapes.
  const navItems = navItemsFor(role);

  if (navItems.length === 0) return null;
  return (
    /* `data-tab-bar` is the hook the browser check measures the bar and its clearance by. */
    <nav className={styles.bar} aria-label={nav.menuLabel} data-tab-bar>
      <ul className={styles.list}>
        {navItems.map((item) => {
          const Icon = item.icon;
          const current = isCurrent(pathname, item.href);
          const waiting = menuBadgeFor(item.href, role);
          return (
            <li key={item.href} className={styles.item}>
              <Link
                href={item.href}
                className={styles.tab}
                aria-current={current ? "page" : undefined}
                /*
                 * The count is part of the name, not a decoration beside it: a disc with "2" in
                 * it says nothing to a screen reader, and the one thing waiting for a person is
                 * exactly what a tab should be announced with (§9).
                 */
                aria-label={
                  waiting === null
                    ? undefined
                    : fill(flow.tabbar.waiting, { label: item.label, count: waiting })
                }
              >
                <span className={styles.iconWrap}>
                  <Icon size={icon.nav} aria-hidden="true" />
                  {waiting === null ? null : (
                    <span className={styles.badge} aria-hidden="true" data-menu-badge>
                      {waiting}
                    </span>
                  )}
                </span>
                {/* The label is visible text, so the tab is named for the eye and the ear both. */}
                <span className={styles.label}>{item.label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
