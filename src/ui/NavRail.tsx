"use client";

import { usePathname } from "next/navigation";
import Link from "next/link";
import type { StaffRole } from "@/auth/core";
import { app, fill, flow, nav } from "./copy";
import { icon } from "./tokens";
import { isCurrent, navItemsFor } from "./nav-items";
import { menuBadgeFor } from "./menu-badge";
import styles from "./NavRail.module.css";

/**
 * Who is signed in, as the rail's account block prints them: a person, their role, and the two
 * letters in the disc. Strings only — the rail is a client component, so what crosses the
 * boundary is words (src/ui/AppShell.tsx builds this from the caller, once).
 */
export type RailAccount = {
  /** "Dana M.", or the role's own word when the session has no person behind it. */
  name: string;
  /** "Director", or null when it would only repeat the line above it. */
  role: string | null;
  /** "DM". */
  initials: string;
  /** What the whole block is announced as: "Dana M., Director". */
  label: string;
  href: string;
};

/**
 * DESIGN-DIRECTION §2: ≥1280 a 232 px left rail with labels; 768–1279 an icon rail, 64 px
 * wide, whose labels appear on hover *and* on keyboard focus.
 *
 * **Three blocks, not one** (REDESIGN-SPEC §9.2 and the founder's mockups,
 * png/shell-flow-1440.png): the brand at the top, the menu under it, and the account at the
 * bottom. Both of the new ones used to be in the white header instead, which is where the
 * duplication was — the product's name at the top left of the page *and* a rail under it with
 * nothing above the first menu item, an account pill at the top right *and* the full-height rail
 * ending in whitespace. At ≥1280 the rail carries both and the header carries neither; below it
 * the rail has no room for words, so the header is the one identity location again and the
 * mark stands alone (the stylesheet).
 *
 * The brand mark is the name's own first letter, so there is one place a centre is named.
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
 */
export function NavRail({
  role,
  account,
  waiting: forYouWaiting,
}: {
  role: StaffRole | null;
  account: RailAccount | null;
  /**
   * A live count of what is waiting in Family texts · For you, for the one badge on the menu.
   * There is none to pass until #61 lands, and an absent count draws nothing (`menuBadgeFor`).
   */
  waiting?: number | null;
}) {
  const pathname = usePathname();
  // The role is a string, so it crosses the server/client boundary; the icons do not, which is
  // why the list is built here rather than passed in.
  const navItems = navItemsFor(role);
  return (
    <nav className={styles.rail} aria-label={nav.landmarkLabel}>
      <div className={styles.panel}>
        <p className={styles.brand} data-rail-brand>
          <span className={styles.mark} aria-hidden="true">
            {app.brandName.trim()[0]}
          </span>
          <span className={styles.brandText}>
            <span className={styles.brandName}>{app.brandName}</span>
            <span className={styles.brandLine}>{app.brandLine}</span>
          </span>
        </p>
        <ul className={styles.list}>
          {navItems.map((item) => {
            const Icon = item.icon;
            const current = isCurrent(pathname, item.href);
            const waiting = menuBadgeFor(item.href, role, forYouWaiting);
            /*
             * The count is part of the name, not a decoration beside it: a disc with "2" in it
             * says nothing to a screen reader, and what is waiting for a person is exactly what
             * the row should be announced with (§9, `flow.tabbar`).
             */
            const name =
              waiting === null
                ? item.label
                : fill(flow.tabbar.waiting, { label: item.label, count: waiting });
            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  className={styles.link}
                  aria-label={name}
                  title={name}
                  aria-current={current ? "page" : undefined}
                  /*
                   * What a menu item *is*, for a check that counts them: the rail's foot carries
                   * one more link that is not a destination — the account block — so "how many
                   * links are in the nav" and "how many items are on the menu" are two
                   * questions, and this is the second one (e2e/nav-rail.spec.ts).
                   */
                  data-nav-item
                >
                  <Icon size={icon.nav} aria-hidden="true" />
                  <span className={styles.label} aria-hidden="true">
                    {item.label}
                  </span>
                  {waiting === null ? null : (
                    <span className={styles.badge} aria-hidden="true" data-menu-badge>
                      {waiting}
                    </span>
                  )}
                </Link>
              </li>
            );
          })}
        </ul>
        <span className={styles.grow} />
        {/*
          The account, at the foot of the rail and inside the frame: /whoami is a page in the
          group now, so this is a link to a screen rather than a panel that opens over one, and
          Sign out is on the other end of it.
        */}
        {account ? (
          <Link
            href={account.href}
            className={styles.account}
            aria-label={account.label}
            data-rail-account
          >
            <span className={styles.avatar} aria-hidden="true">
              {account.initials}
            </span>
            <span className={styles.accountText} aria-hidden="true">
              <span className={styles.accountName}>{account.name}</span>
              {account.role ? <span className={styles.accountRole}>{account.role}</span> : null}
            </span>
          </Link>
        ) : null}
      </div>
    </nav>
  );
}
