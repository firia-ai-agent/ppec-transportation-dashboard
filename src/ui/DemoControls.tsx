"use client";
/**
 * A demo-only choice, rendered in the DEMO bar's styling so it reads as a demo control.
 *
 * Vera's review, 2026-10-17: the Plan routes scenario toggle was two outlined buttons in the
 * screen's own header, which is where a coordinator's controls live — so a switch that only
 * exists to steer the demo looked like one of the day's decisions. The violet, the flask and the
 * bar's tracked 12 px label say what it is before it is read (DESIGN-DIRECTION §7, D-5), and
 * tokens.test.ts widens the violet's reservation to exactly this: the bar, the Simulated chip,
 * and a control that is part of the demo.
 *
 * It is one group of buttons and nothing else — no state of its own, no copy of its own. The
 * words come from the caller's own entry in src/ui/copy.ts, and the demo panel (B-15) is where
 * this control, and the others like it, end up; see docs/BUILD-PLAN-M2.md under the P-11 step.
 */
import { useId } from "react";
import { Check, FlaskConical } from "lucide-react";
import { icon } from "./tokens";
import styles from "./DemoControls.module.css";

export function DemoControls<T extends string>({
  legend,
  options,
  value,
  onChange,
  note,
}: {
  /** What the choice is, shown in the bar and read as the group's name. */
  legend: string;
  options: ReadonlyArray<{ value: T; label: string }>;
  value: T;
  onChange: (value: T) => void;
  /** One sentence about the option on screen, if there is one worth saying. */
  note?: string;
}) {
  const legendId = useId();
  return (
    // The attribute is what e2e locates demo chrome by, so the violet reservation can be
    // measured on the real screen rather than argued about. Nothing here depends on it.
    <div className={styles.bar} data-demo-control="true">
      <p id={legendId} className={styles.legend}>
        <FlaskConical size={icon.inline} aria-hidden="true" />
        <span>{legend}</span>
      </p>
      <div className={styles.buttons} role="group" aria-labelledby={legendId}>
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            className={styles.button}
            aria-pressed={option.value === value}
            onClick={() => onChange(option.value)}
          >
            {option.value === value ? <Check size={icon.inline} aria-hidden="true" /> : null}
            {option.label}
          </button>
        ))}
      </div>
      {note ? <p className={styles.note}>{note}</p> : null}
    </div>
  );
}
