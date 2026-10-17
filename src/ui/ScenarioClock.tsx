"use client";

import { scenarioClock } from "./copy";
import { useLiveBoard } from "./LiveStream";
import styles from "./ScenarioClock.module.css";

/** One instance, in the header, so a module constant is a safe id for `aria-describedby`. */
const TOOLTIP_ID = "scenario-clock-start-note";

/**
 * DESIGN-DIRECTION §2 header: the scenario clock, with the demo's Start beside it.
 *
 * The readout is the clock the live board is actually being walked on, when a surface has
 * asked for one: the board streams a tick of the scenario clock and this is that tick in
 * words, so the time in the chrome and the ages in the rows are the same instant. On a
 * surface with no stream — Setup, Health — there is no scenario time to show and it says so.
 *
 * Start stays inert, and honestly so: the demo-controls dock (§6.1) owns play, pause, speed
 * and jump-to, and it is not built. `aria-disabled` rather than `disabled`, so the button
 * keeps its place in the tab order and a keyboard user can land on it and read the reason (a
 * `disabled` button is skipped, and the note would never be heard). `aria-describedby` ties it
 * to the note at every width; the note is also shown on hover and on focus. There is no
 * handler, so a click does nothing — the button cannot pretend to start anything.
 */
export function ScenarioClock() {
  const { snapshot } = useLiveBoard();
  return (
    <div className={styles.row}>
      <span className={`${styles.readout} tabularNums`}>
        {snapshot ? snapshot.clockText : scenarioClock.notStarted}
      </span>
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
