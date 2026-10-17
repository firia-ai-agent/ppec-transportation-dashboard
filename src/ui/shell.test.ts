import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { adapters, demoBanner, login, nav, scenarioClock, unbuilt } from "./copy";
import { DemoBanner } from "./DemoBanner";
import { Placeholder } from "./Placeholder";
import { ScenarioClock } from "./ScenarioClock";
import { SourceBadge } from "./SourceBadge";
import { color, contrastRatio } from "./tokens";

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

describe("NFR-09 / §7.1: the source-mode chip sits next to the DEMO banner", () => {
  const rootLayout = read(APP, "layout.tsx");
  const banner = read(UI, "DemoBanner.tsx");

  it("the root layout renders the bar, so /login and the developer pages carry it too", () => {
    expect(rootLayout).toMatch(/<DemoBanner \/>/);
  });

  it("places the chip in the bar, not in a strip of its own (Vera's answer, 2026-10-14)", () => {
    expect(banner).toMatch(/<ScreenSource \/>/);
    // A second mount in the layout would be the full-width strip the answer removed.
    expect(rootLayout).not.toMatch(/ScreenSource/);
    expect(existsSync(path.join(UI, "ScreenSource.module.css"))).toBe(false);
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
    // ...and only the bar mounts ScreenSource, so the chip cannot appear twice on a screen.
    const files = readdirSync(UI).filter((f) => f.endsWith(".tsx") && f !== "ScreenSource.tsx");
    const screenSourceMounts = files.filter((f) => /<ScreenSource\b/.test(read(UI, f)));
    expect(screenSourceMounts).toEqual(["DemoBanner.tsx"]);
  });

  it("the badge announces its mode and shows the label (§7.1)", () => {
    const html = renderToStaticMarkup(SourceBadge({ mode: "SIMULATED" }));
    expect(html).toContain("Source: Simulated");
    expect(html).toContain("Simulated");
  });

  it("renders the 'DEMO' bar and the Simulated chip in one row", () => {
    process.env.APP_DATA_CLASS = "SYNTHETIC";
    const html = renderToStaticMarkup(DemoBanner());
    expect(html).toContain(demoBanner.text);
    expect(html).toContain('aria-label="DEMO"');
    // role="status" wraps the banner text only: the chip is announced as its own thing.
    expect(html).toMatch(/role="status"[^>]*>(?:(?!<\/p>).)*DEMO/);
    expect(html).toContain("Source: Simulated");
    // One chip, one banner, in a single bar element.
    expect(html.match(/Source: Simulated/g)).toHaveLength(1);
    expect(html.match(/role="status"/g)).toHaveLength(1);
  });

  it("keeps the bar 32 px, full-width and violet, with the chip in its trailing cell", () => {
    const css = read(UI, "DemoBanner.module.css");
    expect(css).toMatch(/min-height: var\(--layout-demo-banner-height\)/);
    expect(css).toMatch(/background: var\(--color-demo-bg\)/);
    expect(css).toMatch(/color: var\(--color-demo-fg\)/);
    // Its own column, so the chip can neither overlap "DEMO" nor pull it off-centre.
    expect(css).toMatch(/grid-template-columns: 1fr auto 1fr/);
    expect(css).toMatch(/\.source \{[^}]*grid-column: 3/);
  });

  it("stays on screen while the page scrolls, which is what 'every screen' means", () => {
    const css = read(UI, "DemoBanner.module.css");
    // Rendered in the root layout the bar is on every *route*; sticky is what keeps it on
    // every *screen*, including a signed-in board taller than the window (NFR-09, §7).
    expect(css).toMatch(/\.banner \{[^}]*position: sticky/);
    expect(css).toMatch(/\.banner \{[^}]*top: 0/);
    // Above the §2 icon rail, which raises itself to z-index 10 when it expands over content.
    const z = /\.banner \{[^}]*z-index: (\d+)/.exec(css)?.[1];
    const railZ = /\.rail \{[^}]*z-index: (\d+)/.exec(read(UI, "NavRail.module.css"))?.[1];
    expect(Number(z)).toBeGreaterThan(Number(railZ));
  });

  it("the console reserves the bar's height instead of overflowing by it", () => {
    // A flat 100vh under a 32 px bar makes every signed-in page scroll by exactly the height
    // of the bar — which, before the bar was sticky, scrolled the bar itself out of sight.
    expect(read(UI, "AppShell.module.css")).toMatch(
      /\.shell \{[^}]*min-height: calc\(100vh - var\(--layout-demo-banner-height\)\)/,
    );
    // The skip link clears the bar rather than landing under it.
    expect(read(APP, "globals.css")).toMatch(
      /\.skipLink:focus \{[^}]*top: calc\(var\(--layout-demo-banner-height\)/,
    );
  });

  it("every signed-in route is inside the layout that sits under that one bar", () => {
    // The (app) layout must not mount a bar of its own — one per screen, from the root.
    const appLayout = read(APP, "(app)", "layout.tsx");
    expect(appLayout).toMatch(/<AppShell /);
    expect(appLayout).not.toMatch(/DemoBanner|ScreenSource|SourceBadge/);
    // ...and it must actually wrap the signed-in pages, or they would render bare.
    const routes = readdirSync(path.join(APP, "(app)"), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
    expect(routes).toEqual(expect.arrayContaining(["today", "exceptions", "setup", "health"]));
  });

  it("the outlined white chip still passes contrast on the violet bar", () => {
    const chipCss = read(UI, "SourceBadge.module.css");
    expect(chipCss).toMatch(/background: var\(--color-surface\)/);
    expect(chipCss).toMatch(/border: var\(--border-hairline\) solid var\(--color-border-strong\)/);
    // Chip text on its own white fill is the §8 row (7.10:1), unchanged by what sits behind it.
    expect(contrastRatio(color["src-sim"], color.surface)).toBeGreaterThanOrEqual(4.5);
    // The chip's edge against the bar is a UI part, so 3:1: white on demo violet is 7.10:1.
    expect(contrastRatio(color.surface, color["demo-bg"])).toBeGreaterThanOrEqual(3);
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

  it("takes the collapsed label out of flow, so the icon is not pushed off the rail", () => {
    /*
     * The clipped rail. Faded but still in flow, "Exceptions & Approvals" plus the 12 px gap
     * measures far wider than the 48 px of usable rail; `justify-content: center` then centres
     * a row wider than its box and `overflow: hidden` cuts the icon in half at its left edge.
     * Absolute positioning takes the label's width out of the sum. The browser check in
     * e2e/screens.spec.ts measures the real thing at 1024.
     */
    const collapsed = rail.slice(rail.indexOf("@media (max-width: 1279px)"));
    expect(collapsed).toMatch(/\.label \{[^}]*position: absolute/);
    expect(collapsed).toMatch(/\.rail:hover \.label,\s*\.rail:focus-within \.label \{[^}]*position: static/);
    // The label is clipped, never removed: the name stays in the DOM at every width.
    expect(collapsed).not.toMatch(/\.label \{[^}]*display: none/);
  });
});

/**
 * Vera's final call on the date: one on screen, the replayed demo day, and the chrome is not
 * where it lives. §2 asked the header for the service date, and for a while it answered with
 * today's real date while the board answered with the seeded day — two dates, both labelled
 * "Service date", one of them always wrong (docs/ui/B12-SLICE1-DEFERRED.md §5). In demo mode the
 * header shows no date at all: the board's header carries the day, and the surfaces that have no
 * day do not pretend to have one.
 */
describe("§2 header: in demo mode no date in the chrome", () => {
  const shell = read(UI, "AppShell.tsx");

  it("reads no clock and formats no date", () => {
    expect(shell).not.toMatch(/serviceDate(Label|Iso)?\b/);
    expect(shell).not.toMatch(/new Date\(|Intl\.DateTimeFormat|toLocaleDateString/);
    expect(shell).not.toMatch(/<time\b/);
  });

  it("carries the scenario clock as its only fact, which says the demo has not started", () => {
    const facts = [...shell.matchAll(/<dt className=\{styles\.factLabel\}>\{([^}]+)\}/g)];
    expect(facts.map((m) => m[1])).toEqual(["scenarioClock.label"]);
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
    // Today is not among them: the board is built, so there is no sentence promising it.
    expect(unbuilt).not.toHaveProperty("today");
    for (const body of [unbuilt.exceptions, unbuilt.setup, unbuilt.health]) {
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
    expect(html).toContain(escapeApostrophes(unbuilt.health));
    expect(html).not.toMatch(/\bB-\d+\b/);
  });

  it("says 'not built' once — the heading, and no chip repeating it", () => {
    const html = renderToStaticMarkup(Placeholder({ page: nav.health, body: unbuilt.health }));
    expect(html).not.toMatch(/Not built yet/i);
    expect(html.match(/built yet/g)).toHaveLength(1);
    // One heading, one sentence, and nothing else in the frame.
    expect(html.match(/<(?:h1|p|span)\b/g)).toEqual(["<h1", "<p"]);
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
