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

describe("the running clock speed is filled, not outlined", () => {
  const source = read(HERE, "LiveFleetMap.tsx");

  it("uses the §8 brand pair that passes AA, and says so to a screen reader", () => {
    expect(source).toMatch(/const pressed: React\.CSSProperties = \{[^}]*background: "var\(--color-brand\)"/s);
    expect(source).toMatch(/const pressed: React\.CSSProperties = \{[^}]*color: "var\(--color-surface\)"/s);
    expect(source).toMatch(/aria-pressed=\{speed === option\}/);
  });

  it("carries a check mark too, so the state is never colour alone (§3)", () => {
    expect(source).toMatch(/\{speed === option \? <Check size=\{icon\.inline\} aria-hidden="true" \/> : null\}/);
  });

  it("no longer marks the choice with an outline, which reads as a focus ring", () => {
    const pressedRule = source.slice(
      source.indexOf("const pressed: React.CSSProperties"),
      source.indexOf("const meta: React.CSSProperties"),
    );
    expect(pressedRule).not.toMatch(/boxShadow/);
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

/**
 * VERA'S WORDING ON THE PANE, 2026-10-17 — the half the copy test cannot see.
 *
 * src/ui/copy.test.ts pins the strings; what a string is *filled with* is decided here, in the
 * markup, and that is where the two code leaks were. The faults section named a van "V4" two
 * lines above a sentence about the same van, and the held-back count was interpolated into the
 * middle of the intro paragraph, which is why the paragraph had to carry a number at all.
 */
describe("the pane names a van and counts a held-back text the way the copy says", () => {
  const source = read(HERE, "LiveFleetMap.tsx");

  it("names every van by its name, through the one helper, and never by its code", () => {
    expect(source).toMatch(/function vanNameOf\(vehicleId: string\): string/);
    expect(source).toMatch(/vanTitle\(VEHICLE_META\.get\(vehicleId\)\?\.description \?\? ""\)/);
    // Both sentences in the faults section: the row, and the van with no marker at all.
    expect(source.match(/vehicle: vanNameOf\(run\.result\.spec\.route\.vehicleId\)/g)).toHaveLength(2);
    expect(source).not.toMatch(/vehicle: run\.result\.spec\.route\.vehicleId/);
  });

  /**
   * The notification rows, which were still printing "V1" two sections below a sentence calling
   * the same van "The convertible van" (Vera's prod walk, 2026-10-17 2:48 PM ET).
   *
   * A decision only exists once the scenario clock has moved, so there is no server render that
   * reaches one: the row is built by `decisionRowText`, which src/ui/no-codes.test.ts calls with
   * the replay's own decisions. What is read here is the other half — that the component uses it
   * rather than interpolating the id itself again.
   */
  it("builds a notification row through the one exported helper, not out of the vehicle id", () => {
    expect(source).toMatch(
      /export function decisionRowText\(vehicleId: string, decision: NotificationDecision\): string/,
    );
    expect(source).toMatch(/vehicle: vanNameOf\(vehicleId\)/);
    expect(source).toMatch(/\{decisionRowText\(vehicleId, decision\)\}/);
    // The leak itself: the row filled the copy string with the key the fixtures join a run on.
    expect(source).not.toMatch(/vehicle: vehicleId/);
  });

  it("asks for no second count on the unbound line, because the copy says one", () => {
    expect(source).not.toMatch(/accepted:/);
    expect(liveMap.unbound).not.toMatch(/\{accepted\}/);
  });

  it("puts the held-back count on its own line, not inside the intro sentence", () => {
    expect(source).toMatch(/\{liveMap\.decisionsIntro\}/);
    expect(source).not.toMatch(/fill\(liveMap\.decisionsIntro/);
    expect(source).toMatch(/liveMap\.heldBack : liveMap\.heldBackPlural/);
    expect(source).toMatch(/\{heldBackText\}/);
  });
});
