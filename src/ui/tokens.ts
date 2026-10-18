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
 * THE PALETTE, as the founder approved it on 2026-10-17 (6:19 PM ET).
 *
 * The brief named a Teal / Teal Ink / Coral palette and this table used to define none of it —
 * `brand` and `focus` were a blue nothing in the brief asked for, and the question
 * "is the brand palette being adopted, or is §8 the palette?" stood in this comment unanswered.
 * It is answered: the brand is Teal #0F766E, headings and the brand mark are Teal Ink #134E4A
 * (`ink-brand`), the tint behind the thing you are on is #E6F2F1 (`selected-bg`, always with
 * Teal Ink on it), coral #E8735A is for alerts and nothing else, and the page is pure white.
 *
 * There is no blue left anywhere under src/ — not in the tones, not on the map's route lines —
 * which is the whole of the change: a screen that is teal except for one blue chip reads as two
 * products. `info` moved to the teal-ink family for that reason, and the map's second van line
 * to the amber family (its third was already a vermillion); the trio is still told apart by a
 * colour-vision-deficient reader, and the van's own name is written along its line either way.
 */
export const color = {
  ink: "#0F172A",
  "ink-muted": "#475569",
  /**
   * Teal Ink: the headings and the brand mark (§2's h1, the product name in the shell). It is
   * the brand at reading weight — 9.47:1 on white, where the brand itself is 5.47:1 — so a
   * page title can be brand-coloured without being the one thing on the screen that is hardest
   * to read.
   */
  "ink-brand": "#134E4A",
  /**
   * THE PAGE, and it is not white (Firia's ruling, 2026-10-17 8:36 PM ET, over the audit's
   * "keep white"): #F8FAFC behind everything, with white *cards* on it — which is what the
   * founder's mockups draw (mockups/shell-flow.html sets `--bg:#F8FAFC`, `--surface:#FFFFFF`)
   * and what the rail, the page header bar and every card are read against. One off-white, one
   * white, and the difference between them is what makes a card a card.
   *
   * Every §8 pair that was computed against white is recomputed against this below: the
   * weakest of them is `border-strong` at 4.55:1, which is still over the 3:1 a UI part needs.
   */
  bg: "#F8FAFC",
  surface: "#FFFFFF",
  "border-strong": "#64748B",
  brand: "#0F766E",
  focus: "#0F766E",
  /**
   * The thing you are on: the current rail item, the current tab, the option a segmented
   * control is set to. Always carrying `ink-brand`, never `brand` and never `ink` — the pair is
   * 8.27:1 and is the one tint in the app that means "this one", so it is never decoration.
   */
  "selected-bg": "#E6F2F1",
  /**
   * Coral, for alerts and for nothing else (the founder's palette, 6:19 PM ET). It is a fill
   * with `ink` on it (5.97:1), never text and never a border on its own: at 2.99:1 against
   * white it would be a mark nobody is sure they saw.
   *
   * TODO(data-model): the alert it is for is the count of things waiting on a person — the
   * Family texts badge in the mockup — and that count is read from the day's readiness, which
   * docs/DATA-MODEL.md has not signed. Nothing paints it until then: an alert colour on an
   * invented number is worse than no alert colour.
   */
  alert: "#E8735A",

  "ok-fg": "#166534",
  "ok-bg": "#DCFCE7",
  /*
   * `info` is the teal-ink family now, not a blue. Three of the five tones were already
   * unmistakable (green, amber, red); the fourth was the one colour on a teal screen that
   * belonged to another palette. It is still never the only cue — §3 gives every state an icon
   * and a word — and it is darker and cooler than `ok`, which is the tone next to it.
   */
  "info-fg": "#115E59",
  "info-bg": "#CCFBF1",
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
   * its second and third. Teal, amber and vermillion: three hues a colour-vision-deficient
   * reader still separates (the pair that is hardest for them, red and green, is not in it), and
   * colour is never the only cue anyway — every line on the plan map carries the van's own name
   * along it (§3, `planRoutes.mapVanRow`).
   *
   * A van is not a state, and the second line is now in the amber family the stale-GPS truck
   * tone also lives in — so the two are kept apart by what carries them rather than by hue: a
   * route colour is only ever a *line* and the numbered circle on it, and a truck tone is only
   * ever the *marker* for a van, which carries its freshness in words beside it (§3, §5). Violet
   * is the demo's and is on neither.
   */
  "map-route-2": "#B45309",
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
  { fg: "brand", bg: "surface", documented: 5.47, needs: 4.5 },
  { fg: "surface", bg: "brand", documented: 5.47, needs: 4.5 },
  { fg: "focus", bg: "surface", documented: 5.47, needs: 3 },
  { fg: "focus", bg: "bg", documented: 5.23, needs: 3 },
  /*
   * The founder's palette, as three pairs rather than three hexes (6:19 PM ET). Teal Ink is a
   * heading on the page and a heading on the tint behind the thing you are on; the brand itself
   * is checked on that tint too, because the current rail item carries its icon.
   */
  { fg: "ink-brand", bg: "surface", documented: 9.48, needs: 4.5 },
  { fg: "ink-brand", bg: "selected-bg", documented: 8.27, needs: 4.5 },
  { fg: "brand", bg: "selected-bg", documented: 4.78, needs: 4.5 },
  /*
   * Coral is a fill with `ink` on it and never text of its own (see the token). The pair is
   * written down here so that a future alert badge is built from a row that has been computed,
   * rather than from a hex someone liked the look of.
   */
  { fg: "ink", bg: "alert", documented: 5.98, needs: 4.5 },
  { fg: "ok-fg", bg: "ok-bg", documented: 6.49, needs: 4.5 },
  { fg: "info-fg", bg: "info-bg", documented: 6.73, needs: 4.5 },
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
  { fg: "map-route-2", bg: "surface", documented: 5.02, needs: 3 },
  { fg: "map-route-3", bg: "surface", documented: 7.31, needs: 3 },
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

/**
 * 11/12/14/16/20/24/32. Body 14 on the console, 18 on the ramp iPad. 12 only for icon chips.
 *
 * 11 is the one step below §2's scale and it exists for exactly one thing: the one pill
 * (`Pill.module.css`), whose metrics the audit fixes at `font: 600 11px/1` so that a status
 * chip is the same height everywhere and cannot wrap — which is the founder's overlap bug
 * (prod-ef4bfb3-audit §4.1). Nothing else may read it: a sentence at 11 px is a sentence
 * nobody reads, and §2's floor of 12 stands for every other word on the screen.
 */
export const fontSize = {
  "11": "11px",
  "12": "12px",
  "14": "14px",
  "16": "16px",
  "20": "20px",
  "24": "24px",
  "32": "32px",
} as const;

export const fontWeight = { regular: "400", medium: "500", semibold: "600" } as const;

/**
 * `one` is the pill's own leading, and the audit's words: `font: 600 11px/1`. A chip is one
 * line by construction (it may never wrap), so its box is its text — which is what makes 22 px
 * the same 22 px in every cell of the board.
 */
export const lineHeight = { tight: "1.25", normal: "1.45", one: "1" } as const;

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

/** `pill` is the audit's `border-radius: 9999px` (§4.1), in the one place a radius may live. */
export const radius = { sm: "4px", md: "6px", pill: "9999px" } as const;

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
  /**
   * The page header bar: 64 px inside the content column, carrying that screen's title and,
   * below 768, the account's own disc at its trailing end (audit §2 items 1 and 5,
   * png/shell-flow-390.png). It is not a full-width app header — there is none any more.
   */
  headerHeight: "64px",
  /**
   * A rail row: 40 px, with a 2 px gap between rows (audit §2 item 2, measured off the mockup —
   * production drew them at 42 and the mockup at 30). It is under §9's 44 px console target and
   * that is the audit's own arithmetic: five rows at 44 plus 8 px gaps do not leave the account
   * block on the floor of a 900 px window. The row is still a full-width target with its label
   * inside it, and the phone's tab bar — the menu on the one device where a thumb is the
   * pointer — is 64 px.
   */
  railItem: "40px",
  /** The one pill (audit §4.1): 22 px high, everywhere a status chip appears. */
  pillHeight: "22px",
  /** A count badge on a menu item: a 20 px disc (audit §2 item 2, the mockup's Family texts). */
  badgeSize: "20px",
  /** The account's disc in the page header below 768 (audit §2 item 5). */
  avatarPhone: "36px",
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
 * you are on in the phone tab bar (§9: never colour alone). 2 px, which is what audit §2 item 6
 * measures off the mockup ("a 2px Teal #0F766E top border and Teal Ink label"); `ring` is the
 * 3 px halo around the step the day is on, which the mockup draws at 3 (`.step.cur`).
 */
export const border = { hairline: "1px", current: "2px", ring: "3px" } as const;

/** Icon metrics. Lucide, single set, 1.75 stroke (§2). */
export const icon = {
  strokeWidth: 1.75,
  chip: 14,
  /** Inside the one pill, whose box is 22 px: 14 px would set the height instead of the text. */
  pill: 12,
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
