"use client";

import { usePathname } from "next/navigation";
import Link from "next/link";
import { nav } from "./copy";
import { icon } from "./tokens";
import { isCurrent, navItems } from "./nav-items";
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
 * Each link carries the page name three ways, so none of them is the only way:
 *  - `aria-label`, the accessible name, read by a screen reader at every width;
 *  - `title`, the pointer tooltip, for a sighted mouse user on the icon rail;
 *  - the visible `<span>`, which is in the DOM at every width and revealed by the expansion.
 * The icon is `aria-hidden`, so the name is never announced twice.
 */
export function NavRail() {
  const pathname = usePathname();
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
                </Link>
              </li>
            );
          })}
        </ul>
      </div>
    </nav>
  );
}
