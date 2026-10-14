import { fill, screenReader } from "./copy";
import { icon } from "./tokens";
import { sourceModes, type SourceModeKey } from "./states";
import styles from "./SourceBadge.module.css";

/**
 * DESIGN-DIRECTION §7.1 (D-10): an outlined chip — 1 px `border-strong`, white fill, 12 px
 * text + 14 px icon, 20 px high (24 px on the ramp iPad) — so it never reads as a filled
 * state chip. Screen reader: "Source: Simulated". SIMULATED is the demo violet `src-sim`;
 * LIVE is `ink` and is never violet.
 *
 * NFR-09 requires one of these on every screen, record and outbound message.
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
    <span
      className={[styles.badge, className].filter(Boolean).join(" ")}
      data-size={size}
      data-token={source.textToken}
    >
      <Icon size={icon.chip} aria-hidden="true" />
      <span className="srOnly">{fill(screenReader.source, { label: source.label })}</span>
      <span aria-hidden="true">{source.label}</span>
    </span>
  );
}
