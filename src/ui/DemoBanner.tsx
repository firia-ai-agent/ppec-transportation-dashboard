import { FlaskConical } from "lucide-react";
import { demoBanner } from "./copy";
import { icon } from "./tokens";
import { isSyntheticDemo } from "@/lib/env";
import styles from "./DemoBanner.module.css";

/**
 * DESIGN-DIRECTION §7 / NFR-09: a 32 px full-width violet bar above everything, icon
 * `flask-conical`, text exactly "DEMO" (COPY-GUIDE §6), role="status" with aria-label
 * "Demo environment", announced once on load. Not dismissible.
 *
 * Rendered only while the environment is synthetic. P1 is synthetic by construction
 * (src/lib/env.ts refuses to start otherwise), so in practice it always renders; the guard
 * is what keeps the demo violet out of a future LIVE build (§7, D-5).
 */
export function DemoBanner() {
  if (!isSyntheticDemo()) return null;
  return (
    <div className={styles.banner} role="status" aria-label={demoBanner.ariaLabel}>
      <FlaskConical size={icon.banner} aria-hidden="true" />
      <span className={styles.text}>{demoBanner.text}</span>
    </div>
  );
}
