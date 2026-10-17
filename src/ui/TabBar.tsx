"use client";

import { usePathname } from "next/navigation";
import Link from "next/link";
import type { StaffRole } from "@/auth/core";
import { nav } from "./copy";
import { icon } from "./tokens";
import { isCurrent, navItemsFor } from "./nav-items";
import styles from "./TabBar.module.css";

/**
 * THE MENU ON A PHONE — a bottom tab bar, always on screen.
 *
 * Firia's final ruling, 2026-10-17 3:08 PM ET: below 768 px the menu is a bottom tab bar, not a
 * hamburger and not a side panel. Both of those are deleted — a menu you have to find and open
 * is how the founder's walk of production ended up using the browser's Back button, and the
 * answer to "where am I and where else can I go" should not need a tap.
 *
 * What the ruling fixes, and where each part is:
 *  - **every tab ≥44 px, icon over label** (§9 targets) — `.tab` in the stylesheet;
 *  - **the current page is marked**, and by more than colour: `aria-current="page"`, a 3 px
 *    brand bar along the top of the tab and bolder text, so it reads in greyscale;
 *  - **only this role's own items**, from the same data-driven list the desktop rail renders
 *    (`navItemsFor`, src/ui/nav-items.ts) — the front desk gets Live map and Ramp iPad, and
 *    there is no second list of destinations written down for the phone;
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
          return (
            <li key={item.href} className={styles.item}>
              <Link
                href={item.href}
                className={styles.tab}
                aria-current={current ? "page" : undefined}
              >
                <Icon size={icon.nav} aria-hidden="true" />
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
