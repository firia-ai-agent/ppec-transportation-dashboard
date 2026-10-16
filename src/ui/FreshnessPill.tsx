import { FlaskConical, type LucideIcon } from "lucide-react";
import { adapters, fill, screenReader } from "./copy";
import { icon } from "./tokens";
import type { Tone } from "./tokens";
import styles from "./FreshnessPill.module.css";

/**
 * An adapter pill may also be the outlined "sim" variant, which is not a status tone (§7.1): it
 * says where a value came from, not how the day is going, so it gets an outline and no fill.
 * It is not violet — D-5 keeps that for the DEMO bar and the Simulated chip, and nothing else.
 */
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
 * The interim pill approved for build in §2: "<adapter> · Simulated", `flask-conical`, in the
 * outlined variant that matches the D-10 source badge's shape without taking its colour. §10
 * requires the text to be replaced by real ages (humanized through src/ui/age.ts) when the live
 * stream can carry them; until then it says "Simulated", which is true, rather than an age that
 * is not.
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
