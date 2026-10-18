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
import type { RightNowKey, RightNowPillKind, RightNowTile } from "@/domain/health/right-now";
import { healthNow } from "@/ui/copy";
import { Pill, PillLabel } from "@/ui/Pill";
import { icon } from "@/ui/tokens";
import styles from "./health.module.css";

/**
 * THE FOUR TILES (png/health-demo-1440.png, png/health-demo-390.png).
 *
 * A label, a number, and at most one pill. The number was counted before this component was
 * called. The pills are grey (the neutral tone): colour is not how these four are told apart,
 * the icon and the word are. At 390 they sit two to a row; wider, they are one row of four.
 */
const TILE_ICONS: Record<RightNowKey, LucideIcon> = {
  KIDS_PLACED: Users,
  VANS_CHECKED: ClipboardCheck,
  RUNNING_LATE: Clock,
  NEEDS_YOU: Hand,
};

const PILL_ICONS: Record<RightNowPillKind, LucideIcon> = {
  all: Check,
  van: Clock,
  family: MessageSquare,
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
              <article className={styles.tile}>
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
                  <span className={`${styles.count} tabularNums`}>{tile.count}</span>
                  {tile.outOf !== null ? <span className={`${styles.outOf} tabularNums`}>/{tile.outOf}</span> : null}
                </p>
                {tile.pill && PillIcon ? (
                  <Pill tone="neutral">
                    <PillIcon size={icon.pill} aria-hidden="true" />
                    <PillLabel>{tile.pill.text}</PillLabel>
                  </Pill>
                ) : null}
              </article>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
