import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { liveMap } from "@/ui/copy";
import { target } from "@/ui/tokens";

/**
 * The map pane's screen contracts from Vera's reviews: the zoom buttons are a real target, the
 * attribution is pinned inside the pane where a narrow window cannot clip it, and the clock
 * controls are one named demo control whose buttons — and the screen's two links — are targets
 * a thumb can hit.
 *
 * These are CSS and markup rules, and vitest has no browser to apply them in, so they are read
 * from the source here and *measured* in the browser: e2e/screens.spec.ts takes the real
 * bounding boxes at 1024 and 1280, and e2e/live-map.spec.ts takes them at 390.
 */
const HERE = __dirname;

function read(...parts: string[]): string {
  return readFileSync(path.join(...parts), "utf8");
}

describe("§9: the zoom buttons are a real target", () => {
  const css = read(HERE, "fleet-map.module.css");

  it("grows MapLibre's 29 px buttons to the console target", () => {
    expect(target.console).toBe("44px");
    expect(css).toMatch(
      /\.maplibregl-ctrl-group button\) \{[^}]*width: var\(--target-console\)[^}]*height: var\(--target-console\)/s,
    );
  });

  it("widens the group too, or the wider buttons would be cropped", () => {
    expect(css).toMatch(/\.maplibregl-ctrl-group\) \{[^}]*width: var\(--target-console\)/s);
  });
});

/**
 * The blank-map failure mode, as a rule rather than as a browser check that notices it later.
 *
 * MapLibre puts `.maplibregl-map` on the same div our own class is on, and its stylesheet sets
 * `position: relative` there. Two single-class selectors are equal specificity, so a bare
 * `.canvas { position: absolute }` wins or loses on the order the bundler happens to emit the
 * two stylesheets in — and when it loses, the div is a static block with absolutely positioned
 * children, collapses to zero height, and the pane shows a map nobody can see.
 */
describe("the map fills the pane whatever order the stylesheets land in", () => {
  const css = read(HERE, "fleet-map.module.css");

  it("positions the canvas with a rule a vendor class cannot outrank", () => {
    expect(css).toMatch(/\.canvasWrap > \.canvas \{[^}]*position: absolute;[^}]*inset: 0;/s);
    // Not the bare one-class form, which `.maplibregl-map` ties with.
    expect(css).not.toMatch(/^\.canvas \{/m);
  });
});

describe("ADR-008 / §5.1: the attribution is never clipped and never covered", () => {
  const css = read(HERE, "fleet-map.module.css");

  it("is pinned to the pane's own bottom-right rather than left to flow", () => {
    const rule = css.slice(css.indexOf(".maplibregl-ctrl-bottom-right"));
    expect(rule).toMatch(/position: absolute/);
    expect(rule).toMatch(/right: 0/);
    expect(rule).toMatch(/bottom: 0/);
  });

  it("sits above the pane's own overlay", () => {
    const attribZ = Number(
      /\.maplibregl-ctrl-bottom-right\) \{[^}]*z-index: (\d+)/s.exec(css)?.[1],
    );
    const overlayZ = Number(/\.overlay \{[^}]*z-index: (\d+)/s.exec(css)?.[1]);
    expect(attribZ).toBeGreaterThan(overlayZ);
  });

  it("wraps inside the pane instead of running past its edge", () => {
    expect(css).toMatch(/\.maplibregl-ctrl-attrib\) \{[^}]*max-width: 100%/s);
    expect(css).toMatch(/\.maplibregl-ctrl-attrib\) \{[^}]*white-space: normal/s);
  });

  it("is still mounted by the component, never removed", () => {
    expect(read(HERE, "FleetMap.tsx")).toMatch(/new AttributionControl\(/);
  });
});

/**
 * Vera's prod walk item 4 / Veri S3: the five clock buttons are one named demo control.
 *
 * They were this file's own outlined buttons — pause, ×1, ×10, ×60, restart — loose in the row
 * beside the clock readout, with the running speed filled in the *screen's* brand pair and no
 * name on the group at all. Two things were wrong with that at once: a control that only steers
 * the demo was wearing the clothes a coordinator's own decisions wear (D-5), and a reviewer
 * reading five unlabelled buttons has to guess which clock they move.
 *
 * So the group is the shared demo control now (src/ui/DemoControls), which is also where the
 * fill, the check mark and the §9 target live — asserted below where they are, not copied here.
 */
