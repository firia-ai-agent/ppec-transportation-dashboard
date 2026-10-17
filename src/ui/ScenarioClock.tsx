"use client";

import { scenarioClock } from "./copy";
import { demoClockReadout, resetDemoClock, startDemoClock, useDemoClock } from "./demo-clock";
import styles from "./ScenarioClock.module.css";

/**
 * DESIGN-DIRECTION §2 header: the scenario clock, with the demo's Start beside it (§6.1 "Clock":
 * a time readout and a control; COPY-GUIDE §52: "Demo not started" with a [Start] button).
 *
 * It starts the demo day. It used to be rendered inert — `aria-disabled`, no handler, and a
 * tooltip saying the demo controls were not connected — which is the one thing a control may
 * never be: the founder's first click on the live site landed on a button that looked like a
 * button and did nothing, and the explanation was on hover, which a phone does not have
 * (founder, 2026-10-17 14:40 ET).
 *
 * Now: one button, two states. Not started, it says "Start demo day" and the readout says the
 * demo has not started; running, the readout is the scenario time and the same button resets the
 * day. The state is in the words, not in a colour (§3, §9), and the readout is the feedback —
 * the press changes it immediately.
 *
 * The clock is `src/ui/demo-clock.ts`, which is shared: the board reads the same tick and shows
 * the same day further into itself. Nothing here holds a time of its own.
 *
 * No live region on the readout: it changes every half-second while the day runs, and a screen
 * reader reading each one would talk over the board. The button's own name is what changes on
 * the press the user made.
 */
export function ScenarioClock() {
  const clock = useDemoClock();
  return (
    <div className={styles.row}>
      {/* The attribute is how the browser check reads the running clock off the real screen. */}
      <span className={`${styles.readout} tabularNums`} data-scenario-clock="readout">
        {demoClockReadout(clock)}
      </span>
      <button
        type="button"
        className={styles.start}
        onClick={clock.running ? resetDemoClock : startDemoClock}
      >
        {clock.running ? scenarioClock.reset : scenarioClock.start}
      </button>
    </div>
  );
}
