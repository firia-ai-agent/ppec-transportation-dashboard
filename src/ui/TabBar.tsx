"use client";

import { useEffect, useId, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import Link from "next/link";
import { Ellipsis, X } from "lucide-react";
import type { StaffRole } from "@/auth/core";
import { nav } from "./copy";
import { icon } from "./tokens";
import { isCurrent, navItemsFor, type NavItem } from "./nav-items";
import { NavBadge } from "./NavBadge";
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
 *    brand bar along the top of the tab, the selected tint behind it and bolder text, so it
 *    reads in greyscale;
 *  - **only this role's own items**, from the same data-driven list the desktop rail renders
 *    (`navItemsFor`, src/ui/nav-items.ts) — the front desk gets Live map and Ramp iPad, and
 *    there is no second list of destinations written down for the phone;
 *  - **clear of the iPhone home bar**: the bar pads itself by `env(safe-area-inset-bottom)` and
 *    the shell pads the page by the bar's height plus that same inset, so nothing hides behind
 *    it (src/ui/AppShell.module.css).
 *
 * **Five slots, and a "More" tab when there are more than five destinations.** The menu grew
 * past five with the founder's redesign (REDESIGN-SPEC §0 adds Family texts; nothing on the
 * menu may 404, so Exceptions and Health are on it too), and §9.2 fixes the bar at five equal
 * tabs — seven of them at 390 px is 55 px each, which is under the §9 target and unreadable
 * besides. So: five or fewer, every one is a tab; more than five, the first four are tabs and
 * the fifth slot opens the rest.
 *
 * It is a *tab* that opens a *sheet over the screen*, and that is not the hamburger coming
 * back. The distinction the ruling was about is whether the menu is on screen: four
 * destinations and the way to the rest are visible without a tap, the thing that opens is in
 * the frame and over the page rather than a panel sliding in from the side, and there is
 * nothing to discover. A role with five or fewer destinations — the front desk has two — never
 * sees it at all.
 *
 * The sheet closes the three ways anything that opens must: picking something, Escape, and
 * tapping outside it. Focus moves into it on open and back to the tab that opened it on close,
 * so a keyboard or switch user is never left on an element that is no longer there (§9).
 *
 * A role with no destinations at all (signed in, no membership anywhere) gets no bar rather
 * than an empty strip across the bottom of their screen.
 */
/** §9.2: the bar is five equal tabs. The fifth is "More" when there is more than five of them. */
export const TAB_SLOTS = 5;

/** The tabs, and what goes under "More" — the one rule, so the bar and its tests agree. */
export function splitTabs(items: readonly NavItem[]): {
  tabs: readonly NavItem[];
  overflow: readonly NavItem[];
} {
  if (items.length <= TAB_SLOTS) return { tabs: items, overflow: [] };
  return { tabs: items.slice(0, TAB_SLOTS - 1), overflow: items.slice(TAB_SLOTS - 1) };
}

export function TabBar({
  role,
  alertCount = 0,
}: {
  role: StaffRole | null;
  /**
   * The same count the rail carries (`AppShell`): family texts waiting for a person. A phone is
   * a width, not a lesser menu — if Exceptions & Approvals is under "More" the count rides on
   * the More tab too, so the one thing waiting is never hidden behind a tap.
   */
  alertCount?: number;
}) {
  const pathname = usePathname();
  // The same list, the same filter, the same order as the rail: one menu, two shapes.
  const navItems = navItemsFor(role);
  const { tabs, overflow } = splitTabs(navItems);
  const [openMore, setOpenMore] = useState(false);
  const moreRef = useRef<HTMLButtonElement | null>(null);
  const sheetRef = useRef<HTMLDivElement | null>(null);
  const sheetId = useId();

  /*
   * Escape closes it, wherever the focus is, and the focus goes back to the tab that opened it.
   * On the document rather than on the sheet: a sheet that only answers Escape while something
   * inside it is focused is a sheet a pointer user cannot close with the keyboard.
   */
  useEffect(() => {
    if (!openMore) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpenMore(false);
      moreRef.current?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [openMore]);

  // Focus into the sheet when it opens, so the next Tab is inside it rather than past it (§9).
  useEffect(() => {
    if (openMore) sheetRef.current?.querySelector("a")?.focus();
  }, [openMore]);

  const close = () => setOpenMore(false);

  if (navItems.length === 0) return null;
  return (
    /* `data-tab-bar` is the hook the browser check measures the bar and its clearance by. */
    <nav className={styles.bar} aria-label={nav.menuLabel} data-tab-bar>
      {/*
        The scrim. It closes the sheet on a tap outside it and is the reason the sheet does not
        need to guess where "outside" is. `aria-hidden`, because it is not a control: Escape and
        the sheet's own Close are the ways a keyboard leaves.
      */}
      {openMore ? <div className={styles.scrim} aria-hidden="true" onClick={close} /> : null}
      {openMore ? (
        <div
          className={styles.sheet}
          id={sheetId}
          ref={sheetRef}
          role="group"
          aria-label={nav.moreLabel}
          data-more-sheet
        >
          <ul className={styles.sheetList}>
            {overflow.map((item) => {
              const Icon = item.icon;
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    className={styles.sheetItem}
                    aria-current={isCurrent(pathname, item.href) ? "page" : undefined}
                    onClick={close}
                  >
                    <Icon size={icon.nav} aria-hidden="true" />
                    <span>{item.label}</span>
                    {item.href === "/exceptions" ? <NavBadge count={alertCount} /> : null}
                  </Link>
                </li>
              );
            })}
          </ul>
          <button
            type="button"
            className={styles.sheetClose}
            onClick={() => {
              close();
              moreRef.current?.focus();
            }}
          >
            <X size={icon.inline} aria-hidden="true" />
            {nav.closeMore}
          </button>
        </div>
      ) : null}
      <ul className={styles.list}>
        {tabs.map((item) => {
          const Icon = item.icon;
          const current = isCurrent(pathname, item.href);
          return (
            <li key={item.href} className={styles.item}>
              <Link
                href={item.href}
                className={styles.tab}
                aria-current={current ? "page" : undefined}
                onClick={close}
              >
                <Icon size={icon.nav} aria-hidden="true" />
                {/* The label is visible text, so the tab is named for the eye and the ear both. */}
                <span className={styles.label}>{item.label}</span>
                {item.href === "/exceptions" ? <NavBadge count={alertCount} /> : null}
              </Link>
            </li>
          );
        })}
        {overflow.length > 0 ? (
          <li className={styles.item}>
            <button
              type="button"
              ref={moreRef}
              className={styles.tab}
              aria-expanded={openMore}
              aria-controls={sheetId}
              data-more-tab
              /*
               * Marked when the screen you are on is one of the ones under it, so the bar still
               * answers "where am I" for all of this role's destinations and not only the four
               * with a tab of their own.
               */
              aria-current={
                overflow.some((item) => isCurrent(pathname, item.href)) ? "page" : undefined
              }
              onClick={() => setOpenMore((open) => !open)}
            >
              <Ellipsis size={icon.nav} aria-hidden="true" />
              <span className={styles.label}>{nav.more}</span>
              {overflow.some((item) => item.href === "/exceptions") ? (
                <NavBadge count={alertCount} />
              ) : null}
            </button>
          </li>
        ) : null}
      </ul>
    </nav>
  );
}
