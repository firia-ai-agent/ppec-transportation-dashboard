import type { ReactNode } from "react";
import type { StaffRole } from "@/auth/core";
import { adapters, app, scenarioClock } from "./copy";
import { AvatarMenu } from "./AvatarMenu";
import { MobileNav } from "./MobileNav";
import { NavRail } from "./NavRail";
import { ScenarioClock } from "./ScenarioClock";
import { SearchField } from "./SearchField";
import { SignOutButton } from "./SignOutButton";
import { SimulatedAdapterPill } from "./FreshnessPill";
import styles from "./AppShell.module.css";

/**
 * DESIGN-DIRECTION §2 global shell. The DEMO banner and the source-mode badge are rendered by
 * the root layout, so they also cover /login (§7, §7.1, NFR-09); the header sits directly
 * beneath them, carrying — in §2's order — the site name, the scenario clock, the per-adapter
 * freshness pills and global search, with one identity location, the avatar menu, top right.
 * §2's service date is not in here: it belongs to the board, which is the thing that has a day
 * (see the note below, and docs/ui/B12-SLICE1-DEFERRED.md §5).
 *
 * Nav: NavRail handles ≥1280 (232 px, labelled) and 768–1279 (icon rail, label on
 * hover/focus); MobileNav handles <768 (hamburger drawer with nav + identity + Sign out). Both
 * are given the caller's role and offer only the destinations that role's row in the access
 * table opens — a courtesy on top of the per-page server guard, never instead of it.
 */
export function AppShell({
  displayName,
  role,
  children,
}: {
  displayName: string;
  /** The caller's role, so the rail offers only the pages they can open. `null` shows none. */
  role: StaffRole | null;
  children: ReactNode;
}) {
  return (
    <div className={styles.shell}>
      {/* §9 keyboard-only walk: the rail and header come before the board, so give it a bypass. */}
      <a href="#content" className="skipLink">
        {app.skipToContent}
      </a>
      <header className={styles.header}>
        <div className={styles.topRow}>
          <MobileNav role={role} identity={<p>{displayName}</p>} signOut={<SignOutButton />} />
          <span className={styles.siteName}>{app.siteName}</span>
          <dl className={styles.facts}>
            {/*
              §2 asks the header for the service date, and the board's own header is where it now
              is: it is a property of the day on screen. In demo mode the chrome shows no date —
              it used to carry today's real date while the board carried the seeded day the
              scenario replays, both labelled "Service date", one of them always wrong
              (docs/ui/B12-SLICE1-DEFERRED.md §5). The surfaces that have no day do not pretend
              to have one.
            */}
            <div className={styles.fact}>
              <dt className={styles.factLabel}>{scenarioClock.label}</dt>
              {/* The demo clock is wired by the demo-controls dock (§6.1); until then it says so. */}
              <dd className={styles.factValue}>
                <ScenarioClock />
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
        <NavRail role={role} />
        <main id="content" className={styles.main}>
          {children}
        </main>
      </div>
    </div>
  );
}
