/**
 * Design tokens for the ramp preview (DESIGN-DIRECTION.md §8; ratios computed by
 * docs/design/contrast.py). Local to this route until the shared shell (B-12) lands a token module;
 * values must stay identical to §8, so copy from there rather than inventing new pairs.
 */
export const color = {
  bg: "#F8FAFC",
  surface: "#FFFFFF",
  ink: "#0F172A",
  inkMuted: "#475569",
  border: "#CBD5E1",
  borderStrong: "#64748B",
  brand: "#1D4ED8",
  focus: "#1D4ED8",
  okFg: "#166534",
  okBg: "#DCFCE7",
  infoFg: "#1E40AF",
  infoBg: "#DBEAFE",
  warnFg: "#854D0E",
  warnBg: "#FEF9C3",
  critFg: "#991B1B",
  critBg: "#FEE2E2",
  neutralFg: "#334155",
  neutralBg: "#E2E8F0",
  demoFg: "#FFFFFF",
  demoBg: "#6D28D9",
  srcSim: "#6D28D9",
} as const;

export type Tone = "ok" | "info" | "warn" | "crit" | "neutral";
export const tone: Record<Tone, { fg: string; bg: string }> = {
  ok: { fg: color.okFg, bg: color.okBg },
  info: { fg: color.infoFg, bg: color.infoBg },
  warn: { fg: color.warnFg, bg: color.warnBg },
  crit: { fg: color.critFg, bg: color.critBg },
  neutral: { fg: color.neutralFg, bg: color.neutralBg },
};

/** Ramp iPad sizing (§4.4, §9): targets >= 56 px, 16 px gaps, 18 px body. */
export const size = {
  target: 56,
  gap: 16,
  body: 18,
  radius: 10,
} as const;

export const focusRing = { outline: `2px solid ${color.focus}`, outlineOffset: 2 } as const;
