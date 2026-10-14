/**
 * DEMO banner and source-mode badge (DESIGN-DIRECTION §7 / §7.1; PRD NFR-09,
 * DECISION-LEDGER row 40: the text is exactly "DEMO").
 *
 * Server components: no state, no hooks, no data access. The §3/§7 Lucide icons
 * (`flask-conical`) land with the B-12 shell, which is where the icon set is added;
 * until then the banner and badge are text-only, which still satisfies NFR-09.
 */

import styles from "./demo.module.css";

/** 32 px bar, violet, not dismissible. Render it above everything on the route. */
export function DemoBanner() {
  return (
    <div className={styles.banner} role="status" aria-label="DEMO">
      DEMO
    </div>
  );
}

/** The SIMULATED row of the §7.1 source-mode table. Reads "Source: Simulated". */
export function SimulatedBadge() {
  return (
    <span className={styles.badge}>
      <span className={styles.srOnly}>Source: </span>
      Simulated
    </span>
  );
}
