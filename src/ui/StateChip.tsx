import { fill, screenReader } from "./copy";
import { icon } from "./tokens";
import { Pill, PillLabel } from "./Pill";
import type { StateDescriptor } from "./states";

/**
 * DESIGN-DIRECTION §3: icon + label always, colour is the third cue. §9: screen readers
 * read "State: Needs action".
 *
 * It is the one pill (src/ui/Pill.tsx) with a §3 tone on it — it has no shape, height or
 * wrapping rule of its own any more. That is the audit's §4.1 fix: this chip, the van-fact chip
 * and the ramp iPad's two were four different boxes, and the one at 11 px/22 px that may not
 * wrap is now the only one. Text is 11 px, which the chip's icon earns (§2).
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
    <Pill tone={state.tone} className={className}>
      <Icon size={icon.pill} aria-hidden="true" />
      <span className="srOnly">{fill(screenReader.state, { label })}</span>
      <PillLabel>
        <span aria-hidden="true">{label}</span>
      </PillLabel>
    </Pill>
  );
}