describe("the clock controls are one labelled demo control", () => {
  const source = read(HERE, "LiveFleetMap.tsx");
  const control = read(HERE, "..", "..", "ui", "DemoControls.tsx");
  const controlCss = read(HERE, "..", "..", "ui", "DemoControls.module.css");

  it("renders them in the DEMO bar's styling rather than the screen's own", () => {
    expect(source).toMatch(/import \{ DemoControls \} from "@\/ui\/DemoControls"/);
    expect(source).toMatch(/<DemoControls[\s\S]{0,200}legend=\{liveMap\.demoSpeedLegend\}/);
    // No second copy of the buttons: the brand-filled pair this file used to paint is gone.
    expect(source).not.toMatch(/const pressed: React\.CSSProperties/);
    expect(source).not.toMatch(/--color-brand/);
  });

  it("names the group on screen and to a screen reader, in one string", () => {
    expect(liveMap.demoSpeedLegend).toBe("Demo speed");
    // The visible label and the group's accessible name are the same element (§9).
    expect(control).toMatch(/<p id=\{legendId\} className=\{styles\.legend\}/);
    expect(control).toMatch(/role="group" aria-labelledby=\{legendId\}/);
  });

  it("holds all five in that one group: the three speeds, pause and restart", () => {
    expect(source).toMatch(/options=\{SPEEDS\.map\(/);
    expect(source).toMatch(/label: fill\(liveMap\.speed, \{ factor \}\)/);
    expect(source).toMatch(/label: playing \? liveMap\.pause : liveMap\.play/);
    expect(source).toMatch(/label: liveMap\.restart/);
    // Pause and restart choose nothing, so they carry no pressed state; the speed does.
    expect(control).toMatch(/aria-pressed=\{option\.value === value\}/);
  });

  it("still fills the running speed and marks it with a check, never colour alone (§3)", () => {
    expect(control).toMatch(/option\.value === value \? <Check size=\{icon\.inline\}/);
    expect(controlCss).toMatch(
      /\.button\[aria-pressed="true"\] \{[^}]*background: var\(--color-demo-fg\)/s,
    );
    // An outline in a brand tone is the shape of the §9 focus ring; a fill is not.
    expect(controlCss).not.toMatch(/box-shadow/);
  });

  it("§9: every button in it is a 44 px target in both directions", () => {
    expect(target.console).toBe("44px");
    const rule = /\.button \{[^}]*\}/s.exec(controlCss)?.[0] ?? "";
    expect(rule).toMatch(/min-height: var\(--target-console\)/);
    // "×1" is two characters: padding alone leaves a target a thumb misses at phone width.
    expect(rule).toMatch(/min-width: var\(--target-console\)/);
  });
});

/**
 * The other half of the same item: the two links out of this screen.
 *
 * They are the only way to reach the sibling surfaces behind this door, and an inline anchor's
 * box is its line of text — so at 390 px they were a 20 px target. Measured in the browser by
 * e2e/live-map.spec.ts; this is the rule that makes the measurement pass.
 */
describe("§9: the live map's two links are targets, not lines of text", () => {
  const page = read(HERE, "..", "..", "app", "live-map", "page.tsx");

  it("lays both out at the console target", () => {
    expect(page).toMatch(
      /const screenLink: React\.CSSProperties = \{[^}]*minHeight: "var\(--target-console\)"/s,
    );
    expect(page).toMatch(
      /const screenLink: React\.CSSProperties = \{[^}]*minWidth: "var\(--target-console\)"/s,
    );
    for (const href of ["/ramp-ipad", "/plan-routes"]) {
      expect(page, href).toMatch(new RegExp(`href="${href}" style=\\{screenLink\\}`));
    }
  });
});

describe("a fault row names a run in words", () => {
  const source = read(HERE, "LiveFleetMap.tsx");

  it("builds the name from the fixture's first stop, not from a table of ids", () => {
    expect(source).toMatch(/function routeLabelOf\(route: Route\): string/);
    expect(source).toMatch(/fill\(liveMap\.routeName, \{ stop: route\.stops\[0\]\?\.name \?\? "" \}\)/);
  });

  it("prints that name, and no reference, in the row", () => {
    expect(source).toMatch(/route: run\.routeLabel/);
    expect(source).not.toMatch(/route: run\.result\.spec\.route\.id/);
    expect(source).not.toMatch(/provenance/);
    expect(liveMap.faultRow).not.toMatch(/\{provenance\}/);
  });
});
