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
 *
 * **One screen in the app has no row to read, and it is the refusal** (Veri's gate on #74: the
 * card arrived with no h1 at all). "This page isn't part of your role" is rendered by a 403
 * boundary at an address that is deliberately not a screen — no row in the access table, so no
 * label — and before this it left the bar with nothing to print and the screen with no title.
 * So a caller that *is* the title may say so: `title` is the frame's heading when the path
 * cannot name it (src/ui/RefusedPage.tsx is the only one, and the card below it then carries no
 * heading of its own, so the screen still has exactly one h1).
 */
export function PageHeader({
  account,
  title: given,
}: {
  account: RailAccount | null;
  /** The screen's title when it has no row in the access table to read one from. */
  title?: string;
}) {
  const pathname = usePathname();
  const title = given ?? pageTitleFor(pathname);
  const today = pathname === "/today";
  return (
    <div className={styles.bar} data-screen={today ? "today" : undefined}>
      {/* A screen with no row in the table has no title to print, and prints none. */}
      {title ? <h1 className={styles.title}>{title}</h1> : null}
      {/*
        Today's tabs and date are portaled here so they share this bar with the title
        (png/health-demo-1440.png: one row). The slot is empty on every other screen.
      */}
      {today ? <div id="today-header-chrome" className={styles.chrome} /> : null}
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
