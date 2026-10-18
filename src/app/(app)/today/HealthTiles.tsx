import {
  Check,
  ChevronRight,
  ClipboardCheck,
  Clock,
  Hand,
  MessageSquare,
  Users,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { FAMILY_TEXTS_FOR_YOU } from "@/auth/access";
import type { RightNowKey, RightNowPillKind, RightNowTile } from "@/domain/health/right-now";
import { healthNow } from "@/ui/copy";
import { Pill, PillLabel } from "@/ui/Pill";
import { icon, type Tone } from "@/ui/tokens";
import styles from "./health.module.css";

/**
 * THE FOUR TILES (png/health-demo-1440.png, png/health-demo-390.png).
 *
 * A label, a number, and at most one pill. The number was counted before this component was
 * called. All is green, and a van that is open or late — or the count of the vans still to
 * check — is amber, the same ok and warn the step strip uses. Family texts is the info teal.
 * A count of 0 is the grey None. At 390 they sit two to a row; wider, they are one row of four.
 */
const TILE_ICONS: Record<RightNowKey, LucideIcon> = {
  KIDS_PLACED: Users,
  VANS_CHECKED: ClipboardCheck,
  RUNNING_LATE: Clock,
  NEEDS_YOU: Hand,
};

const PILL_ICONS: Partial<Record<RightNowPillKind, LucideIcon>> = {
  all: Check,
  van: Clock,
  // "3 to check" draws the van chip's own mark: the chip keeps its shape when the work comes
  // down to the last van and it becomes "Van 3".
  count: Clock,
  family: MessageSquare,
};

/**
 * Where a tile goes (png/health-demo-1440.png, png/health-demo-390.png).
 * The whole card is the link, chevron included, and the shell around it is the menu.
 *
 * All is the step strip's Done (ok, green). An open or late van, and the number of vans still
 * to check, are its Needed (warn, amber). Family texts is the info teal the mockup draws (chip
 * info). Grey is None, a count of 0.
 */
export const TILE_LINKS: Record<RightNowKey, string> = {
  KIDS_PLACED: "/plan-routes",
  VANS_CHECKED: "/ramp-ipad",
  RUNNING_LATE: "/live-map",
  NEEDS_YOU: FAMILY_TEXTS_FOR_YOU,
};

const PILL_TONE: Record<RightNowPillKind, Tone> = {
  all: "ok",
  van: "warn",
  count: "warn",
  family: "info",
  none: "neutral",
};

export function HealthTiles({ tiles }: { tiles: readonly RightNowTile[] }) {
  return (
    <section className={styles.health} aria-labelledby="right-now-heading">
      <h2 id="right-now-heading" className={styles.section}>
        {healthNow.rightNow}
      </h2>
      <ul className={styles.tiles}>
        {tiles.map((tile) => {
          const TileIcon = TILE_ICONS[tile.key];
          const PillIcon = tile.pill ? PILL_ICONS[tile.pill.kind] : null;
          return (
            <li key={tile.key} className={styles.item}>
              <Link href={TILE_LINKS[tile.key]} className={styles.tile}>
                <div className={styles.head}>
                  <TileIcon size={icon.inline} aria-hidden="true" />
                  <span className={styles.label}>{tile.label}</span>
                  <ChevronRight className={styles.chevron} size={icon.inline} aria-hidden="true" />
                </div>
                <p className={styles.figure}>
                  {/*
                    One text run: a newline between these spans would render as a gap, and the
                    mockup writes the fraction closed up (12/12, 2/3).
                  */}
                  <span className={styles.count}>{tile.count}</span>
                  {tile.outOf !== null ? <span className={styles.outOf}>/{tile.outOf}</span> : null}
                </p>
                {tile.pill ? (
                  <Pill tone={PILL_TONE[tile.pill.kind]}>
                    {PillIcon ? <PillIcon size={icon.pill} aria-hidden="true" /> : null}
                    <PillLabel>{tile.pill.text}</PillLabel>
                  </Pill>
                ) : null}
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
