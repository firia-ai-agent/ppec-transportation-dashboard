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
 * (see src/app/layout.tsx), never by importing `color` into a component. The one exception is
 * src/components/map/style.ts: a MapLibre style is JSON, not CSS, so it cannot resolve
 * `var(--color-*)` and must import the literals from here.
 */

/* ───────────────────────────── colour (§8) ───────────────────────────── */

/**
 * ANSWERED, 2026-10-17 6:14 PM ET (Vera, founder-approved): the brand palette **is** being
 * adopted — Teal `#0F766E` primary, Teal Ink `#134E4A` for headings, the tint `#E6F2F1` for a
 * selected thing, Coral `#E8735A` for alert accents, and violet still only on DEMO/Simulated.
 *
 * The four are added below rather than written over `brand`, `info-*` and the rest: the rebuilt
 * screens (Plan routes §1, Ramp iPad §2) read them, and recolouring `brand` itself would restyle
 * every screen this PR did not rebuild. The frame PR (Rework 1) owns the sweep of tokens.ts;
 * when it lands, `brand` becomes teal and these aliases collapse into it.
 */
export const color = {
  ink: "#0F172A",
  "ink-muted": "#475569",
  bg: "#F8FAFC",
  surface: "#FFFFFF",
  "border-strong": "#64748B",
  brand: "#1D4ED8",
  focus: "#1D4ED8",

  /**
   * The brand palette (Vera, 2026-10-17 6:14 PM ET, founder-approved), read by the rebuilt
   * Plan routes and Ramp iPad.
   *
   *  - `teal` is the primary: a primary button's fill, a selected tab's fill, the meter bar and
   *    the dashed outline a van gets while it can take the child being dragged.
   *  - `teal-ink` is a heading and the text on the tint.
   *  - `teal-tint` is "this one is selected" — a fill, never the only cue (§0's rule 2).
   *  - `coral` is an **alert accent only**: the rule down a won't-fit banner, the edge of a
   *    column that is refusing a drop, the ring on an over count. It is 2.99:1 on white, which
   *    is under even the 3:1 UI floor, so it is never text, never a chip's fill behind text and
   *    never the only cue — the word, the icon and the crit tone beside it carry the meaning,
   *    and this is the decoration that makes them findable. That is why it has no contrast row:
   *    there is no pair it is required to pass, because nothing is read off it.
   */
  teal: "#0F766E",
  "teal-ink": "#134E4A",
  "teal-tint": "#E6F2F1",
  coral: "#E8735A",

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

  /**
   * An unavailable control (§4.2's disabled "Confirm handoff" and the "Override with reason"
   * beside it). These exist because the five tones do not have an "inert" among them: the
   * drawer's disabled override was being drawn in `ink-muted` on `surface` inside a
   * `border-strong` box — 7.58:1 text in a crisp outline, which is what an *enabled* secondary
   * button looks like. A control that cannot be used has to look like one before it is clicked,
   * so it loses the surface, drops to 4.34:1, and takes a hairline that reads as switched off.
   *
   * 4.34:1 is deliberate and it is the floor, not a miss: WCAG 2.1 exempts an inactive component
   * from 1.4.3 and 1.4.11 altogether, and a disabled button nobody can read is no kinder than
   * one nobody can tell is disabled — the reason it is disabled is beside it in full-contrast
   * text either way (§4.2, §9). The border is the one part that is allowed to be faint, because
   * the exemption is exactly what it is for.
   */
  "disabled-fg": "#64748B",
  "disabled-bg": "#F1F5F9",
  "disabled-border": "#CBD5E1",

  /**
   * Violet is reserved for demo/simulated only (D-5) so it never reads as a status colour. The
   * reservation is spent on three things and no others: the §7 DEMO bar, the §7.1 Simulated
   * chip, and a control that exists only to steer the demo (src/ui/DemoControls) — which wears
   * the bar's fill so a coordinator reads it as part of the demo rather than as one of the day's
   * decisions. The pair is used both ways round there: white on violet for the control's text,
   * violet on white for the option it is currently set to.
   */
  "demo-fg": "#FFFFFF",
  "demo-bg": "#6D28D9",
  "src-sim": "#6D28D9",

  // Map markers are checked against white because every marker carries a white halo (§8 note).
  "map-truck-ok": "#15803D",
  "map-truck-stale": "#A16207",
  "map-truck-crit": "#B91C1C",

  /**
   * The route palette: one colour per van, so three vans' lines on one map are told apart.
   *
   * Three because the demo day has three lanes, and the first of them is `brand` — the one route
   * colour the map already had (src/components/map/style.ts `MAP_TOKENS.route`) — so these are
   * its second and third and there is no fourth copy of blue. Blue, bluish-green and vermillion
   * is the colour-vision-deficient-safe trio, and it is still never the only cue: every line on
   * the plan map carries the van's own name along it (§3, `planRoutes.mapVanRow`).
   *
   * Not a status colour between them: green, amber and red are the truck tones above and the
   * five chip tones, and violet is the demo's. A van is not a state.
   */
  /**
   * Van 2's route colour (Vera, 2026-10-17 6:14 PM ET). It replaces `map-route-2`, which was the
   * same teal the palette now spends on "primary" — and a van is not an action. One van has one
   * colour everywhere: the swatch on its board column, the number on its rider cards and its
   * line on the map all read this through the shared van config (src/config/vans.ts). White
   * text on it — the stop number a rider card carries — is 5.02:1.
   */
  "route-2": "#B45309",
  "map-route-3": "#9A3412",

  /**
   * The two positron basemap fills we name (§5.1, §8): `osm-bg` is positron's land, kept as-is
   * and reused as the map pane's placeholder so it never flashes white; `osm-water` is our
   * override (positron's default `#C2C8CA` fails 3:1 against the ok/stale truck tones).
   * They live here because tokens.ts is the only file allowed to hold a hex, and
   * src/components/map/style.ts reads them from here rather than repeating them.
   */
  "osm-bg": "#F2F3F0",
  "osm-water": "#D9E2E7",
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
  // Not a §8 row: an inactive control, which WCAG 2.1 exempts. Held to the 3:1 UI floor anyway.
  { fg: "disabled-fg", bg: "disabled-bg", documented: 4.34, needs: 3 },
  { fg: "demo-fg", bg: "demo-bg", documented: 7.1, needs: 4.5 },
  // Not a §8 row either: the demo control's chosen option inverts the bar's pair (DemoControls).
  { fg: "demo-bg", bg: "demo-fg", documented: 7.1, needs: 4.5 },
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
  // Not §8 rows: the second and third route lines, held to the 3:1 UI floor on the white the
  // basemap's lightest fill is, and to 4.5:1 besides, because the stop number a line's own
  // circle carries is `surface` text sitting on it.
  { fg: "map-route-3", bg: "surface", documented: 7.31, needs: 3 },
  // The brand palette (6:14 PM ET). Teal is text and a button fill both ways round; the tint is
  // only ever behind Teal Ink; Van 2's route carries a white stop number.
  { fg: "teal", bg: "surface", documented: 5.47, needs: 4.5 },
  { fg: "teal", bg: "bg", documented: 5.23, needs: 4.5 },
  { fg: "surface", bg: "teal", documented: 5.47, needs: 4.5 },
  { fg: "teal-ink", bg: "surface", documented: 9.48, needs: 4.5 },
  { fg: "teal-ink", bg: "teal-tint", documented: 8.27, needs: 4.5 },
  { fg: "route-2", bg: "surface", documented: 5.02, needs: 3 },
  { fg: "surface", bg: "route-2", documented: 5.02, needs: 4.5 },
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
  /** DEMO banner: 32 px full-width bar above everything (§7). */
  demoBannerHeight: "32px",
  /** Source-mode badge: 20 px high, 24 px on the ramp iPad (§7.1). */
  sourceBadgeHeight: "20px",
  sourceBadgeHeightRamp: "24px",
  headerHeight: "64px",
  /**
   * <768: the bottom tab bar (Firia's final ruling, 2026-10-17 3:08 PM ET). 64 px carries a 20
   * px icon over a 12 px label and is well over the §9 44 px target; the device's own safe-area
   * inset is added under it rather than taken out of it, so the tabs never sit in the iPhone's
   * home-bar gesture area. The shell pads the page by the same two lengths.
   */
  tabBarHeight: "64px",
  contentMaxWidth: "1440px",
} as const;

/**
 * Breakpoints (§2). Exported for documentation; media queries live in CSS.
 *
 * §2's "<768: hamburger drawer" used to carry a 288 px width here. The drawer is anchored to the
 * header and spans the viewport now (src/ui/MobileNav.module.css says why), so there is no
 * drawer width left to tokenise and a token nothing reads is drift.
 */
export const breakpoint = { drawer: "768px", rail: "1280px" } as const;

/** Minimum hit targets: ≥44 px console, ≥56 px ramp iPad (§9). */
export const target = { console: "44px", ramp: "56px" } as const;

/** Focus: 2 px focus outline + 2 px offset, never removed (§9). */
export const focusRing = { width: "2px", offset: "2px" } as const;

/**
 * `hairline` is every rule and box edge; `current` is the one thicker bar that marks the page
 * you are on in the phone tab bar (§9: never colour alone).
 */
export const border = { hairline: "1px", current: "3px" } as const;

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
  ...Object.fromEntries(Object.entries(border).map(([k, v]) => [`--border-${kebab(k)}`, v])),
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
