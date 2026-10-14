/**
 * Design tokens: the ONLY place a colour literal may appear in src/.
 * Source of truth: DESIGN-DIRECTION.md §8 (tokens + computed contrast), §2 (type scale),
 * §7 (DEMO banner height), §7.1 (source badge metrics), §9 (focus ring, target sizes).
 *
 * Enforced by two tests:
 *  - tokens.test.ts recomputes the WCAG 2.1 contrast of every §8 pair from the hexes below.
 *  - no-hex.test.ts fails if any other file under src/ contains a hex colour literal.
 *
 * Consumers must read colours through the CSS custom properties emitted by `tokenCss()`
 * (see src/app/layout.tsx), never by importing `color` into a component.
 */

/* ───────────────────────────── colour (§8) ───────────────────────────── */

export const color = {
  ink: "#0F172A",
  "ink-muted": "#475569",
  bg: "#F8FAFC",
  surface: "#FFFFFF",
  "border-strong": "#64748B",
  brand: "#1D4ED8",
  focus: "#1D4ED8",

  "ok-fg": "#166534",
  "ok-bg": "#DCFCE7",
  "info-fg": "#1E40AF",
  "info-bg": "#DBEAFE",
  "warn-fg": "#854D0E",
  "warn-bg": "#FEF9C3",
  "crit-fg": "#991B1B",
  "crit-bg": "#FEE2E2",
  "neutral-fg": "#334155",
  "neutral-bg": "#E2E8F0",

  // Violet is reserved for demo/simulated only (D-5) so it never reads as a status colour.
  "demo-fg": "#FFFFFF",
  "demo-bg": "#6D28D9",
  "src-sim": "#6D28D9",

  // Map markers are checked against white because every marker carries a white halo (§8 note).
  "map-truck-ok": "#15803D",
  "map-truck-stale": "#A16207",
  "map-truck-crit": "#B91C1C",
} as const;

export type ColorToken = keyof typeof color;

/** The five tone tokens used by state chips (§3). Colour is always the third cue. */
export const tones = ["ok", "info", "warn", "crit", "neutral"] as const;
export type Tone = (typeof tones)[number];

/* ───────────────────── contrast contract (§8 table, verbatim) ───────────────────── */

/**
 * Every row of the §8 table, in document order (two rows are repeats in the doc and are
 * kept so the table can be diffed against it line by line).
 * `needs` is the WCAG 2.1 AA threshold the doc claims; `documented` is the printed ratio.
 */
export const contrastPairs: ReadonlyArray<{
  fg: ColorToken;
  bg: ColorToken;
  documented: number;
  needs: 3 | 4.5;
}> = [
  { fg: "ink", bg: "bg", documented: 17.06, needs: 4.5 },
  { fg: "ink", bg: "surface", documented: 17.85, needs: 4.5 },
  { fg: "ink-muted", bg: "surface", documented: 7.58, needs: 4.5 },
  { fg: "ink-muted", bg: "bg", documented: 7.24, needs: 4.5 },
  { fg: "border-strong", bg: "surface", documented: 4.76, needs: 3 },
  { fg: "brand", bg: "surface", documented: 6.7, needs: 4.5 },
  { fg: "surface", bg: "brand", documented: 6.7, needs: 4.5 },
  { fg: "focus", bg: "surface", documented: 6.7, needs: 3 },
  { fg: "focus", bg: "bg", documented: 6.41, needs: 3 },
  { fg: "ok-fg", bg: "ok-bg", documented: 6.49, needs: 4.5 },
  { fg: "info-fg", bg: "info-bg", documented: 7.15, needs: 4.5 },
  { fg: "warn-fg", bg: "warn-bg", documented: 6.38, needs: 4.5 },
  { fg: "crit-fg", bg: "crit-bg", documented: 6.8, needs: 4.5 },
  { fg: "neutral-fg", bg: "neutral-bg", documented: 8.4, needs: 4.5 },
  { fg: "demo-fg", bg: "demo-bg", documented: 7.1, needs: 4.5 },
  { fg: "ok-fg", bg: "surface", documented: 7.13, needs: 4.5 },
  { fg: "warn-fg", bg: "surface", documented: 6.85, needs: 4.5 },
  { fg: "crit-fg", bg: "surface", documented: 8.31, needs: 4.5 },
  { fg: "src-sim", bg: "surface", documented: 7.1, needs: 4.5 },
  { fg: "src-sim", bg: "bg", documented: 6.79, needs: 4.5 },
  { fg: "ink-muted", bg: "surface", documented: 7.58, needs: 4.5 },
  { fg: "ink", bg: "surface", documented: 17.85, needs: 4.5 },
  { fg: "border-strong", bg: "bg", documented: 4.55, needs: 3 },
  { fg: "map-truck-ok", bg: "surface", documented: 5.02, needs: 3 },
  { fg: "map-truck-stale", bg: "surface", documented: 4.92, needs: 3 },
  { fg: "map-truck-crit", bg: "surface", documented: 6.47, needs: 3 },
];

