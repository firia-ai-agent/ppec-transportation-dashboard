"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { pageTitleFor } from "./page-title";
import type { RailAccount } from "./NavRail";
import styles from "./PageHeader.module.css";

/**
 * THE PAGE HEADER BAR — 64 px at the top of the content column, and the only header this app
 * has (Vera's audit §2 items 1 and 5, png/shell-flow-1440.png and png/shell-flow-390.png).
 *
 * What it replaced: a full-width 96 px white band across the top of every screen with the words
 * "PPEC transportation" in it, above a rail that started with nothing, with an outlined "D ·
 * Dana ⌄" pill at its far right. The band is deleted at every width — the brand is the block at
 * the head of the rail and the account is the block at its foot — and this is what the mockup
 * draws in its place: the screen's own title, 20 px semibold in Teal Ink, on a white bar with a
 * hairline under it.
 *
 * **The one thing left of the old header is the account's disc, and only below 768**, where the
 * rail is a bottom tab bar with no room for a name: a 36 px circle of initials at the bar's
 * trailing end (audit §2 item 5, crop frame-390-2.png). It is a link to /whoami — the account
 * screen, which is where Sign out is — so the way to stop being signed in is one tap from every
 * screen at every width, as Firia's 3:08 PM ET ruling requires. No chevron, no panel, no second
 * identity: above 768 the rail's own block is it and this disc is not drawn.
 *
 * The title is the screen's own label from the access table (src/ui/page-title.ts), which is
 * why this is a client component: the path is the only input, and `usePathname` is how a
 * component inside a server layout learns it.
 */
export function PageHeader({ account }: { account: RailAccount | null }) {
  const pathname = usePathname();
  const title = pageTitleFor(pathname);
  return (
    <div className={styles.bar}>
      {/* A screen with no row in the table has no title to print, and prints none. */}
      {title ? <h1 className={styles.title}>{title}</h1> : null}
      <span className={styles.spacer} />
      {account ? (
        <Link
          href={account.href}
          className={styles.avatar}
          aria-label={account.label}
          data-page-account
        >
          <span aria-hidden="true">{account.initials}</span>
        </Link>
      ) : null}
    </div>
  );
}
