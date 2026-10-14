import { FlaskConical, type LucideIcon } from "lucide-react";
import { adapters, fill, screenReader } from "./copy";
import { icon } from "./tokens";
import type { Tone } from "./tokens";
import styles from "./FreshnessPill.module.css";

/** Adapter pills may also carry the simulated violet, which is not a status tone (§7.1, D-5). */
export type PillTone = Tone | "sim";

/**
 * DESIGN-DIRECTION §2 header: one pill per adapter, icon + label + age. §3 GPS bands reuse it.
 * Screen reader gets "SMS: Simulated" rather than the "·" separator read aloud.
 */
export function FreshnessPill({
  adapter,
  value,
  icon: Icon,
  tone = "neutral",
  className,
}: {
  /** "SMS", "Teams", "GPS", "Agent". */
  adapter: string;
  /** "Simulated" today; "Live · 12 s" / "Stale · 4 min" once the live board wires real ages. */
  value: string;
  icon: LucideIcon;
  tone?: PillTone;
  className?: string;
}) {
  return (
    <span className={[styles.pill, className].filter(Boolean).join(" ")} data-tone={tone}>
      <Icon size={icon.chip} aria-hidden="true" />
      <span className="srOnly">{fill(screenReader.freshness, { adapter, value })}</span>
      <span aria-hidden="true" className={styles.label}>
        {adapter}
        <span className={styles.separator}>{adapters.separator}</span>
        {value}
      </span>
    </span>
  );
}

/**
 * The interim pill approved for build in §2: "<adapter> · Simulated", `flask-conical` in the
 * src-sim tone, matching the D-10 source badge. §10 requires this to be replaced by real ages
 * (humanized through src/ui/age.ts) when the live board lands.
 */
export function SimulatedAdapterPill({ adapter }: { adapter: string }) {
  return (
    <FreshnessPill
      adapter={adapter}
      value={adapters.simulatedValue}
      icon={FlaskConical}
      tone="sim"
    />
  );
}
