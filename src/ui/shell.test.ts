import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

/**
 * The DEMO bar's one control is a client component and asks for the router it refreshes the
 * screen with. There is no router in node, so this stands in for one: what is being rendered
 * here is the bar's *markup* — which role gets a button and what it says — and the refresh
 * after a reset is the browser check's to prove (e2e/rework-frame.spec.ts).
 */
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {} }),
  usePathname: () => "/today",
  useSearchParams: () => new URLSearchParams(),
}));
import { app, demoBanner, demoDay, login, nav, unbuilt } from "./copy";
import { canRestartDemo, DemoBanner } from "./DemoBanner";
import { Placeholder } from "./Placeholder";
import { SourceBadge } from "./SourceBadge";
import { color, contrastRatio, layout } from "./tokens";
import { ROLE_LADDER } from "@/auth/access";
import { RESET_ROLES } from "@/modules/demo/reset";

/**
 * Shell contracts from Vera's review.
 *
 * The server components are rendered for real with `renderToStaticMarkup`. The rules that live
 * in CSS, and the client components that need a router (NavRail, TabBar), are asserted by
 * reading the source instead: there is no DOM or browser here (vitest runs in node, no jsdom),
 * so a source assertion proves the rule is written, not that the browser applies it. §10's
 * persona walk is still the thing that proves the latter.
 */
const UI = __dirname;
const APP = path.resolve(UI, "..", "app");

function read(...parts: string[]): string {
  return readFileSync(path.join(...parts), "utf8");
}

