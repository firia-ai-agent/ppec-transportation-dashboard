import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { adapters, login, nav, scenarioClock, unbuilt } from "./copy";
import { Placeholder } from "./Placeholder";
import { ScenarioClock } from "./ScenarioClock";
import { SourceBadge } from "./SourceBadge";
import { color } from "./tokens";

/**
 * Shell contracts from Vera's review.
 *
 * The server components are rendered for real with `renderToStaticMarkup`. The rules that live
 * in CSS, and the client components that need a router (NavRail, MobileNav), are asserted by
 * reading the source instead: there is no DOM or browser here (vitest runs in node, no jsdom),
 * so a source assertion proves the rule is written, not that the browser applies it. §10's
 * persona walk is still the thing that proves the latter.
 */
const UI = __dirname;
const APP = path.resolve(UI, "..", "app");

function read(...parts: string[]): string {
  return readFileSync(path.join(...parts), "utf8");
}

/** React escapes `'` in text nodes, so a copy string has to be escaped to be found in markup. */
function escapeApostrophes(text: string): string {
  return text.replace(/'/g, "&#x27;");
}

describe("NFR-09: the source-mode badge is on every screen", () => {
  const rootLayout = read(APP, "layout.tsx");

  it("the root layout renders it, so /login and the developer pages carry it too", () => {
    expect(rootLayout).toMatch(/<ScreenSource \/>/);
    expect(rootLayout).toMatch(/<DemoBanner \/>/);
  });

  it("ScreenSource reads the mode from the environment rather than taking a prop", () => {
    const source = read(UI, "ScreenSource.tsx");
    expect(source).toMatch(/uiSourceMode\(\)/);
    expect(source).toMatch(/<SourceBadge mode=\{uiSourceMode\(\)\} \/>/);
  });

  it("is rendered exactly once per screen: only ScreenSource mounts a SourceBadge", () => {
    const mounts = [
      ...[read(UI, "AppShell.tsx"), read(APP, "layout.tsx"), read(APP, "login", "page.tsx")],
    ].flatMap((source) => [...source.matchAll(/<SourceBadge\b/g)].map((m) => m[0]));
    expect(mounts).toEqual([]);
  });

  it("the badge announces its mode and shows the label (§7.1)", () => {
    const html = renderToStaticMarkup(SourceBadge({ mode: "SIMULATED" }));
    expect(html).toContain("Source: Simulated");
    expect(html).toContain("Simulated");
  });
});

describe("§2 icon rail, 768–1279", () => {
  const rail = read(UI, "NavRail.module.css");
  const component = read(UI, "NavRail.tsx");

  it("keeps a 64 px footprint and expands the panel over the content", () => {
    expect(rail).toMatch(/@media \(max-width: 1279px\)/);
    expect(rail).toMatch(/width: var\(--layout-rail-icon\)/);
    expect(rail).toMatch(/width: var\(--layout-rail-wide\)/);
  });

  it("expands on hover and on focus-within, so the labels are keyboard-reachable", () => {
    expect(rail).toMatch(/\.rail:focus-within \.panel/);
    expect(rail).toMatch(/\.rail:hover \.panel/);
    expect(rail).toMatch(/\.rail:focus-within \.label/);
  });

  it("respects reduced motion", () => {
    expect(rail).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
  });

  it("gives every link both an aria-label and a tooltip carrying the page name", () => {
    expect(component).toMatch(/aria-label=\{item\.label\}/);
    expect(component).toMatch(/title=\{item\.label\}/);
  });
});

describe("§2 scenario clock", () => {
  const component = read(UI, "ScenarioClock.tsx");
  const css = read(UI, "ScenarioClock.module.css");

  it("reads 'Demo not started' and offers Start beside it", () => {
    expect(scenarioClock.notStarted).toBe("Demo not started");
    expect(scenarioClock.start).toBe("Start");
  });

  it("says honestly why Start does nothing", () => {
    expect(scenarioClock.startUnavailable).toBe("Demo controls aren't connected yet.");
  });

  it("is aria-disabled and still focusable, so the reason can be read", () => {
    expect(component).toMatch(/aria-disabled="true"/);
    // A real `disabled` would drop the button out of the tab order and silence the note.
    expect(component).not.toMatch(/\sdisabled[=\s/>]/);
    expect(component).toMatch(/aria-describedby=\{TOOLTIP_ID\}/);
    expect(component).toMatch(/role="tooltip"/);
  });

  it("shows the note on hover and on focus", () => {
    expect(css).toMatch(/\.start:hover \+ \.tooltip/);
    expect(css).toMatch(/\.start:focus \+ \.tooltip/);
  });

  it("renders a focusable, inert Start whose note is tied to it", () => {
    const html = renderToStaticMarkup(ScenarioClock());
    expect(html).toContain(scenarioClock.notStarted);
    expect(html).toContain(scenarioClock.start);
    expect(html).toContain(escapeApostrophes(scenarioClock.startUnavailable));
    expect(html).toMatch(/aria-disabled="true"/);
    // Nothing removes it from the tab order: no `disabled`, no negative tabindex.
    expect(html).not.toMatch(/\sdisabled[=\s/>]/);
    expect(html).not.toMatch(/tabindex="-1"/i);
    const describedBy = /aria-describedby="([^"]+)"/.exec(html)?.[1];
    expect(describedBy).toBeTruthy();
    expect(html).toContain(`id="${describedBy}" role="tooltip"`);
  });
});

describe("copy from the review", () => {
  it("the login intro is exactly 'Demo accounts only.'", () => {
    expect(login.intro).toBe("Demo accounts only.");
  });

  it("an unbuilt page says so in its heading, in the page's own name", () => {
    expect(unbuilt.heading).toBe("{page} isn't built yet");
    for (const page of [nav.today, nav.exceptions, nav.setup, nav.health]) {
      expect(unbuilt.heading.replace("{page}", page)).toBe(`${page} isn't built yet`);
    }
  });

  it("every unbuilt page says what it will do, in one plain sentence", () => {
    expect(unbuilt.today).toBe(
      "The live board will show every ride, where each van is, and what needs attention.",
    );
    for (const body of [unbuilt.today, unbuilt.exceptions, unbuilt.setup, unbuilt.health]) {
      expect(body.endsWith("."), body).toBe(true);
      // One sentence: no full stop before the last character.
      expect(body.slice(0, -1).includes("."), body).toBe(false);
      expect(body.length).toBeLessThan(120);
    }
  });

  it("the header says plainly that no time on screen is real", () => {
    expect(adapters.interimNote).toBe("Times are simulated until the live board is connected.");
  });

  it("an unbuilt page renders that heading and that one sentence", () => {
    const html = renderToStaticMarkup(Placeholder({ page: nav.health, body: unbuilt.health }));
    expect(html).toContain(escapeApostrophes("Health &amp; ROI isn't built yet"));
    expect(html).toContain(unbuilt.tag);
    expect(html).toContain(escapeApostrophes(unbuilt.health));
    expect(html).not.toMatch(/\bB-\d+\b/);
  });
});

describe("§8 primary action token", () => {
  const css = read(APP, "login", "login.module.css");

  it("Sign in uses the brand token for its background and surface for its text", () => {
    const submit = css.slice(css.indexOf(".submit"));
    expect(submit).toMatch(/background: var\(--color-brand\)/);
    expect(submit).toMatch(/color: var\(--color-surface\)/);
  });

  it("that pair is the §8 row that passes AA (6.70:1)", () => {
    expect(color.brand).toBe("#1D4ED8");
    expect(color.surface).toBe("#FFFFFF");
  });
});
