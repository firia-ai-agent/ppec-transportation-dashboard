"use client";

import { usePathname } from "next/navigation";
import Link from "next/link";
import { nav } from "./copy";
import { icon } from "./tokens";
import { isCurrent, navItems } from "./nav-items";
import styles from "./NavRail.module.css";

/**
 * DESIGN-DIRECTION §2: ≥1280 a 232 px left rail with labels; 768–1279 an icon rail whose
 * label appears on hover *and* focus. The label is always in the DOM (so it is always the
 * link's accessible name and always reachable by keyboard); between 768 and 1279 it is
 * revealed beside the icon instead of inline. Below 768 the rail is hidden and MobileNav
 * takes over.
 */
export function NavRail() {
  const pathname = usePathname();
  return (
    <nav className={styles.rail} aria-label={nav.landmarkLabel}>
      <ul className={styles.list}>
        {navItems.map((item) => {
          const Icon = item.icon;
          const current = isCurrent(pathname, item.href);
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                className={styles.link}
                aria-current={current ? "page" : undefined}
              >
                <Icon size={icon.nav} aria-hidden="true" />
                <span className={styles.label}>{item.label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
