import { FlaskConical } from "lucide-react";
import { demoBanner } from "./copy";
import { icon } from "./tokens";
import { isSyntheticDemo } from "@/lib/env";
import { ScreenSource } from "./ScreenSource";
import styles from "./DemoBanner.module.css";

/**
 * DESIGN-DIRECTION §7 / NFR-09: a 32 px full-width violet bar above everything, icon
 * `flask-conical`, text exactly "DEMO" (COPY-GUIDE §6), role="status" with aria-label
 * "DEMO" too (ledger row 40 covers the screen-reader label), announced once on load.
 * Not dismissible.
 *
 * The bar also carries the one screen-level source-mode chip (§7.1, NFR-09) in its trailing
 * cell — Vera's answer, 2026-10-14: the chip goes *next to* the banner as the small outlined
 * D-10 chip, and there is no second full-width strip under it. "DEMO" keeps its own centre
 * column, so the chip never pushes it off-centre or overlaps it; `role="status"` wraps the
 * DEMO text only, so a reader announces the banner and the chip as the two separate things
 * they are.
 *
 * Rendered only while the environment is synthetic. P1 is synthetic by construction
 * (src/lib/env.ts refuses to start otherwise), so in practice it always renders; the guard
 * is what keeps the demo violet out of a future LIVE build (§7, D-5). The chip rides with the
 * bar because in LIVE the bar itself becomes the slim neutral "LIVE" chip (§7) — there is no
 * violet banner left for a separate chip to sit beside.
 */
export function DemoBanner() {
  if (!isSyntheticDemo()) return null;
  return (
    <div className={styles.banner}>
      <p className={styles.demo} role="status" aria-label={demoBanner.ariaLabel}>
        <FlaskConical size={icon.banner} aria-hidden="true" />
        <span className={styles.text}>{demoBanner.text}</span>
      </p>
      {/* §7.1 / NFR-09: the single screen-level source chip, in the bar's trailing cell. */}
      <div className={styles.source}>
        <ScreenSource />
      </div>
    </div>
  );
}
