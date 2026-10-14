import type { ReactNode } from "react";
import { adapters, app, board } from "./copy";
import { uiSourceMode } from "@/lib/env";
import { AvatarMenu } from "./AvatarMenu";
import { MobileNav } from "./MobileNav";
import { NavRail } from "./NavRail";
import { SearchField } from "./SearchField";
import { SignOutButton } from "./SignOutButton";
import { SimulatedAdapterPill } from "./FreshnessPill";
import { SourceBadge } from "./SourceBadge";
import { serviceDateIso, serviceDateLabel } from "./service-date";
import styles from "./AppShell.module.css";

/**
 * DESIGN-DIRECTION §2 global shell. The DEMO banner itself is rendered by the root layout so
 * it also covers /login; the header sits directly beneath it, carrying — in §2's order — the
 * site name, the service date, the scenario clock, the per-adapter freshness pills and global
 * search, with the source-mode badge next to the banner (§7.1) and one identity location,
 * the avatar menu, top right.
 *
 * Nav: NavRail handles ≥1280 (232 px, labelled) and 768–1279 (icon rail, label on
 * hover/focus); MobileNav handles <768 (hamburger drawer with nav + identity + Sign out).
 */
export function AppShell({
  displayName,
  children,
}: {
  displayName: string;
  children: ReactNode;
}) {
  const mode = uiSourceMode();
  return (
    <div className={styles.shell}>
      {/* §9 keyboard-only walk: the rail and header come before the board, so give it a bypass. */}
      <a href="#content" className="skipLink">
        {app.skipToContent}
      </a>
      <header className={styles.header}>
        <div className={styles.topRow}>
          <MobileNav identity={<p>{displayName}</p>} signOut={<SignOutButton />} />
          <div className={styles.brand}>
            <span className={styles.siteName}>{app.siteName}</span>
            {/* §7.1: the screen-level source badge, next to the DEMO banner above. */}
            <SourceBadge mode={mode} />
          </div>
          <dl className={styles.facts}>
            <div className={styles.fact}>
              <dt className={styles.factLabel}>{board.dateLabel}</dt>
              <dd className={styles.factValue}>
                <time dateTime={serviceDateIso()} className="tabularNums">
                  {serviceDateLabel()}
                </time>
              </dd>
            </div>
            <div className={styles.fact}>
              <dt className={styles.factLabel}>{board.clockLabel}</dt>
              {/* The demo clock is wired by the demo-controls dock (§6.1); until then it says so. */}
              <dd className={styles.factValue}>
                <span className="tabularNums">{board.clockPlaceholder}</span>
              </dd>
            </div>
          </dl>
          <div className={styles.spacer} />
          <AvatarMenu displayName={displayName} />
        </div>
        <div className={styles.bottomRow}>
          <section className={styles.adapters} aria-label={adapters.groupLabel}>
            <SimulatedAdapterPill adapter={adapters.sms} />
            <SimulatedAdapterPill adapter={adapters.teams} />
            <SimulatedAdapterPill adapter={adapters.gps} />
            <SimulatedAdapterPill adapter={adapters.agent} />
            {/* §2/§10: these are interim values, and the header says so out loud. */}
            <p className={styles.adaptersNote}>{adapters.interimNote}</p>
          </section>
          <SearchField />
        </div>
      </header>
      <div className={styles.body}>
        <NavRail />
        <main id="content" className={styles.main}>
          {children}
        </main>
      </div>
    </div>
  );
}
