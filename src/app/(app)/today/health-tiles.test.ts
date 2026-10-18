import { createElement } from "react";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { FAMILY_TEXTS_FOR_YOU } from "@/auth/access";
import { healthNow, nav } from "@/ui/copy";
import { rightNowTiles, type RightNowFacts } from "@/domain/health/right-now";
import { HealthTiles, TILE_LINKS } from "./HealthTiles";

/**
 * The Health tab as markup.
 *
 * png/health-demo-1440.png and png/health-demo-390.png: a "Right now" heading and exactly four
 * tiles — Kids placed, Vans checked, Running late, Needs you. No chart, no Systems row, no
 * Savings row. All is green, an open or late van is amber, and Family texts is the info teal.
 *
 * Firia ruling 2026-10-17: Health = four Right-now tiles on Today, behind Today's own door.
 */

/** The day the mockup draws: 12/12, 2/3 with Van 3 open, Van 2 late, two things waiting. */
const MOCKUP: RightNowFacts = {
  read: true,
  placed: 12,
  toPlace: 12,
  vansChecked: 2,
  vans: 3,
  uncheckedVans: ["Van 3"],
  lateVans: ["Van 2"],
  needsYou: 2,
};

function html(facts: RightNowFacts): string {
  return renderToStaticMarkup(createElement(HealthTiles, { tiles: rightNowTiles(facts) }));
}

describe("the four tiles, as the mockup draws them", () => {
  const markup = html(MOCKUP);

  it("is Right now, and exactly four tiles, in the mockup's order", () => {
    // png/health-demo-1440.png, png/health-demo-390.png
    expect(markup).toContain(healthNow.rightNow);
    // png/health-demo-1440.png: each tile is one link, chevron and all.
    const labels = [...markup.matchAll(/<a [\s\S]*?<\/a>/g)].map((m) => m[0]);
    expect(labels).toHaveLength(4);
    expect(markup.indexOf(healthNow.kidsPlaced)).toBeLessThan(markup.indexOf(healthNow.vansChecked));
    expect(markup.indexOf(healthNow.vansChecked)).toBeLessThan(markup.indexOf(healthNow.runningLate));
    expect(markup.indexOf(healthNow.runningLate)).toBeLessThan(markup.indexOf(healthNow.needsYou));
  });

  it("prints the mockup's figures, each from the facts and none of them written into the component", () => {
    // png/health-demo-1440.png: 12/12, 2/3, 1, 2
    expect(markup).toContain(">12<");
    expect(markup).toContain(">/12<");
    expect(markup).toContain(">2<");
    expect(markup).toContain(">/3<");
    expect(markup).toContain(">1<");
    expect(markup).toContain(healthNow.all);
    expect(markup).toContain("Van 3");
    expect(markup).toContain("Van 2");
    expect(markup).toContain(nav.familyTexts);
  });

  it("has no other section: no chart, no Systems row, no Savings row", () => {
    // png/health-demo-1440.png: the demo scope is the four tiles and nothing under them.
    expect(markup).not.toMatch(/Hours saved|Money saved|Not measured|Systems|Done for you/i);
    expect(markup.match(/<h2/g)).toHaveLength(1);
  });

  /**
   * png/health-demo-1440.png, png/health-demo-390.png: All is green, the open van and the late
   * van are amber, Family texts is the info teal. Green is the step strip's Done (ok) and
   * amber is its Needed (warn).
   */
  it("paints All green, the vans amber, and Family texts teal", () => {
    const pills = [...markup.matchAll(/data-tone="(ok|warn|neutral|info|crit)"/g)].map((m) => m[1]);
    expect(pills).toEqual(["ok", "warn", "warn", "info"]);
  });

  /**
   * png/health-demo-1440.png, png/health-demo-390.png: a tile at 0 still shows a grey None,
   * never a bare number. The empty day is four zeros.
   */
  it("gives every zero on the empty day a grey None pill", () => {
    const empty = html({
      read: true,
      placed: 0,
      toPlace: 0,
      vansChecked: 0,
      vans: 0,
      uncheckedVans: [],
      lateVans: [],
      needsYou: 0,
    });
    const pills = [...empty.matchAll(/data-tone="(ok|warn|neutral|info|crit)"/g)].map((m) => m[1]);
    expect(pills).toEqual(["neutral", "neutral", "neutral", "neutral"]);
    expect(empty.match(new RegExp(healthNow.none, "g"))).toHaveLength(4);
  });

  /**
   * png/health-demo-1440.png, png/health-demo-390.png: the big numbers are the app sans in a
   * heavy weight, not a mono face.
   */
  it("sets the tile numbers in the app sans at a heavy weight", () => {
    const css = readFileSync(path.join(__dirname, "health.module.css"), "utf8");
    const figure = css.slice(css.indexOf(".figure {"), css.indexOf(".count"));
    expect(figure).toMatch(/font-family:\s*var\(--font-ui\), system-ui, sans-serif/);
    expect(figure).toMatch(/font-weight:\s*var\(--weight-bold\)/);
    expect(markup).not.toContain("tabularNums");
  });

  it("links each tile to the screen the chevron promises", () => {
    // png/health-demo-1440.png, png/health-demo-390.png: the chevron is a way into the frame.
    expect(TILE_LINKS.KIDS_PLACED).toBe("/plan-routes");
    expect(TILE_LINKS.VANS_CHECKED).toBe("/ramp-ipad");
    expect(TILE_LINKS.RUNNING_LATE).toBe("/live-map");
    expect(TILE_LINKS.NEEDS_YOU).toBe(FAMILY_TEXTS_FOR_YOU);
    expect(markup).toContain(`href="${TILE_LINKS.KIDS_PLACED}"`);
    expect(markup).toContain(`href="${TILE_LINKS.VANS_CHECKED}"`);
    expect(markup).toContain(`href="${TILE_LINKS.RUNNING_LATE}"`);
    expect(markup).toContain(`href="${TILE_LINKS.NEEDS_YOU}"`);
    expect(markup).not.toContain("<article");
  });
});

describe("the door", () => {
  /**
   * Firia ruling 2026-10-17: Health = four Right-now tiles on Today.
   * The tiles are rendered by the Today page, after that page's own guard, and by nothing else.
   */
  it("is rendered by Today, after Today's guard, and by no other page", () => {
    const today = readFileSync(path.join(__dirname, "page.tsx"), "utf8");
    const guard = today.indexOf('requirePage("/today")');
    const render = today.indexOf("<TodayBoard");
    expect(guard).toBeGreaterThan(-1);
    expect(render).toBeGreaterThan(guard);
    expect(today).toContain("readRightNow");
    expect(today).toContain("rightNowTiles");

    const app = path.join(__dirname, "..");
    const pages = ["health/page.tsx", "family-texts/page.tsx", "exceptions/page.tsx"];
    for (const file of pages) {
      const source = readFileSync(path.join(app, file), "utf8");
      expect(source, file).not.toContain("HealthTiles");
      expect(source, file).not.toContain("readRightNow");
    }
  });
});
