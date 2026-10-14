import { scenarioClock } from "./copy";
import styles from "./ScenarioClock.module.css";

/** One instance, in the header, so a module constant is a safe id for `aria-describedby`. */
const TOOLTIP_ID = "scenario-clock-start-note";

/**
 * DESIGN-DIRECTION §2 header: the scenario clock, with the demo's Start beside it. The
 * demo-controls dock (§6.1) owns the clock and is not built, so the readout says "Demo not
 * started" and Start is rendered inert.
 *
 * Inert, not absent, and honest about why: `aria-disabled` rather than `disabled`, so the
 * button keeps its place in the tab order and a keyboard user can land on it and read the
 * reason (a `disabled` button is skipped, and the note would never be heard). `aria-describedby`
 * ties it to the note at every width; the note is also shown on hover and on focus. There is
 * no handler, so a click does nothing — the button cannot pretend to start anything.
 */
export function ScenarioClock() {
  return (
    <div className={styles.row}>
      <span className={`${styles.readout} tabularNums`}>{scenarioClock.notStarted}</span>
      <span className={styles.control}>
        <button
          type="button"
          className={styles.start}
          aria-disabled="true"
          aria-describedby={TOOLTIP_ID}
        >
          {scenarioClock.start}
        </button>
        <span id={TOOLTIP_ID} role="tooltip" className={styles.tooltip}>
          {scenarioClock.startUnavailable}
        </span>
      </span>
    </div>
  );
}
