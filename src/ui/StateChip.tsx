import { fill, screenReader } from "./copy";
import { icon } from "./tokens";
import type { StateDescriptor } from "./states";
import styles from "./StateChip.module.css";

/**
 * DESIGN-DIRECTION §3: icon + label always, colour is the third cue. §9: screen readers
 * read "State: Needs action". Minimum 12 px text, allowed only because the chip has an icon (§2).
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
      <span className="srOnly">{fill(screenReader.state, { label })}</span>
      <span aria-hidden="true" className={styles.label}>
        {label}
      </span>
    </span>
  );
}
