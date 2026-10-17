import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { adapters, demoBanner, login, nav, scenarioClock, unbuilt } from "./copy";
import { DemoBanner } from "./DemoBanner";
import { Placeholder } from "./Placeholder";
import { ScenarioClock } from "./ScenarioClock";
import { SourceBadge } from "./SourceBadge";
import { color, contrastRatio } from "./tokens";
import { API, rolesWhoCanCall } from "@/auth/access";
import type { StaffRole } from "@/auth/core";

/*
 * The scenario clock calls `router.refresh()` after a reset, so it needs the app router — which
 * is mounted by the framework and not by `renderToStaticMarkup`. The stub is the router and
 * nothing else: what this file renders for is the markup each role gets, and the refresh itself
 * is asserted where the order is, in demo-day.test.ts.
 */
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));

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

  /** What one role's shell actually renders for this control. */
  const markup = (role: StaffRole | null) => renderToStaticMarkup(createElement(ScenarioClock, { role }));

  it("reads 'Demo not started' and offers 'Start demo day' beside it", () => {
    expect(scenarioClock.notStarted).toBe("Demo not started");
    // COPY-GUIDE §3: verb + object, ≤3 words — the button says what it starts.
    expect(scenarioClock.start).toBe("Start demo day");
    // …and the same button, once the day is running, says what it does the second time.
    expect(scenarioClock.restart).toBe("Restart demo day");
  });

  /**
   * The founder's first click on prod (2026-10-17 14:40 ET) landed on this button and nothing
   * happened: it was rendered `aria-disabled` with no handler and a tooltip saying the demo
   * controls were not connected. None of that may come back — a button that looks like a button
   * does its job, and an explanation on hover is no explanation on a phone.
   *
   * It is wired to the whole press now, not only the clock: `startDemoDay` resets the demo's
   * data and then starts the clock (founder's final ruling, 2026-10-17 14:44 ET, ledger row 72).
   */
  it("is wired to the reset and the clock, with nothing left that makes it inert", () => {
    expect(component).toMatch(/startDemoDay\(\{/);
    expect(component).toMatch(/reset: postDemoReset/);
    expect(component).toMatch(/startClock: restartDemoClock/);
    // On success the screens are re-rendered over the rows the reset just replaced.
    expect(component).toMatch(/refresh: \(\) => router\.refresh\(\)/);
    // Never rendered inert: the one `disabled` in the file is the pending press, and there is
    // no `aria-disabled` and no tooltip anywhere — on a phone a hover explains nothing.
    expect([...component.matchAll(/\sdisabled=\{([^}]*)\}/g)].map((m) => m[1])).toEqual(["pending"]);
    expect(component).not.toMatch(/aria-disabled=/);
    expect(component).not.toMatch(/role="tooltip"/);
    expect(css).not.toMatch(/tooltip/);
    expect(css).not.toMatch(/not-allowed/);
  });

  it("looks like the control it is: a pointer, a hover fill, and the §9 focus ring", () => {
    expect(css).toMatch(/cursor: pointer/);
    expect(css).toMatch(/\.start:hover/);
    // §9's ring is global (src/app/globals.css) and nothing here removes it.
    expect(css).not.toMatch(/outline:\s*none/);
  });

  /**
   * The clock reads a store, so a *server* render has exactly one thing it can say: the demo has
   * not started. That is also the hydration contract — the first client render must match this.
   */
  it("renders the readout and a live Start", () => {
    const html = markup("DIRECTOR");
    expect(html).toContain(scenarioClock.notStarted);
    expect(html).toContain(scenarioClock.start);
    expect(html).not.toContain(scenarioClock.restart);
    expect(html).not.toMatch(/aria-disabled/);
    expect(html).not.toMatch(/\sdisabled[=\s/>]/);
    expect(html).not.toMatch(/tabindex="-1"/i);
    // Nothing has been pressed, so there is no answer line and no dialog on the page.
    expect(html).not.toContain(scenarioClock.confirmTitle);
    expect(html).not.toContain(scenarioClock.previewOnly);
    expect(html).not.toContain(scenarioClock.failed);
  });

  /**
   * Founder's final ruling (2026-10-17 14:44 ET, ledger row 72): only the director and the
   * coordinator may use it, and **the front desk does not see the button at all** — not a
   * disabled one, which is the inert control the 14:40 report was about. The roles are read from
   * the endpoint's own row, so this cannot drift from the server's answer; the server refuses
   * their POST regardless (guard-matrix.test.ts), and hiding is only the courtesy on top.
   */
  it("offers the control to the roles the reset endpoint names, and to no one else", () => {
    expect([...rolesWhoCanCall(API.demoReset)]).toEqual(["DIRECTOR", "COORDINATOR"]);

    for (const role of rolesWhoCanCall(API.demoReset)) {
      const html = markup(role);
      expect(html, role).toContain(scenarioClock.start);
      expect(html, role).toContain("<button");
    }

    // The front desk, and a signed-in person holding no role at all: the readout, no control.
    for (const role of ["FRONT_DESK", null] as const) {
      const html = markup(role);
      expect(html, String(role)).toContain(scenarioClock.notStarted);
      expect(html, String(role)).not.toContain("<button");
      expect(html, String(role)).not.toContain(scenarioClock.start);
      // Not an inert one either: no disabled attribute, no aria-disabled, nothing to click.
      expect(html, String(role)).not.toMatch(/disabled/);
    }
  });

  /**
   * The second press asks first, and the dialog is the founder's wording (ledger row 72). The
   * markup is read off the source because the dialog only exists after a click, which needs a
   * DOM; e2e/scenario-clock.spec.ts opens it with a real mouse, cancels, and restarts.
   */
  it("asks before a restart, with Cancel focused and Restart in the critical ink", () => {
    expect(component).toMatch(/onClick=\{clock\.running \? \(\) => setConfirming\(true\) : run\}/);
    expect(component).toMatch(/role="dialog"/);
    expect(component).toMatch(/aria-modal="true"/);
    // Cancel takes the focus when it opens, so the quiet keypress is the harmless one (§9).
    expect(component).toMatch(/if \(confirming\) cancelRef\.current\?\.focus\(\)/);
    expect(component).toMatch(/ref=\{cancelRef\}/);
    // Escape is Cancel, and Cancel does nothing but close.
    expect(component).toMatch(/event\.key === "Escape"/);

    const danger = css.slice(css.indexOf(".danger"));
    expect(danger).toMatch(/background: var\(--color-crit-fg\)/);
    expect(danger).toMatch(/color: var\(--color-surface\)/);
    // That inversion is a §8 row this build computes: 8.31:1 (tokens.test.ts).
    expect(contrastRatio(color.surface, color["crit-fg"])).toBeGreaterThanOrEqual(4.5);
  });

  it("says in one line what a press came back with, and only then", () => {
    // The two answers are different sentences, and the failure is the one in critical ink.
    expect(component).toMatch(/\{note\.text\}/);
    expect(component).toMatch(/role="status"/);
    const note = css.slice(css.indexOf(".note {"));
    expect(note).toMatch(/color: var\(--color-ink-muted\)/);
    expect(note).toMatch(/\.note\[data-scenario-clock="error"\]/);
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
