"use client";

import { useEffect, useId, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import Link from "next/link";
import { Menu, X } from "lucide-react";
import type { ReactNode } from "react";
import type { StaffRole } from "@/auth/core";
import { nav } from "./copy";
import { icon } from "./tokens";
import { isCurrent, navItemsFor } from "./nav-items";
import { NavBadge } from "./NavBadge";
import styles from "./MobileNav.module.css";

/**
 * DESIGN-DIRECTION §2: below 768 px, a hamburger drawer holding the nav, the identity and
 * Sign out. There is still only one identity location per width (§2): the avatar menu is
 * hidden under 768 and this drawer carries it instead.
 *
 * `identity` and `signOut` are rendered on the server and passed through, so the server
 * action for signing out stays out of this client component.
 *
 * The drawer closes on a nav click and on Escape, which returns focus to the hamburger.
 */
export function MobileNav({
  role,
  identity,
  signOut,
  alertCount = 0,
}: {
  role: StaffRole | null;
  identity: ReactNode;
  signOut: ReactNode;
  /** The same count the rail shows, so the drawer is not the one width that hides it. */
  alertCount?: number;
}) {
  const pathname = usePathname();
  // Same list the rail shows, filtered by the same table (src/auth/access.ts).
  const navItems = navItemsFor(role);
  const [open, setOpen] = useState(false);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const drawerId = useId();

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        toggleRef.current?.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open]);

  return (
    <div className={styles.wrap}>
      <button
        ref={toggleRef}
        type="button"
        className={styles.toggle}
        aria-expanded={open}
        aria-controls={drawerId}
        onClick={() => setOpen((v) => !v)}
      >
        {open ? <X size={icon.nav} aria-hidden="true" /> : <Menu size={icon.nav} aria-hidden="true" />}
        <span className="srOnly">{open ? nav.closeMenu : nav.openMenu}</span>
      </button>

      <div id={drawerId} className={styles.drawer} hidden={!open}>
        <nav aria-label={nav.menuLabel}>
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
                    onClick={() => setOpen(false)}
                  >
                    <Icon size={icon.nav} aria-hidden="true" />
                    <span>{item.label}</span>
                    {/* The same count the rail carries: the drawer is a width, not a lesser nav. */}
                    {item.href === "/exceptions" ? <NavBadge count={alertCount} /> : null}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
        <div className={styles.identity}>
          {identity}
          {signOut}
        </div>
      </div>
    </div>
  );
}