/** A file with its comments taken out: what it *does*, rather than what it says about itself. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/** React escapes `'` in text nodes, so a copy string has to be escaped to be found in markup. */
function escapeApostrophes(text: string): string {
  return text.replace(/'/g, "&#x27;");
}

describe("NFR-09 / §7.1: the source-mode chip sits next to the DEMO banner", () => {
  const rootLayout = read(APP, "layout.tsx");
  const banner = read(UI, "DemoBanner.tsx");

  it("the root layout renders the bar, so /login and the developer pages carry it too", () => {
    // `DemoBar` is the bar plus the one session read that tells it whether to draw its control
    // (src/ui/DemoBar.tsx); `DemoBanner` is the markup under it, which is what is rendered here.
    expect(rootLayout).toMatch(/<DemoBar \/>/);
    expect(read(UI, "DemoBar.tsx")).toMatch(/<DemoBanner role=\{/);
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
    const html = renderToStaticMarkup(DemoBanner({ role: "DIRECTOR" }));
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
    /*
     * One row, leading words and trailing control, with one spacer between them. It was three
     * grid columns with "DEMO" optically centred in the middle one; the centre stopped being
     * worth keeping when the bar gained the control at its trailing end (REDESIGN-SPEC §0).
     */
    expect(css).toMatch(/\.banner \{[^}]*display: flex/);
    expect(css).toMatch(/\.spacer \{[^}]*flex: 1 1 auto/);
    expect(css).not.toMatch(/grid-template-columns/);
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
    expect(appLayout).toMatch(/<ConsoleShell /);
    expect(appLayout).not.toMatch(/DemoBanner|ScreenSource|SourceBadge/);
    // ...and it must actually wrap the signed-in pages, or they would render bare.
    const routes = readdirSync(path.join(APP, "(app)"), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
    expect(routes).toEqual(expect.arrayContaining(["today", "exceptions", "setup", "health"]));
  });

  /**
   * The three screens that are routes of their own, outside that group. Their own layouts mount
   * the same shell, and must not mount a bar either: the root layout's is the only one, and a
   * second would be two "DEMO" bars and two Simulated chips on the screens a founder is shown.
   */
  it.each(["plan-routes", "live-map", "ramp-ipad"])("%s mounts the shell and no second bar", (route) => {
    const layout = read(APP, route, "layout.tsx");
    expect(layout).toMatch(/<ConsoleShell /);
    expect(layout).not.toMatch(/DemoBanner|ScreenSource|SourceBadge/);
  });

  /**
   * The chip is the one pill now (audit §2 item 4 / §4 item 1): fully rounded, 20 px high, a
   * white fill and 11 px semibold text in the mode's own token. It used to be a square-cornered
   * outlined box, which is what the audit's crop of production shows.
   */
  it("the rounded white chip still passes contrast on the violet bar", () => {
    const chipCss = read(UI, "Pill.module.css");
    const pill = chipCss.slice(chipCss.indexOf(".pill {"), chipCss.indexOf(".pill[data-tone"));
    expect(pill).toMatch(/border-radius: var\(--radius-pill\)/);
    expect(pill).toMatch(/font-size: var\(--text-11\)/);
    const source = chipCss.slice(chipCss.indexOf(".source,"));
    expect(source).toMatch(/height: var\(--layout-source-badge-height\)/);
    expect(source).toMatch(/background: var\(--color-surface\)/);
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

  /*
   * The name is `item.label`, and on the one row that carries a count it is the label *and* the
   * count in words — "Family texts, 2 waiting" (`flow.tabbar`, src/ui/menu-badge.ts), because
   * the disc that draws the number is aria-hidden and a shape says nothing to a reader (§9).
   */
  it("gives every link both an aria-label and a tooltip carrying the page name", () => {
    expect(component).toMatch(/aria-label=\{name\}/);
    expect(component).toMatch(/title=\{name\}/);
    expect(component).toMatch(/const name =\s*\n?\s*waiting === null\s*\n?\s*\? item\.label/);
    expect(component).toMatch(/flow\.tabbar\.waiting/);
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
});

/**
 * NO HEADER AT ALL, AND A PAGE HEADER BAR INSTEAD (Vera's audit §2 items 1, 3 and 5; Firia,
 * 2026-10-17 8:36 PM ET).
 *
 * The header was two rows, then one, and now none. What production had at ef4bfb3 was a 96 px
 * white band reading "PPEC transportation" above a rail that started with nothing, with a "D ·
 * Dana ⌄" pill at its far right — the product named twice over on a 1440 screen and the account
 * in two places. Everything it held has somewhere better to be: the name is the rail's brand
 * block, the account is the block at the rail's foot (and below 768, where the rail is a tab
 * bar, the 36 px disc in the page header bar), and the screen's own title is that bar.
 *
 * What left earlier and has not come back: four "<adapter> · Simulated" pills and their note,
 * global search (it searches the board, so it is on the board), the dead "Demo day · Not
 * started" readout and its inert "Start demo day".
 */
describe("§2 the page header bar, and no app header", () => {
  const shell = read(UI, "AppShell.tsx");
  const css = read(UI, "AppShell.module.css");
  const barCss = read(UI, "PageHeader.module.css");
  const bar = read(UI, "PageHeader.tsx");

  it("mounts no header element and holds no header styles", () => {
    expect(shell).not.toMatch(/<header/);
    expect(css).not.toMatch(/\.header \{|\.siteName \{/);
    // The two rows it was once built from are gone, names and all.
    expect(css).not.toMatch(/\.topRow|\.bottomRow/);
    expect(shell).not.toMatch(/styles\.topRow|styles\.bottomRow/);
    // ...and so is the product name it carried: the rail's brand block says it once.
    expect(code(read(UI, "copy.ts"))).not.toMatch(/siteName/);
  });

  /** The bar the mockup draws: 64 px, white, one hairline under it, the title in Teal Ink. */
  it("is a 64 px white bar with the title at the 20 px step in Teal Ink", () => {
    const block = barCss.slice(barCss.indexOf(".bar {"), barCss.indexOf(".title {"));
    expect(block).toMatch(/min-height: var\(--layout-header-height\)/);
    expect(block).toMatch(/background: var\(--color-surface\)/);
    expect(block).toMatch(/border-bottom: var\(--border-hairline\)/);
    expect(layout.headerHeight).toBe("64px");
    const title = barCss.slice(barCss.indexOf(".title {"), barCss.indexOf(".spacer {"));
    expect(title).toMatch(/font-size: var\(--text-20\)/);
    expect(title).toMatch(/font-weight: var\(--weight-semibold\)/);
    expect(title).toMatch(/color: var\(--color-ink-brand\)/);
    // Teal Ink on white, and on the page's own off-white: both well over AA.
    expect(contrastRatio(color["ink-brand"], color.surface)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(color["ink-brand"], color.bg)).toBeGreaterThanOrEqual(4.5);
  });

  /** One `h1` per screen, and it is this one: the title is read from the access table's label. */
  it("carries the screen's own title, as its one h1", () => {
    expect(bar).toMatch(/<h1 className=\{styles\.title\}>\{title\}<\/h1>/);
    expect(bar).toMatch(/pageTitleFor\(pathname\)/);
  });

  it("carries no demo chrome at all: that is the bar above it", () => {
    // The code, not the comments: the file explains where the demo's control went, and saying
    // so is the opposite of mounting one.
    expect(code(shell)).not.toMatch(/ScenarioClock|scenarioClock|DemoRestart|demoDay\./);
    expect(code(bar)).not.toMatch(/ScenarioClock|scenarioClock|DemoRestart|demoDay\./);
    // The component and its stylesheet are deleted, not hidden: nothing can mount one again.
    for (const gone of ["ScenarioClock.tsx", "ScenarioClock.module.css"]) {
      expect(existsSync(path.join(UI, gone)), gone).toBe(false);
    }
    // ...and the copy went with it, so there is no "Demo not started" left to render.
    expect(code(read(UI, "copy.ts"))).not.toMatch(/scenarioClock|Demo day · Not started/);
  });

  it("mounts no adapter pill and no search box", () => {
    expect(shell).not.toMatch(/FreshnessPill|SimulatedAdapterPill|adapters\./);
    // Search moved into Today, under the board's own title — it searches those rows.
    expect(shell).not.toMatch(/SearchField/);
    expect(read(APP, "(app)", "today", "TodayBoard.tsx")).toMatch(/<SearchField \/>/);
    // And the pill component itself is gone, so nothing can mount one again by accident.
    expect(existsSync(path.join(UI, "FreshnessPill.tsx"))).toBe(false);
  });

  /**
   * ONE IDENTITY LOCATION PER WIDTH, AND NEVER NONE.
   *
   * ≥1280 it is the rail's account block; 768–1279 the same block, collapsed to its disc on the
   * icon rail; <768 the 36 px disc at the trailing end of the page header bar. The avatar menu
   * that used to be the one below 1280 is deleted with the band it sat in — the disc is a *link*
   * to /whoami, which is the screen Sign out is on, so the way to stop being signed in is one
   * tap from every screen at every width (Firia, 3:08 PM ET: "reachable on phone").
   */
  it("keeps exactly one identity location at each width", () => {
    // Both are given the same object, built once in ConsoleShell.
    expect(shell).toMatch(/<PageHeader account=\{account\} \/>/);
    expect(shell).toMatch(/<NavRail role=\{role\} account=\{account\} \/>/);
    // The deleted menu, gone as files so nothing can mount it again.
    for (const gone of ["AvatarMenu.tsx", "AvatarMenu.module.css"]) {
      expect(existsSync(path.join(UI, gone)), gone).toBe(false);
    }
    // The page header's disc is drawn below 768 and nowhere else.
    expect(barCss).toMatch(/\.avatar \{\s*display: none;\s*\}/);
    const phone = barCss.slice(barCss.indexOf("@media (max-width: 767px)"));
    expect(phone).toMatch(/\.avatar \{[^}]*width: var\(--layout-avatar-phone\)/);
    expect(bar).toMatch(/href=\{account\.href\}/);
    // ...and the rail's own account block is a link to the same screen, at both rail widths.
    const rail = read(UI, "NavRail.tsx");
    expect(rail).toMatch(/href=\{account\.href\}/);
    const railCss = read(UI, "NavRail.module.css");
    const narrow = railCss.slice(railCss.indexOf("@media (max-width: 1279px)"));
    expect(narrow).not.toMatch(/\.account \{[^}]*display: none/);
  });
});

/**
 * THE RAIL'S BRAND BLOCK — a square mark and the centre's name over what the app is for
 * (REDESIGN-SPEC §9.2, png/shell-flow-1440.png). The 64 px icon rail shows the mark alone,
 * because 64 px has no room for a name and a clipped one is worse than none.
 */
describe("§9.2 the rail's brand block", () => {
  const rail = read(UI, "NavRail.tsx");
  const css = read(UI, "NavRail.module.css");

  it("is the first thing in the rail, above the menu", () => {
    expect(rail.indexOf("styles.brand")).toBeGreaterThan(-1);
    expect(rail.indexOf("styles.brand")).toBeLessThan(rail.indexOf("styles.list"));
  });

  it("takes its mark from the name, so a centre is named in one place", () => {
    expect(app.brandName).toBe("Sunrise PPEC");
    expect(app.brandLine).toBe("Transport");
    expect(rail).toMatch(/app\.brandName\.trim\(\)\[0\]/);
    expect(app.brandName.trim()[0]).toBe("S");
  });

  it("wears Teal Ink and the brand's own white, which is a §8 pair", () => {
    expect(css).toMatch(/\.mark \{[^}]*background: var\(--color-ink-brand\)/);
    expect(css).toMatch(/\.mark \{[^}]*color: var\(--color-surface\)/);
    expect(contrastRatio(color["ink-brand"], color.surface)).toBeGreaterThanOrEqual(4.5);
    expect(css).toMatch(/\.brandName \{[^}]*color: var\(--color-ink-brand\)/);
  });

  it("shows the mark alone on the 64 px icon rail", () => {
    const narrow = css.slice(css.indexOf("@media (max-width: 1279px)"));
    expect(narrow).toMatch(/\.brandText \{[^}]*display: none/);
    expect(narrow).not.toMatch(/\.mark \{[^}]*display: none/);
  });
});

/**
 * THE ONE CONTROL IN THE DEMO BAR — "Restart demo day" (REDESIGN-SPEC §0, and the founder's
 * mockups: png/shell-flow-1440.png, png/shell-flow-390.png).
 *
 * The bar reads `DEMO · Synthetic data · [Simulated] ……… [Restart demo day]`. Three claims are
 * worth holding in a test and all three are below: the label is exactly that, the control is
 * *in the bar* and nowhere else, and the roles it is drawn for are the roles the reset endpoint
 * answers — so the front desk, whom §0 hides it from and whom the server refuses, cannot be
 * shown a button that would 403 in their hands.
 */
describe("§7 the DEMO bar's one control", () => {
  const banner = read(UI, "DemoBanner.tsx");
  const restart = read(UI, "DemoRestart.tsx");
  const css = read(UI, "DemoRestart.module.css");

  it("reads exactly 'Restart demo day'", () => {
    expect(demoDay.restart).toBe("Restart demo day");
    // COPY-GUIDE §3: a button is a verb and an object, three words at most.
    expect(demoDay.restart.split(" ")).toHaveLength(3);
  });

  it("is rendered by the bar, and by nothing else in the app", () => {
    expect(banner).toMatch(/<DemoRestart \/>/);
    const mounts = readdirSync(UI)
      .filter((f) => f.endsWith(".tsx") && !f.endsWith(".test.tsx"))
      .filter((f) => /<DemoRestart\b/.test(read(UI, f)));
    expect(mounts).toEqual(["DemoBanner.tsx"]);
    // Not in the app header, which is where the thing it replaces used to live.
    expect(code(read(UI, "AppShell.tsx"))).not.toMatch(/DemoRestart|Restart demo day/);
  });

  it("is drawn for exactly the roles the reset endpoint answers", () => {
    // DIRECTOR today (src/auth/access.ts). Read from the table, so this follows a change to it.
    expect(ROLE_LADDER.filter((role) => canRestartDemo(role))).toEqual(RESET_ROLES);
    expect(canRestartDemo(null)).toBe(false);
  });

  it("is never drawn for the front desk (REDESIGN-SPEC §0)", () => {
    expect(canRestartDemo("FRONT_DESK")).toBe(false);
    // And the bar leaves it out of the markup entirely rather than hiding it in CSS.
    process.env.APP_DATA_CLASS = "SYNTHETIC";
    const frontDesk = renderToStaticMarkup(DemoBanner({ role: "FRONT_DESK" }));
    expect(frontDesk).not.toContain(demoDay.restart);
    expect(frontDesk).not.toMatch(/<button/);
    const director = renderToStaticMarkup(DemoBanner({ role: "DIRECTOR" }));
    expect(director).toContain(demoDay.restart);
  });

  it("calls the reset this app already has, by its row rather than by a written path", () => {
    expect(restart).toMatch(/fetch\(API\.demoReset/);
    expect(restart).toMatch(/method: "POST"/);
    // src/ui/no-internals.test.ts bars the literal; this is the other half of that rule.
    expect(restart).not.toMatch(/"\/api\//);
  });

  it("wears the bar's own pair, not the screen's action colour (D-5)", () => {
    expect(css).toMatch(/\.button \{[^}]*border: var\(--border-hairline\) solid var\(--color-demo-fg\)/);
    expect(css).toMatch(/\.button \{[^}]*color: var\(--color-demo-fg\)/);
    expect(css).toMatch(/\.button:focus-visible \{[^}]*outline: var\(--focus-width\) solid var\(--color-demo-fg\)/);
    expect(css).not.toMatch(/--color-brand/);
  });

  it("says what it is doing while it runs, and why it did not when it fails", () => {
    expect(restart).toMatch(/busy \? demoDay\.restarting : demoDay\.restart/);
    expect(demoDay.restarting.endsWith("…")).toBe(true);
    expect(demoDay.failed).toBe("The demo day didn't restart. Try again.");
    // The failure is announced where it is read, beside the control (§4.2).
    expect(restart).toMatch(/role="status"/);
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
    /*
     * One heading, one sentence, and nothing else in the frame — and the heading is an `h2`:
     * the page's one `h1` is the frame's page header bar (src/ui/PageHeader.tsx, audit §2
     * item 1), so a second one here would be two titles on one screen.
     */
    expect(html.match(/<(?:h1|h2|p|span)\b/g)).toEqual(["<h2", "<p"]);
  });
});

describe("§8 primary action token", () => {
  const css = read(APP, "login", "login.module.css");

  it("Sign in uses the brand token for its background and surface for its text", () => {
    const submit = css.slice(css.indexOf(".submit"));
    expect(submit).toMatch(/background: var\(--color-brand\)/);
    expect(submit).toMatch(/color: var\(--color-surface\)/);
  });

  it("that pair is the §8 row that passes AA", () => {
    // The brand is the founder's teal now (tokens.ts); the pair is checked as a *ratio* rather
    // than as a hex, so the palette can be answered without this file having an opinion on it.
    expect(color.surface).toBe("#FFFFFF");
    expect(contrastRatio(color.surface, color.brand)).toBeGreaterThanOrEqual(4.5);
  });
});
