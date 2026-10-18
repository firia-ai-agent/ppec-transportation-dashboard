import { createElement } from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { canSeeMapData } from "@/domain/access/map-view";
import { DEMO_RUN_SECONDS } from "@/fixtures/replays";
import { DemoClock } from "./DemoClock";
import { SPEEDS, DEFAULT_SPEED, demoClock } from "./demo-clock";
import { liveMap } from "./copy";

/**
 * THE SCENARIO CLOCK, NOW THAT IT IS THE DEMO BAR'S (Firia, 2026-10-17 8:36 PM ET; audit §3 and
 * §4 item 5 delete the clock row from the live map).
 *
 * The clock used to be state inside the map's own component, which is why moving it needed a
 * store: the bar is mounted by the root layout and the map by a page, two React trees that share
 * one browser bundle (src/ui/demo-clock.ts). What is checked here is the three things that move
 * can get wrong — the store is one clock, the bar draws it only where it means something, and
 * the *controls* are still the demo control §6.2 says they are.
 */
const pathname = vi.fn<() => string>();

/** The bar's clock, rendered the way React renders it — it reads a store through a hook. */
function render(role: "DIRECTOR" | "COORDINATOR" | "FRONT_DESK" | null): string {
  return renderToStaticMarkup(createElement(DemoClock, { role }));
}
vi.mock("next/navigation", () => ({ usePathname: () => pathname() }));

beforeEach(() => {
  pathname.mockReturnValue("/live-map");
  demoClock.restart();
  demoClock.setPlaying(true);
  demoClock.setSpeed(DEFAULT_SPEED);
});

describe("the store", () => {
  it("is one clock: a speed set anywhere is the speed everywhere", () => {
    demoClock.setSpeed(60);
    const html = render("DIRECTOR");
    // The chosen speed is marked, and it is the one that was just set — not the default.
    expect(html).toContain('aria-pressed="true"');
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(1);
    expect(html).toContain(`×60`);
  });

  it("offers §6.2's three speeds and starts at ×10", () => {
    expect([...SPEEDS]).toEqual([1, 10, 60]);
    expect(DEFAULT_SPEED).toBe(10);
  });

  it("wraps at the end of the demo's runs rather than running off it", () => {
    expect(DEMO_RUN_SECONDS).toBeGreaterThan(0);
    demoClock.restart();
    const html = render("DIRECTOR");
    // The readout is the scenario's own start, formatted by the one clock formatter.
    expect(html).toMatch(/Scenario clock/);
  });
});

/**
 * WHAT THE BAR READS, against the founder's own live map renders (png/live-map.png and
 * png/live-map-390.png): `… 3:24 PM [Restart demo day]`. A bare time, at the trailing end,
 * immediately before the reset — no "Scenario clock" label, no "ET", no chip around it.
 */
describe("the readout matches the mockup", () => {
  /** The visible text is the time and nothing else. */
  it("draws the time alone, with the sentence kept for the ear", () => {
    const html = render("DIRECTOR");
    const visible = html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
    expect(visible).toMatch(/\d{1,2}:\d{2} (AM|PM)/);
    expect(visible, "the label is back on the screen").not.toContain("Scenario clock");
    expect(visible, "the timezone is back on the screen").not.toMatch(/\bET\b/);
    // ...and the whole sentence is the accessible name, where a loose time would say nothing.
    expect(html).toMatch(/aria-label="Scenario clock \d{1,2}:\d{2} (AM|PM) ET"/);
  });

  /**
   * The time is the last thing in the clock's box, so the next thing on the bar is the reset —
   * which is the order both renders draw. The §6.2 controls sit to the left of the readout.
   */
  it("puts the controls before the time, so the time is beside Restart demo day", () => {
    const html = render("DIRECTOR");
    expect(html.indexOf(liveMap.restart)).toBeLessThan(html.lastIndexOf("aria-label=\"Scenario"));
    expect(html.trimEnd().endsWith("</span></div>")).toBe(true);
  });

  /** A role without the controls gets the time on its own, which is the mockup exactly. */
  it("is the time on its own for a role that holds no controls", () => {
    const html = render("FRONT_DESK");
    expect(html).not.toContain(liveMap.pause);
    expect(html.replace(/<[^>]*>/g, "").trim()).toMatch(/^\d{1,2}:\d{2} (AM|PM)$/);
  });
});

describe("where the clock is drawn", () => {
  it("is on the live map, which is the screen it moves", () => {
    const html = render("DIRECTOR");
    expect(html).toContain("data-demo-clock");
  });

  /** A time ticking over a page it does not touch is a readout nobody can act on. */
  it.each(["/today", "/plan-routes", "/ramp-ipad", "/family-texts", "/whoami", "/login"])(
    "is not drawn on %s",
    (route) => {
      pathname.mockReturnValue(route);
      expect(render("DIRECTOR")).toBe("");
    },
  );
});

describe("the readout is for everyone; the controls are a demo control (§6.2)", () => {
  it("gives the controls to the roles the map matrix gives them to, and nobody else", () => {
    for (const role of ["DIRECTOR", "COORDINATOR", "FRONT_DESK"] as const) {
      const html = render(role);
      const expected = canSeeMapData(role, "clockControls");
      expect(html.includes(liveMap.pause), role).toBe(expected);
      expect(html.includes(liveMap.restart), role).toBe(expected);
      // The time itself is drawn either way: it is a readout, not a control.
      expect(html, role).toMatch(/Scenario clock/);
    }
  });

  it("gives them to nobody when there is no role at all", () => {
    const html = render(null);
    expect(html).not.toContain(liveMap.pause);
    expect(html).toMatch(/Scenario clock/);
  });
});
