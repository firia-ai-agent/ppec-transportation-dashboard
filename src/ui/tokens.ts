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
 * There is no blue left in the CHROME under src/ — not in the tones, not on a button, not on a
 * rail — which is the whole of the change: a screen that is teal except for one blue chip reads
 * as two products. `info` moved to the teal-ink family for that reason.
 *
 * **Blue is van identity and nothing else** (Firia, 2026-10-17 11:25 PM ET): Van 1's colour is
 * #1D4ED8, and it lives in {@link VAN_COLORS} below, which is the only group under src/ a blue
 * may appear in. tokens.test.ts holds both halves of that rule — blue only inside VAN_COLORS,
 * and no chrome token blue — so the ban on a blue *chrome* is enforced rather than remembered.
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
  /**
   * The canvas behind white cards (Firia, 2026-10-17 8:36 PM ET: "page background #F8FAFC with
   * WHITE cards"). A second page colour, and deliberately only where there are cards to separate:
   * `bg` stays pure white for every screen that is one sheet, and this is what a screen made of
   * cards sits on, so a card edge is readable without a heavier border. Both of its pairs are
   * computed below.
   */
  canvas: "#F8FAFC",
  /**
   * The grey an incoming message bubble is, from the mockup's iMessage thread
   * (mockups/family-texts.html, `.in`). It is not `neutral-bg` and should not be: `neutral-bg`
   * is the fill of a state chip, and a bubble that wore it would read as a status. This is the
   * only place it is used, and it carries `ink` (14.72:1).
   */
  "bubble-in-bg": "#E9E9EB",
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
   * reservation is spent on two things and no others: the §7 DEMO bar — with the controls that
   * ride *inside* it, the reset and the scenario clock — and the §7.1 Simulated chip. No screen
   * may spend it: the violet banner Plan routes carried is deleted (#74), so a control that
   * steers the demo is either in the bar or in the screen's own clothes. The pair is used both
   * ways round inside the bar: white on violet for a control's text, violet on white for the
   * option it is currently set to.
   */
  "demo-fg": "#FFFFFF",
  "demo-bg": "#6D28D9",
  "src-sim": "#6D28D9",

  // Map markers are checked against white because every marker carries a white halo (§8 note).
  "map-truck-ok": "#15803D",
  "map-truck-stale": "#A16207",
  "map-truck-crit": "#B91C1C",

  /*
   * `map-route-2` and `map-route-3` are gone. They were this table's own three-van palette —
   * brand teal, amber, vermillion — and the app now has exactly one (see {@link VAN_COLORS}):
   * the Live map, the Plan routes board and the ramp board all draw a van in the same colour,
   * which is the point of a van having a colour at all. Firia, 2026-10-17 11:25 PM ET.
   */

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

/**
 * THE VAN PALETTE — one colour per van, and the one group under src/ a blue may appear in.
 *
 * Firia's final ruling, 2026-10-17 11:25 PM ET (it replaces every earlier colour note): Van 1 is
 * #1D4ED8, Van 2 #B45309, Van 3 #BE185D. One group, shared by every screen that draws a van —
 * the Live map's route lines, map pins and legend, the van square in its list, and the Plan
 * routes board's lanes and legend — so the van a coordinator reads as blue on one screen is blue
 * on the next. That is the whole reason a van has a colour: it is the van's *identity*, not a
 * state and not decoration.
 *
 * It is deliberately NOT in `color` above. `color` is the chrome — the page, the rail, the tones
 * a chip wears — and the ban on blue chrome is still total: nothing in `color` is blue and
 * tokens.test.ts fails if anything becomes blue. Keeping the van palette in a group of its own
 * is what makes "blue is van identity only" a thing a test can state in one line.
 *
 * Three hues rather than three positions on one wheel: blue, amber and pink stay apart for a
 * colour-vision-deficient reader (red and green, the hardest pair, are not both in it), and
 * colour is never the only cue — the van's own name is beside its square, along its line
 * (§3, `planRoutes.mapVanRow`) and in the legend. A SELECTED van takes a border, never a fill: a fill would put a second
 * meaning on the one colour that means "this van".
 *
 * Every member is ≥4.5:1 on `surface` and on `bg` (see {@link vanContrastPairs}), because a van
 * marker carries a white numeral and a van square sits on a white card.
 */
export const VAN_COLORS = {
  van1: "#1D4ED8",
  van2: "#B45309",
  van3: "#BE185D",
} as const;

export type VanColorToken = keyof typeof VAN_COLORS;

/** The van palette in drive order, so the nth van of a day takes the nth colour. */
export const VAN_COLOR_LIST: readonly string[] = [
  VAN_COLORS.van1,
  VAN_COLORS.van2,
  VAN_COLORS.van3,
];

/**
 * The colour of the nth van. Wraps, so a fourth van is drawn rather than left black, and never
 * returns the demo violet.
 */
export function vanColor(index: number): string {
  const n = VAN_COLOR_LIST.length;
  return VAN_COLOR_LIST[((Math.trunc(index) % n) + n) % n];
}

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
  /*
   * The card canvas and the incoming bubble (Firia, 8:36 PM ET). Three rows: body text and muted
   * text on the canvas, and the bubble's own text — because those are the three things that are
   * ever read on them, and a background with no computed pair is a hex somebody liked.
   */
  { fg: "ink", bg: "canvas", documented: 17.06, needs: 4.5 },
  { fg: "ink-muted", bg: "canvas", documented: 7.24, needs: 4.5 },
  { fg: "ink", bg: "bubble-in-bg", documented: 14.72, needs: 4.5 },
  { fg: "ok-fg", bg: "ok-bg", documented: 6.49, needs: 4.5 },
  { fg: "info-fg", bg: "info-bg", documented: 6.73, needs: 4.5 },
  { fg: "warn-fg", bg: "warn-bg", documented: 6.38, needs: 4.5 },
  { fg: "crit-fg", bg: "crit-bg", documented: 6.8, needs: 4.5 },
  { fg: "neutral-fg", bg: "neutral-bg", documented: 8.4, needs: 4.5 },
  // Not a §8 row: an inactive control, which WCAG 2.1 exempts. Held to the 3:1 UI floor anyway.
  { fg: "disabled-fg", bg: "disabled-bg", documented: 4.34, needs: 3 },
  { fg: "demo-fg", bg: "demo-bg", documented: 7.1, needs: 4.5 },
  // Not a §8 row either: a bar control's chosen option inverts the bar's pair (DemoClock).
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
];

