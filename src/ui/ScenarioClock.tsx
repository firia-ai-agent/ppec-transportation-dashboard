"use client";

import { scenarioClock } from "./copy";
import { useLiveBoard } from "./LiveStream";
import styles from "./ScenarioClock.module.css";

/** One instance, in the header, so a module constant is a safe id for `aria-describedby`. */
const TOOLTIP_ID = "scenario-clock-start-note";

/**
 * DESIGN-DIRECTION §2 header: the scenario clock, and the demo's Start beside it on the one
 * kind of shell that may move a clock at all.
 *
 * The readout is the clock the live board is actually being walked on, when a surface has
 * asked for one: the board streams a tick of the scenario clock and this is that tick in
 * words, so the time in the chrome and the ages in the rows are the same instant. On a
 * surface with no stream — Setup, Health — there is no scenario time to show and it says so.
 * The readout is **not** a control and is always here: reading a clock moves nothing.
 *
 * `mayMove` is the gate, and it is the date's own (`dateOverrideAllowed` in
 * src/domain/board/day.ts, read by the console layout): no deployment we own passes it, so no
 * deployment — preview or production — carries a clock control at all. Veri's requirement, and
 * the honest shape of it: a control that only ever appears where the clock may actually be
 * moved cannot promise a morning the deployment is not replaying.
 *
 * Where it does appear, Start stays inert and says so: the demo-controls dock (§6.1) owns play,
 * pause, speed and jump-to, and it is not built. `aria-disabled` rather than `disabled`, so the
 * button keeps its place in the tab order and a keyboard user can land on it and read the reason
 * (a `disabled` button is skipped, and the note would never be heard). `aria-describedby` ties
 * it to the note at every width; the note is also shown on hover and on focus. There is no
 * handler, so a click does nothing — the button cannot pretend to start anything.
 */
export function ScenarioClock({ mayMove = false }: { mayMove?: boolean }) {
  const { snapshot } = useLiveBoard();
  return (
    <div className={styles.row}>
      <span className={`${styles.readout} tabularNums`}>
        {snapshot ? snapshot.clockText : scenarioClock.notStarted}
      </span>
      {mayMove ? (
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
      ) : null}
    </div>
  );
}
