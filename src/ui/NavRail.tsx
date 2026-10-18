"use client";

import { usePathname } from "next/navigation";
import Link from "next/link";
import type { StaffRole } from "@/auth/core";
import { nav } from "./copy";
import { icon } from "./tokens";
import { isCurrent, navItemsFor } from "./nav-items";
import { NavBadge } from "./NavBadge";
import styles from "./NavRail.module.css";

/**
 * DESIGN-DIRECTION §2: ≥1280 a 232 px left rail with labels; 768–1279 an icon rail, 64 px
 * wide, whose labels appear on hover *and* on keyboard focus.
 *
 * Between 768 and 1279 the rail keeps its 64 px footprint in the layout (so the board never
 * reflows) and the panel inside it expands over the content to 232 px on `:hover` or
 * `:focus-within` — focus-within is what makes it keyboard-reachable: tabbing into any link
 * opens the labels for every item, not only the focused one.
 *
 * The rail shows only the destinations this role may open (`navItemsFor`); the server checks
 * every one of them again when it is asked for.
 *
 * Each link carries the page name three ways, so none of them is the only way:
 *  - `aria-label`, the accessible name, read by a screen reader at every width;
 *  - `title`, the pointer tooltip, for a sighted mouse user on the icon rail;
 *  - the visible `<span>`, which is in the DOM at every width and revealed by the expansion.
 * The icon is `aria-hidden`, so the name is never announced twice.
 *
 * One destination also carries a count: Exceptions & Approvals, when family texts are waiting
 * for a person (`agent/staff-alert.ts`, and PRD §14's own "count badge once the live board
 * lands"). The number comes from the server through `AppShell`, already decided for this role —
 * the rail does not read a database and does not hold a second opinion about who may see it.
 */
export function NavRail({ role, alertCount = 0 }: { role: StaffRole | null; alertCount?: number }) {
  const pathname = usePathname();
  // The role is a string, so it crosses the server/client boundary; the icons do not, which is
  // why the list is built here rather than passed in.
  const navItems = navItemsFor(role);
  return (
    <nav className={styles.rail} aria-label={nav.landmarkLabel}>
      <div className={styles.panel}>
        <ul className={styles.list}>
          {navItems.map((item) => {
            const Icon = item.icon;
            const current = isCurrent(pathname, item.href);
            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  className={styles.link}
                  aria-label={item.label}
                  title={item.label}
                  aria-current={current ? "page" : undefined}
                >
                  <Icon size={icon.nav} aria-hidden="true" />
                  <span className={styles.label} aria-hidden="true">
                    {item.label}
                  </span>
                  {/*
                    The count, on the one destination that has one. Not part of `navItems`: the
                    rail's list of destinations is a static table (src/ui/nav-items.ts) and a
                    live number is not a property of a destination, it is a property of today.
                  */}
                  {item.href === "/exceptions" ? <NavBadge count={alertCount} /> : null}
                </Link>
              </li>
            );
          })}
        </ul>
      </div>
    </nav>
  );
}