/**
 * The van palette's own contrast rows, against both page surfaces.
 *
 * Not in {@link contrastPairs} because these are not `color` tokens: §8 is the chrome's table and
 * {@link VAN_COLORS} is deliberately outside it. They are held to **4.5:1** rather than the 3:1 a
 * UI part needs, because each of them carries a white numeral — the van's own number inside its
 * map pin — and a numeral is text.
 */
export const vanContrastPairs: ReadonlyArray<{
  van: VanColorToken;
  on: "surface" | "bg";
  documented: number;
  needs: 3 | 4.5;
}> = [
  { van: "van1", on: "surface", documented: 6.7, needs: 4.5 },
  { van: "van1", on: "bg", documented: 6.41, needs: 4.5 },
  { van: "van2", on: "surface", documented: 5.02, needs: 4.5 },
  { van: "van2", on: "bg", documented: 4.8, needs: 4.5 },
  { van: "van3", on: "surface", documented: 6.04, needs: 4.5 },
  { van: "van3", on: "bg", documented: 5.77, needs: 4.5 },
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

/**
 * IS THIS COLOUR BLUE? — the one definition, so "no blue chrome" is a test and not a taste.
 *
 * Firia's 11:25 PM ET ruling has two halves: blue appears only inside {@link VAN_COLORS}, and no
 * chrome token (or chrome colour a browser computes) is blue. Both halves need the same answer
 * to "is #334155 blue?", and a hex comparison cannot give it — the ban is on the *hue*, not on
 * three literals somebody might retype.
 *
 * So: hue in the blue arc, with enough saturation and lightness to actually read as a colour.
 *  - **hue 195–255** is blue proper. It stops short of 255 so the demo violet (#6D28D9, hue 263)
 *    is not caught: violet is reserved and is not what this rule is about.
 *  - **saturation ≥ 0.35** lets the slate family through — `neutral-fg` #334155 is hue 215 at
 *    0.25, and a slate is grey with a lean, not a blue. Van 1 is 0.76.
 *  - **lightness 0.2–0.85** lets `ink` #0F172A through at 0.11 (a near-black with a navy lean is
 *    the ink of the whole app) and the near-white page tints through at the top.
 *
 * Deliberately a classifier rather than a list: a token added next week is judged by the same
 * rule as one added today, which is the only kind of ban that survives a month.
 */
export function isBlue(hex: string): boolean {
  const h = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((o) => parseInt(h.slice(o, o + 2), 16) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  if (delta === 0) return false;
  const lightness = (max + min) / 2;
  const saturation = delta / (1 - Math.abs(2 * lightness - 1));
  let hue =
    max === r ? 60 * (((g - b) / delta) % 6) : max === g ? 60 * ((b - r) / delta + 2) : 60 * ((r - g) / delta + 4);
  if (hue < 0) hue += 360;
  return hue >= 195 && hue < 255 && saturation >= 0.35 && lightness >= 0.2 && lightness <= 0.85;
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

export const fontWeight = { regular: "400", medium: "500", semibold: "600", bold: "700" } as const;

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
export const radius = {
  sm: "4px",
  md: "6px",
  /** Family texts cards (mockups/family-texts.html): 10 px. */
  lg: "10px",
  /**
   * A chat bubble's corner (mockups/agent-bubble.html `.b{border-radius:18px}`). Bigger than
   * anything else in the system on purpose: it is the shape that says "somebody said this",
   * which is the whole of what tells a message apart from a card at a glance. One tail corner
   * drops back to `sm`, which is what points it at its speaker.
   */
  bubble: "18px",
  pill: "9999px",
} as const;

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
  /**
   * THE AGENT BUBBLE, measured off Vera's mockup (mockups/agent-bubble.html `.fab` / `.pnl`, and
   * png/agent-bubble-{closed,open}-{1440,390}.png). Five lengths, so nothing retypes one:
   *
   *  - `agentBubbleSize` 56 px, `agentBubbleGap` 16 px from the frame's bottom-right corner;
   *  - below 768 the button sits 16 px **above the tab bar**, which the stylesheet writes as the
   *    gap plus `tabBarHeight` plus the device's own safe-area inset (the mockup's flat
   *    `bottom:80px` is 64 + 16 with no inset to add, and a phone with a home bar needs it);
   *  - `agentBubbleClearWide` 88 px (16 + 56 + 16) and `agentBubbleClearPhone` 80 px (16 + 56 +
   *    8) are the bottom padding a page gets so its last row — and the live map's zoom
   *    controls — scroll clear of the disc. On a phone the clearance is *added to* the tab bar's
   *    own, which is the spec's 144 px (64 + 80) at 390.
   *  - `agentPanelWidth` 400 px: the panel at 1440, under the DEMO bar, with no overlay.
   */
  agentBubbleSize: "56px",
  agentBubbleGap: "16px",
  agentBubbleDot: "14px",
  agentBubbleClearWide: "88px",
  agentBubbleClearPhone: "80px",
  agentPanelWidth: "400px",
  contentMaxWidth: "1440px",
} as const;

/**
 * Breakpoints (§2). Exported for documentation; media queries live in CSS.
 *
 * §2's "<768: hamburger drawer" used to carry a 288 px width here. There is no drawer: below 768
 * the menu is the bottom tab bar (src/ui/TabBar.tsx), which spans the viewport and has no width
 * to tokenise. The breakpoint keeps its name because §2 and the stylesheets both use it.
 */
export const breakpoint = { drawer: "768px", rail: "1280px" } as const;

/** Minimum hit targets: ≥44 px console, ≥56 px ramp iPad (§9). */
export const target = { console: "44px", ramp: "56px" } as const;

/**
 * The two soft shadows the agent bubble needs, and the only ones in the system.
 *
 * Every other raised surface in this app is marked with a hairline ring (NoticeToast, StepStrip),
 * because a ring reads in greyscale and costs no paint. The bubble is the exception Vera's mockup
 * draws on purpose: a 56 px disc floating *over* a scrolling board has to be legible against
 * whatever is behind it, and a 1 px ring on white over white is not. The literals are the
 * mockup's (mockups/agent-bubble.html `.fab`, `.pnl`) and they live here because this is the one
 * file a colour may be written in — `no-hex.test.ts` bans `rgba(` everywhere else, and that ban
 * is what stops a second, slightly different shadow appearing in a component next week.
 */
export const shadow = {
  /** `.fab`: the closed disc, lifted off the page under it. */
  bubble: "0 6px 16px rgba(15,23,42,.22)",
  /** `.pnl`: the 400 px panel, lifted off the screen to its left. */
  panel: "-12px 0 32px rgba(15,23,42,.12)",
} as const;

/**
 * A PAGE'S OWN STICKY BOTTOM ACTION BAR, as one length the frame can read.
 *
 * Some screens pin a single action to the floor rather than leaving it at the end of the page —
 * the ramp iPad's Confirm below 768 (src/app/ramp-ipad/arrival/arrival.module.css `.confirmBar`,
 * `position: fixed` above the tab bar) is the first, and it will not be the last. Anything else
 * the *frame* floats at the bottom then has to move up by that bar's height, or it lands on it.
 *
 * `--sticky-action-bar-height` is the contract, and it is deliberately not a list of pages: the
 * default here is **0**, every frame rule that floats something at the bottom adds
 * `var(--sticky-action-bar-height, 0px)` to its offset, and a page that pins a bar sets the
 * property on the document root for as long as it is the page. The frame therefore knows nothing
 * about the ramp iPad, the ramp iPad knows nothing about the agent bubble, and the next screen
 * with a pinned Confirm gets the clearance by declaring its own height rather than by somebody
 * remembering to add a second special case to AgentBubble.module.css.
 *
 * It lives here, with the other frame metrics, because the default is a length and
 * src/ui/tokens.ts is the file lengths are written in.
 */
export const stickyActionBar = {
  /** No page pins anything: every page but the one, and every width above 767 on that one. */
  none: "0px",
} as const;

/** Focus: 2 px focus outline + 2 px offset, never removed (§9). */
export const focusRing = { width: "2px", offset: "2px" } as const;

/**
 * `hairline` is every rule and box edge; `current` is the one thicker bar that marks the page
 * you are on in the phone tab bar (§9: never colour alone). 2 px, which is what audit §2 item 6
 * measures off the mockup ("a 2px Teal #0F766E top border and Teal Ink label"); `ring` is the
 * 3 px halo around the step the day is on, which the mockup draws at 3 (`.step.cur`).
 */
export const border = { hairline: "1px", current: "3px", ring: "3px" } as const; // current: mockups/shell-flow.html:75 (inset 0 3px 0 var(--brand))

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
  /*
   * The van palette rides into CSS the same way the chrome does, as `--van-1` / `--van-2` /
   * `--van-3`, so the square beside a van's name and the swatch in the map legend are the same
   * literal as the line MapLibre draws — read from here, never retyped (no-hex.test.ts).
   */
  ...Object.fromEntries(
    VAN_COLOR_LIST.map((v, i) => [`--van-${i + 1}`, v]),
  ),
  ...Object.fromEntries(Object.entries(fontSize).map(([k, v]) => [`--text-${k}`, v])),
  ...Object.fromEntries(Object.entries(fontWeight).map(([k, v]) => [`--weight-${k}`, v])),
  ...Object.fromEntries(Object.entries(lineHeight).map(([k, v]) => [`--leading-${k}`, v])),
  ...Object.fromEntries(Object.entries(space).map(([k, v]) => [`--space-${k}`, v])),
  ...Object.fromEntries(Object.entries(radius).map(([k, v]) => [`--radius-${k}`, v])),
  ...Object.fromEntries(Object.entries(layout).map(([k, v]) => [`--layout-${kebab(k)}`, v])),
  ...Object.fromEntries(Object.entries(target).map(([k, v]) => [`--target-${k}`, v])),
  "--sticky-action-bar-height": stickyActionBar.none,
  "--body-console": bodySize.console,
  "--body-ramp": bodySize.ramp,
  "--focus-width": focusRing.width,
  "--focus-offset": focusRing.offset,
  ...Object.fromEntries(Object.entries(border).map(([k, v]) => [`--border-${kebab(k)}`, v])),
  ...Object.fromEntries(Object.entries(shadow).map(([k, v]) => [`--shadow-${k}`, v])),
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