/** WCAG 2.1 relative luminance of a `#RRGGBB` string. */
export function relativeLuminance(hex: string): number {
  const h = hex.replace("#", "");
  const channel = (offset: number) => {
    const srgb = parseInt(h.slice(offset, offset + 2), 16) / 255;
    return srgb <= 0.03928 ? srgb / 12.92 : Math.pow((srgb + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
}

/** WCAG 2.1 contrast ratio between two `#RRGGBB` strings. */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/* ───────────────────────────── type scale (§2) ───────────────────────────── */

/** 12/14/16/20/24/32. Body 14 on the console, 18 on the ramp iPad. 12 only for icon chips. */
export const fontSize = {
  "12": "12px",
  "14": "14px",
  "16": "16px",
  "20": "20px",
  "24": "24px",
  "32": "32px",
} as const;

export const fontWeight = { regular: "400", medium: "500", semibold: "600" } as const;

export const lineHeight = { tight: "1.25", normal: "1.45" } as const;

export const bodySize = { console: fontSize["14"], ramp: "18px" } as const;

/* ───────────────────────────── spacing (§9: 8 px between targets) ───────────────────────────── */

export const space = {
  "0": "0px",
  "1": "2px",
  "2": "4px",
  "3": "8px",
  "4": "12px",
  "5": "16px",
  "6": "24px",
  "7": "32px",
  "8": "48px",
} as const;

export const radius = { sm: "4px", md: "6px", pill: "999px" } as const;

/* ───────────────────────────── layout (§2, §7, §7.1, §9) ───────────────────────────── */

export const layout = {
  /** ≥1280: left rail 232 px with labels (§2). */
  railWide: "232px",
  /** 768–1279: icon rail, labels on hover/focus. Width is not fixed by §2; 64 px keeps a 44 px target plus 8 px gutters. */
  railIcon: "64px",
  /** <768: hamburger drawer. */
  drawerWidth: "288px",
  /** DEMO banner: 32 px full-width bar above everything (§7). */
  demoBannerHeight: "32px",
  /** Source-mode badge: 20 px high, 24 px on the ramp iPad (§7.1). */
  sourceBadgeHeight: "20px",
  sourceBadgeHeightRamp: "24px",
  headerHeight: "64px",
  contentMaxWidth: "1440px",
} as const;

/** Breakpoints (§2). Exported for documentation; media queries live in CSS. */
export const breakpoint = { drawer: "768px", rail: "1280px" } as const;

/** Minimum hit targets: ≥44 px console, ≥56 px ramp iPad (§9). */
export const target = { console: "44px", ramp: "56px" } as const;

/** Focus: 2 px focus outline + 2 px offset, never removed (§9). */
export const focusRing = { width: "2px", offset: "2px" } as const;

export const border = { hairline: "1px" } as const;

/** Icon metrics. Lucide, single set, 1.75 stroke (§2). */
export const icon = {
  strokeWidth: 1.75,
  chip: 14,
  inline: 16,
  nav: 20,
  banner: 18,
} as const;

/* ───────────────────────────── CSS custom properties ───────────────────────────── */

const cssVars: Record<string, string> = {
  ...Object.fromEntries(Object.entries(color).map(([k, v]) => [`--color-${k}`, v])),
  ...Object.fromEntries(Object.entries(fontSize).map(([k, v]) => [`--text-${k}`, v])),
  ...Object.fromEntries(Object.entries(fontWeight).map(([k, v]) => [`--weight-${k}`, v])),
  ...Object.fromEntries(Object.entries(lineHeight).map(([k, v]) => [`--leading-${k}`, v])),
  ...Object.fromEntries(Object.entries(space).map(([k, v]) => [`--space-${k}`, v])),
  ...Object.fromEntries(Object.entries(radius).map(([k, v]) => [`--radius-${k}`, v])),
  ...Object.fromEntries(Object.entries(layout).map(([k, v]) => [`--layout-${kebab(k)}`, v])),
  ...Object.fromEntries(Object.entries(target).map(([k, v]) => [`--target-${k}`, v])),
  "--body-console": bodySize.console,
  "--body-ramp": bodySize.ramp,
  "--focus-width": focusRing.width,
  "--focus-offset": focusRing.offset,
  "--border-hairline": border.hairline,
  "--icon-stroke": String(icon.strokeWidth),
};

function kebab(s: string): string {
  return s.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
}

/** The `:root` block that carries every token into CSS. Rendered once, in the root layout. */
export function tokenCss(): string {
  const body = Object.entries(cssVars)
    .map(([k, v]) => `${k}:${v}`)
    .join(";");
  return `:root{${body}}`;
}

/** Tone → `{ fg, bg }` custom-property pair, for chips built in CSS. */
export function toneVars(tone: Tone): { fg: string; bg: string } {
  return { fg: `var(--color-${tone}-fg)`, bg: `var(--color-${tone}-bg)` };
}
