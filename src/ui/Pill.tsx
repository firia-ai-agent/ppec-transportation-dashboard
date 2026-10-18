import type { ReactNode } from "react";
import type { Tone } from "./tokens";
import styles from "./Pill.module.css";

/**
 * THE PILL — the one component every chip on every screen is (audit §4 item 1).
 *
 * There is no second pill anywhere under src/: `StateChip` is this with a §3 tone, the §7.1
 * source chip is this with the `source` variant, and the van-fact and child-need chips are this
 * with the `outline` variant. The shape, the height and the "never wrap, never shrink" are in
 * one stylesheet (Pill.module.css) rather than in four, which is what makes a column of chips
 * line up and what fixed the founder's overlap at 390 px.
 *
 * It takes words and a tone. It decides nothing — not what a state is called (src/ui/states.ts),
 * not whether a role may see it — so a screen cannot grow a chip with an opinion in it.
 */
export function Pill({
  tone,
  variant,
  token,
  size,
  flag,
  className,
  children,
}: {
  /** A §3 state's tone: a filled chip in one of the five §8 pairs. */
  tone?: Tone;
  /**
   * `outline` is a fact about a thing rather than a state of it; `source` is the §7.1 chip in
   * the DEMO bar. No variant at all is the filled tone chip.
   */
  variant?: "outline" | "source";
  /** For the source chip: which §7.1 colour token its text takes. */
  token?: string;
  /** The ramp iPad's 24 px source chip (§7.1). */
  size?: "console" | "ramp";
  /** An outlined chip about something nobody has approved (VEH-01): the same pill, dashed. */
  flag?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span
      className={[styles.pill, className].filter(Boolean).join(" ")}
      data-tone={tone}
      data-variant={variant}
      data-token={token}
      data-size={size}
      data-flag={flag ? "true" : undefined}
      data-pill="true"
    >
      {children}
    </span>
  );
}

/** The chip's own words, with figures that line up column to column (§2). */
export function PillLabel({ children }: { children: ReactNode }) {
  return <span className={styles.label}>{children}</span>;
}
