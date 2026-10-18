import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { planRoutes } from "./copy";
import {
  color,
  contrastPairs,
  contrastRatio,
  focusRing,
  fontSize,
  layout,
  relativeLuminance,
  target,
  tokenCss,
  tones,
  space,
} from "./tokens";

const SRC_ROOT = path.resolve(__dirname, "..");

/** Every source file under src/, for the "one copy of the violet" check. */
function walkSrc(dir: string = SRC_ROOT): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return walkSrc(full);
    return /\.(?:ts|tsx|css)$/.test(full) && !/\.test\.tsx?$/.test(full) ? [full] : [];
  });
}

/**
 * DESIGN-DIRECTION §8 is a *claim* about contrast ("run it, don't trust this table").
 * This recomputes every row from the hexes in tokens.ts, so a token edit that breaks
 * WCAG 2.1 AA, or that drifts from the published ratio, fails the build.
 */
describe("§8 contrast", () => {
  it("covers every colour pair the doc lists, plus the palette, inactive-control, demo-control and route-line pairs", () => {
    expect(contrastPairs).toHaveLength(34);
  });

  it.each(contrastPairs)(
    "$fg on $bg meets $needs:1 and matches the documented $documented:1",
    ({ fg, bg, documented, needs }) => {
      const ratio = contrastRatio(color[fg], color[bg]);
      expect(ratio, `${fg} on ${bg} must meet WCAG ${needs}:1`).toBeGreaterThanOrEqual(needs);
      // The doc prints two decimals; allow only rounding slack, not drift.
      expect(Math.round(ratio * 100) / 100).toBeCloseTo(documented, 2);
    },
  );

  it("checks every tone's fg/bg pair as text contrast", () => {
    for (const tone of tones) {
      const ratio = contrastRatio(color[`${tone}-fg`], color[`${tone}-bg`]);
      expect(ratio, `${tone} chip`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("checks the demo bar and the focus ring", () => {
    expect(contrastRatio(color["demo-fg"], color["demo-bg"])).toBeGreaterThanOrEqual(4.5);
    // §9: the ring is a UI part, so 3:1, and it must hold on both page backgrounds.
    expect(contrastRatio(color.focus, color.surface)).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(color.focus, color.bg)).toBeGreaterThanOrEqual(3);
  });

  it("agrees with the WCAG reference values at the extremes", () => {
    expect(relativeLuminance("#FFFFFF")).toBeCloseTo(1, 6);
    expect(relativeLuminance("#000000")).toBeCloseTo(0, 6);
    expect(contrastRatio("#FFFFFF", "#000000")).toBeCloseTo(21, 6);
  });
});

describe("token shape", () => {
  /**
   * The route palette's comment cites the copy entry that keeps colour from being the only cue —
   * the van's own name, written along its line. It cited `planRoutes.mapVanLine`, which is not a
   * key copy.ts has: the entry it means is `mapVanRow` (Vera's review, 2026-10-17).
   *
   * So every `planRoutes.…` this file names is checked against the real table, comments
   * included. A citation nobody can follow is worse than no citation, and a renamed key is
   * exactly how one goes stale.
   */
  it("cites copy entries that exist, in its comments too", () => {
    const source = readFileSync(path.join(SRC_ROOT, "ui", "tokens.ts"), "utf8");
    const cited = [...source.matchAll(/planRoutes\.([A-Za-z]+)/g)].map((m) => m[1]);
    expect(cited).toContain("mapVanRow");
    expect(cited).not.toContain("mapVanLine");
    for (const key of cited) expect(planRoutes, key).toHaveProperty(key);
  });

  it("writes every colour as an uppercase #RRGGBB literal", () => {
    for (const [name, value] of Object.entries(color)) {
      expect(value, name).toMatch(/^#[0-9A-F]{6}$/);
    }
  });

  it("keeps the §8 token list complete", () => {
    expect(Object.keys(color).sort()).toEqual(
      [
        "alert",
        "bg",
        "border-strong",
        "brand",
        "crit-bg",
        "crit-fg",
        "demo-bg",
        "demo-fg",
        "disabled-bg",
        "disabled-border",
        "disabled-fg",
        "focus",
        "info-bg",
        "info-fg",
        "ink",
        "ink-brand",
        "ink-muted",
        "map-route-2",
        "map-route-3",
        "map-truck-crit",
        "map-truck-ok",
        "map-truck-stale",
        "neutral-bg",
        "neutral-fg",
        "osm-bg",
        "osm-water",
        "ok-bg",
        "ok-fg",
        "selected-bg",
        "src-sim",
        "surface",
        "warn-bg",
        "warn-fg",
      ].sort(),
    );
  });

/*
   * §2's scale, plus the one step below it: 11 px, which exists for the one pill and for nothing
   * else (audit §4.1 fixes its text at `600 11px/1`). src/ui/pill.test.ts holds that no other
   * file reads `--text-11`, so the floor of 12 still stands for every word that is a sentence.
   */
  it("carries the §2 type scale 12/14/16/20/24/32, and 11 for the one pill", () => {
    expect(Object.keys(fontSize)).toEqual(["11", "12", "14", "16", "20", "24", "32"]);
    expect(Object.values(fontSize)).toEqual([
      "11px",
      "12px",
      "14px",
      "16px",
      "20px",
      "24px",
      "32px",
    ]);
  });

  it("uses an 8 px-derived spacing scale", () => {
    expect(Object.values(space)).toEqual([
      "0px",
      "2px",
      "4px",
      "8px",
      "12px",
      "16px",
      "24px",
      "32px",
      "48px",
    ]);
  });

  it("holds the §2/§7/§9 metrics: 232 px rail, 32 px banner, 44/56 targets, 2+2 focus ring", () => {
    expect(layout.railWide).toBe("232px");
    expect(layout.demoBannerHeight).toBe("32px");
    expect(layout.sourceBadgeHeight).toBe("20px");
    expect(layout.sourceBadgeHeightRamp).toBe("24px");
    expect(target.console).toBe("44px");
    expect(target.ramp).toBe("56px");
    expect(focusRing).toEqual({ width: "2px", offset: "2px" });
  });

  it("is the only file that holds the demo violet, and every screen reads it from here", () => {
    /*
     * D-10 / §3: #6D28D9 is reserved for the DEMO bar, the Simulated badge and a demo-only
     * control, and it is on-spec on all three. What must not happen is a second copy of it: a
     * hex pasted into a component drifts the moment this table is corrected, and then the bar
     * and the chip are two different violets. no-hex.test.ts bars every hex outside this file;
     * this names the one that matters and checks the surfaces that use it take it from the token.
     */
    const VIOLET = "#6D28D9";
    expect(color["demo-bg"]).toBe(VIOLET);
    expect(color["src-sim"]).toBe(VIOLET);
    expect(tokenCss()).toContain(`--color-demo-bg:${VIOLET}`);
    expect(tokenCss()).toContain(`--color-src-sim:${VIOLET}`);

    const UI = __dirname;
    const read = (f: string) => readFileSync(path.join(UI, f), "utf8");
    // The bar's fill and the chip's text, both as custom properties.
    expect(read("DemoBanner.module.css")).toMatch(/background: var\(--color-demo-bg\)/);
    // The source chip is the one pill with a §7.1 token on it (src/ui/Pill.module.css).
    expect(read("Pill.module.css")).toMatch(
      /\.pill\[data-token="src-sim"\] \{[^}]*color: var\(--color-src-sim\)/,
    );
    // And the demo control, which is the bar's own pair — one way round for its text, the
    // other for the option it is set to (Vera's review, 2026-10-17).
    const control = read("DemoControls.module.css");
    expect(control).toMatch(/\.bar \{[^}]*background: var\(--color-demo-bg\)/);
    expect(control).toMatch(/\.bar \{[^}]*color: var\(--color-demo-fg\)/);
    const pressed = /\.button\[aria-pressed="true"\] \{[^}]*\}/.exec(control)?.[0] ?? "";
    expect(pressed).toMatch(/background: var\(--color-demo-fg\)/);
    expect(pressed).toMatch(/color: var\(--color-demo-bg\)/);
    // §9: a ring that would be a smudge on the violet is not a ring. It is the bar's own ink.
    expect(control).toMatch(
      /\.button:focus-visible \{[^}]*outline: var\(--focus-width\) solid var\(--color-demo-fg\)/,
    );
    // The screen's one action colour never reaches a demo control: this is not a decision.
    expect(control).not.toMatch(/--color-brand/);
    // Neither carries the literal, nor does anything else under src/ but this file.
    const offenders = walkSrc().filter(
      (f) => f !== path.join(SRC_ROOT, "ui", "tokens.ts") && readFileSync(f, "utf8").includes(VIOLET),
    );
    expect(offenders.map((f) => path.relative(SRC_ROOT, f))).toEqual([]);
  });

  /**
   * §4.2 asks for one primary action and says the reason it is unavailable goes beside it in
   * text. It did not say the button has to *look* unavailable, and the drawer's "Override with
   * reason" was proof that it needs saying: `ink-muted` text in a `border-strong` box on
   * `surface` is 7.58:1 inside a crisp outline, which is exactly what an enabled secondary
   * button looks like. These are the tokens that make the difference visible before a click.
   */
  describe("an unavailable control looks unavailable", () => {
    it("is weaker than every tone a usable chip or button takes", () => {
      const disabled = contrastRatio(color["disabled-fg"], color["disabled-bg"]);
      expect(disabled).toBeGreaterThanOrEqual(3);
      for (const tone of tones) {
        expect(
          contrastRatio(color[`${tone}-fg`], color[`${tone}-bg`]),
          `a disabled control must read weaker than the ${tone} tone`,
        ).toBeGreaterThan(disabled);
      }
      // And weaker than the one it replaces: ink-muted on the surface it used to sit on.
      expect(contrastRatio(color["ink-muted"], color.surface)).toBeGreaterThan(disabled);
    });

    it("has a hairline that reads as switched off, not as an outline", () => {
      // WCAG 2.1 exempts an inactive component from 1.4.11, which is what this is for: a border
      // that still met 3:1 would draw the eye to a control nobody can use.
      const inert = contrastRatio(color["disabled-border"], color["disabled-bg"]);
      expect(inert).toBeLessThan(contrastRatio(color["border-strong"], color.surface));
      expect(inert).toBeLessThan(3);
    });

    it("is what the drawer's two unavailable buttons actually read", () => {
      // Both of them, from the stylesheet: a rule that only dressed one of the pair would leave
      // the override looking like the live control on the screen (§4.2).
      const css = readFileSync(
        path.join(SRC_ROOT, "app", "(app)", "today", "today.module.css"),
        "utf8",
      );
      for (const rule of [".primary:disabled", ".secondary:disabled"]) {
        const block = new RegExp(`\\${rule} \\{[^}]*\\}`).exec(css)?.[0] ?? "";
        expect(block, rule).toMatch(/background: var\(--color-disabled-bg\)/);
        expect(block, rule).toMatch(/color: var\(--color-disabled-fg\)/);
        expect(block, rule).toMatch(/--color-disabled-border/);
        expect(block, rule).toMatch(/cursor: not-allowed/);
      }
      // The brand colour is the one action a surface can take, so a dead button never wears it.
      expect(/\.primary:disabled \{[^}]*\}/.exec(css)?.[0]).not.toMatch(/--color-brand/);
    });
  });

  it("reserves the demo violet for demo and simulation only", () => {
    expect(color["src-sim"]).toBe(color["demo-bg"]);
    for (const [name, value] of Object.entries(color)) {
      if (name === "src-sim" || name === "demo-bg") continue;
      expect(value, `${name} must not reuse the demo violet (D-5)`).not.toBe(color["demo-bg"]);
    }
  });

  /**
   * D-5, as a rule about *screens* rather than about the palette: the violet appears on the
   * DEMO bar, the Simulated source chip and a control that is itself part of the demo, and on
   * nothing else. The test above keeps a second violet out of the token table; this keeps the
   * one violet off a fourth element, which is the way the reservation actually gets spent —
   * four header pills in the src-sim tone beside a bar that already says "DEMO" and a chip that
   * already says "Simulated", and the colour stops meaning "this is the demo" and starts
   * meaning nothing.
   *
   * The bar's own control joined on the founder's redesign (REDESIGN-SPEC §0): the demo's reset
   * lives in the bar now, so it is inside the reservation by position as well as by rule.
   *
   * The demo control joined the list on Vera's review, 2026-10-17, and it is the one addition
   * that *spends* the reservation on its own terms rather than borrowing it: the Plan routes
   * scenario toggle is not a coordinator's control, so it is painted as the demo it steers. It
   * is shared chrome in src/ui for that reason — a screen cannot opt itself in.
   *
   * Read from the stylesheets on purpose: nothing can paint itself violet without naming one
   * of these three custom properties, and the map's own copy of the token (style.ts, which is
   * JSON and cannot read a custom property) is held to the same rule by style.test.ts.
   */
  it("spends that reservation on the bar, its two controls, the chip and a demo control", () => {
    const VIOLET_VARS = /--color-(?:demo-bg|demo-fg|src-sim)\b/;
    const allowed = new Set([
      path.join(SRC_ROOT, "ui", "DemoBanner.module.css"),
      // The one control *in* the bar — "Restart demo day" — which wears the bar's own pair
      // rather than the screen's action colour, for the same reason the demo control below
      // does (REDESIGN-SPEC §0, and src/ui/DemoRestart.module.css says it in full).
      path.join(SRC_ROOT, "ui", "DemoRestart.module.css"),
      /*
       * The bar's other control, as of Firia's 8:36 PM ET ruling: the scenario clock moved out
       * of the live map and into the bar, so it wears the bar's pair for the same reason the
       * reset does (src/ui/DemoClock.module.css).
       */
      path.join(SRC_ROOT, "ui", "DemoClock.module.css"),
      // The §7.1 chip, which is the one pill with a violet token on it.
      path.join(SRC_ROOT, "ui", "Pill.module.css"),
      path.join(SRC_ROOT, "ui", "DemoControls.module.css"),
    ]);
    const stylesheets = walkSrc().filter((f) => f.endsWith(".css") && !allowed.has(f));
    expect(stylesheets.length).toBeGreaterThan(10);
    const offenders = stylesheets.filter((f) =>
      VIOLET_VARS.test(readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "")),
    );
    expect(offenders.map((f) => path.relative(SRC_ROOT, f))).toEqual([]);
  });
});

describe("tokenCss", () => {
  const css = tokenCss();

  it("emits one custom property per colour token", () => {
    for (const [name, value] of Object.entries(color)) {
      expect(css).toContain(`--color-${name}:${value}`);
    }
  });

  it("emits the layout, target and focus metrics", () => {
    expect(css).toContain("--layout-rail-wide:232px");
    expect(css).toContain("--layout-demo-banner-height:32px");
    expect(css).toContain("--target-console:44px");
    expect(css).toContain("--target-ramp:56px");
    expect(css).toContain("--focus-width:2px");
    expect(css).toContain("--icon-stroke:1.75");
  });

  it("is a single :root block", () => {
    expect(css.startsWith(":root{")).toBe(true);
    expect(css.endsWith("}")).toBe(true);
    expect(css.split("{")).toHaveLength(2);
  });
});
