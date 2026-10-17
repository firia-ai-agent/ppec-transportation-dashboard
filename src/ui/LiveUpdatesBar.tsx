"use client";

/**
 * DESIGN-DIRECTION §2: "SSE down >15 s: amber bar under the header, icon `wifi-off` +
 * 'Live updates paused. Reconnecting… Board may be up to 40 s old.' Never hide data."
 *
 * Exactly that, and nothing more. It appears when the stream has gone quiet for longer than
 * the configured gap (src/config/live.ts) and it takes nothing off the screen underneath it:
 * every row keeps its last known window, state and van — a board that blanked itself would
 * turn a lost connection into a lost day.
 *
 * A `status` region, so a screen reader is told once, politely, rather than on every row.
 */

import { WifiOff } from "lucide-react";
import { liveUpdates } from "./copy";
import { useLiveBoard } from "./LiveStream";
import { icon } from "./tokens";
import styles from "./LiveUpdatesBar.module.css";

export function LiveUpdatesBar() {
  const { paused } = useLiveBoard();
  if (!paused) return null;
  return (
    <div className={styles.bar} role="status" aria-label={liveUpdates.ariaLabel}>
      <WifiOff size={icon.inline} aria-hidden="true" />
      <span className={styles.title}>{liveUpdates.downTitle}</span>
      <span className={styles.body}>{liveUpdates.downBody}</span>
    </div>
  );
}
