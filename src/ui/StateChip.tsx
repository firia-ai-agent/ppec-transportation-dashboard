import { fill } from "./copy";
import { icon } from "./tokens";
import type { StateDescriptor } from "./states";
import styles from "./StateChip.module.css";

/**
 * DESIGN-DIRECTION §3: icon + label always, colour is the third cue. Minimum 12 px text,
 * allowed only because the chip has an icon (§2).
 *
 * **One label, read once.** The chip used to render its label twice — a screen-reader copy
 * prefixed "State: " and an `aria-hidden` copy for the eye — and the prefix was on the screen's
 * own text: a prod walk read "State: Reported by provider" off three screens (Vera, 2026-10-17
 * 2:48 PM ET). "State:" is a column name, not a state, and the §3 label already says what kind
 * of thing it is. So the label is rendered once, visible and announced, and it is the §3 string
 * out of src/ui/states.ts with nothing in front of it.
 *
 * `values` fills the `{placeholder}` segments some §3 labels carry
 * ("Handed off to {receiver role}", "Snoozed until {time}").
 */
export function StateChip({
  state,
  values,
  className,
}: {
  state: StateDescriptor;
  values?: Record<string, string | number>;
  className?: string;
}) {
  const Icon = state.icon;
  const label = values ? fill(state.label, values) : state.label;
  return (
    <span
      className={[styles.chip, className].filter(Boolean).join(" ")}
      data-tone={state.tone}
    >
      <Icon size={icon.chip} aria-hidden="true" />
      <span className={styles.label}>{label}</span>
    </span>
  );
}
