import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { target } from "@/ui/tokens";

/**
 * The map pane's screen contracts from Vera's review: the zoom buttons are a real target, the
 * attribution is pinned inside the pane where a narrow window cannot clip it, and the map owns
 * no clock of its own.
 *
 * These are CSS and markup rules, and vitest has no browser to apply them in, so they are read
 * from the source here and *measured* in e2e/live-map.spec.ts, which takes the real bounding
 * boxes at 390 and 1440.
 *
 * **They moved with the pane.** They used to read `src/components/map/{FleetMap,LiveFleetMap}.tsx`
 * and `fleet-map.module.css` — #53's debug screen, which the founder's redesign replaces and
 * which is deleted. The contracts are not #53's, though: they are the app's, so they point at
 * the pane that exists now (src/modules/live-map/) rather than going with the files. A rule that
 * is dropped because the file it was written against was replaced is a rule nobody repealed.
 */
const PANE = path.resolve(__dirname, "..", "..", "modules", "live-map");

function read(...parts: string[]): string {
  return readFileSync(path.join(...parts), "utf8");
}

describe("§9: the zoom buttons are a real target", () => {
  const css = read(PANE, "live-map.module.css");

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

describe("ADR-008 / §5.1: the attribution is never clipped and never covered", () => {
  const css = read(PANE, "live-map.module.css");

  it("is pinned to the pane's own bottom-right rather than left to flow", () => {
    const rule = css.slice(css.indexOf(".maplibregl-ctrl-bottom-right"));
    expect(rule).toMatch(/position: absolute/);
    expect(rule).toMatch(/right: 0/);
    expect(rule).toMatch(/bottom: 0/);
  });

  /*
   * Above everything this screen floats over the map — the legend, the "No routes yet" card and
   * the tile notice — because "never removed" is worth nothing if something is drawn on top of
   * it. Each of the three is named, so a fourth overlay added later has to think about this.
   */
  it("sits above everything the screen floats over the map", () => {
    const attribZ = Number(
      /\.maplibregl-ctrl-bottom-right\) \{[^}]*z-index: (\d+)/s.exec(css)?.[1],
    );
    expect(attribZ).toBeGreaterThan(0);
    for (const overlay of ["legend", "locked", "tileNotice"]) {
      const z = Number(new RegExp(`\\.${overlay} \\{[^}]*z-index: (\\d+)`, "s").exec(css)?.[1] ?? 0);
      expect(attribZ, `the attribution must sit above .${overlay}`).toBeGreaterThan(z);
    }
  });

  it("wraps inside the pane instead of running past its edge", () => {
    expect(css).toMatch(/\.maplibregl-ctrl-attrib\) \{[^}]*max-width: 100%/s);
    expect(css).toMatch(/\.maplibregl-ctrl-attrib\) \{[^}]*white-space: normal/s);
  });

  it("is still mounted by the component, never removed", () => {
    expect(read(PANE, "LiveMapPane.tsx")).toMatch(/new AttributionControl\(/);
  });

  /*
   * And it is COLLAPSED, which is the founder's own drawing (png/live-map.png has no licence
   * strip across the bottom of the map) and is only compatible with "never removed" because the
   * text stays in the page behind an (i). MapLibre ships the control open; the pane closes it.
   */
  it("collapses behind the (i) rather than writing a strip across the map", () => {
    const source = read(PANE, "LiveMapPane.tsx");
    expect(source).toMatch(/compact: true/);
    expect(source).toMatch(/classList\.remove\("maplibregl-compact-show"\)/);
  });
});

/**
 * THE CLOCK IS THE DEMO BAR'S (Firia, 2026-10-17 8:36 PM ET; audit §3 and §4 item 5: "delete
 * the helper lines, links and clock row" from the live map).
 *
 * So what is checked here is that the map has no clock of its own: no interval, no play state,
 * no buttons — it reads the one store, which is what keeps the vans moving to the time the bar
 * is showing. The bar's own clock is checked in src/ui/demo-clock.test.ts.
 */
describe("the map owns no clock", () => {
  const screen = read(PANE, "LiveMapScreen.tsx");

  it("reads the shared store instead of running its own interval", () => {
    expect(screen).toMatch(/useDemoClock\(\)/);
    expect(screen).not.toMatch(/setInterval|useSimClock|setPlaying|setSpeed\(/);
  });

  it("draws no clock row: no readout, no controls, no speed", () => {
    expect(screen).not.toMatch(/liveMap\.(?:clock|clockLabel|pause|play|speed|restart)\b/);
  });

  /*
   * And the pane itself draws no control of its own either. #53's pane carried a "Fit all
   * vehicles" button over the map; the founder's screen has the list beside it instead, and the
   * only buttons on the map are MapLibre's own zoom pair and the credits (i).
   */
  it("floats no button of its own over the map", () => {
    const pane = read(PANE, "LiveMapPane.tsx");
    const buttons = pane.match(/<button/g) ?? [];
    // One, and it is the tile-failure retry — which is only in the DOM when the tiles failed.
    expect(buttons).toHaveLength(1);
    expect(pane).toMatch(/fleetMap\.retry/);
  });
});
