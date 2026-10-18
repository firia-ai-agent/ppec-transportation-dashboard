import { fill, screenReader } from "./copy";
import { icon } from "./tokens";
import { Pill } from "./Pill";
import { sourceModes, type SourceModeKey } from "./states";

/**
 * DESIGN-DIRECTION §7.1 (D-10) and Vera's audit §2 item 4: the one source-mode chip, and it is
 * the one pill — fully rounded (9999px), 20 px high, `0 8px` of padding, a white fill and 11 px
 * semibold text in the mode's own token (violet for SIMULATED, ink for LIVE, and never violet
 * for LIVE). It used to be a square-cornered outlined box, which is what the audit's crop shows.
 *
 * Screen reader: "Source: Simulated". NFR-09 requires one of these on every screen, record and
 * outbound message; the screen-level one rides in the DEMO bar (src/ui/ScreenSource.tsx).
 */
export function SourceBadge({
  mode,
  size = "console",
  className,
}: {
  mode: SourceModeKey;
  /** "ramp" is the 24 px variant for the ramp iPad (§7.1). */
  size?: "console" | "ramp";
  className?: string;
}) {
  const source = sourceModes[mode];
  const Icon = source.icon;
  return (
    <Pill variant="source" size={size} token={source.textToken} className={className}>
      <Icon size={icon.pill} aria-hidden="true" />
      <span className="srOnly">{fill(screenReader.source, { label: source.label })}</span>
      <span aria-hidden="true">{source.label}</span>
    </Pill>
  );
}
