import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { liveMap } from "@/ui/copy";
import { target } from "@/ui/tokens";

/**
 * The map pane's screen contracts from Vera's review: the zoom buttons are a real target, the
 * attribution is pinned inside the pane where a narrow window cannot clip it, and the chosen
 * clock speed is filled rather than outlined.
 *
 * These are CSS and markup rules, and vitest has no browser to apply them in, so they are read
 * from the source here and *measured* in e2e/screens.spec.ts, which takes the real bounding
 * boxes at 1024 and 1280.
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
 * THE CLOCK IS THE DEMO BAR'S (Firia, 2026-10-17 8:36 PM ET; audit §3 and §4 item 5: "delete
 * the helper lines, links and clock row" from the live map).
 *
 * So the three things this file used to check about the clock row are checked where the clock is
 * now (src/ui/demo-clock.test.ts and src/ui/shell.test.ts), and what is checked here is that the
 * map has no clock of its own left: no interval, no play state, no buttons — it reads the one
 * store, which is what keeps the vans moving to the time the bar is showing.
 */
describe("the map owns no clock", () => {
  const source = read(HERE, "LiveFleetMap.tsx");

  it("reads the shared store instead of running its own interval", () => {
    expect(source).toMatch(/useDemoClock\(\)/);
    expect(source).not.toMatch(/setInterval|useSimClock|setPlaying|setSpeed\(/);
  });

  it("draws no clock row: no readout, no controls, no motion note", () => {
    expect(source).not.toMatch(/liveMap\.(?:clock|pause|play|speed|restart|motion)/);
    expect(source).not.toMatch(/aria-pressed/);
    expect(source).not.toMatch(/<button/);
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
