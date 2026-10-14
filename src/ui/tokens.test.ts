import { describe, expect, it } from "vitest";
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

/**
 * DESIGN-DIRECTION §8 is a *claim* about contrast ("run it, don't trust this table").
 * This recomputes every row from the hexes in tokens.ts, so a token edit that breaks
 * WCAG 2.1 AA, or that drifts from the published ratio, fails the build.
 */
describe("§8 contrast", () => {
  it("covers every colour pair the doc lists", () => {
    expect(contrastPairs).toHaveLength(26);
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
  it("writes every colour as an uppercase #RRGGBB literal", () => {
    for (const [name, value] of Object.entries(color)) {
      expect(value, name).toMatch(/^#[0-9A-F]{6}$/);
    }
  });

  it("keeps the §8 token list complete", () => {
    expect(Object.keys(color).sort()).toEqual(
      [
        "bg",
        "border-strong",
        "brand",
        "crit-bg",
        "crit-fg",
        "demo-bg",
        "demo-fg",
        "focus",
        "info-bg",
        "info-fg",
        "ink",
        "ink-muted",
        "map-truck-crit",
        "map-truck-ok",
        "map-truck-stale",
        "neutral-bg",
        "neutral-fg",
        "osm-bg",
        "osm-water",
        "ok-bg",
        "ok-fg",
        "src-sim",
        "surface",
        "warn-bg",
        "warn-fg",
      ].sort(),
    );
  });

  it("carries the §2 type scale 12/14/16/20/24/32", () => {
    expect(Object.keys(fontSize)).toEqual(["12", "14", "16", "20", "24", "32"]);
    expect(Object.values(fontSize)).toEqual(["12px", "14px", "16px", "20px", "24px", "32px"]);
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

  it("reserves the demo violet for demo and simulation only", () => {
    expect(color["src-sim"]).toBe(color["demo-bg"]);
    for (const [name, value] of Object.entries(color)) {
      if (name === "src-sim" || name === "demo-bg") continue;
      expect(value, `${name} must not reuse the demo violet (D-5)`).not.toBe(color["demo-bg"]);
    }
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
