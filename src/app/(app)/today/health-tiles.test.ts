import { createElement } from "react";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { healthNow, nav } from "@/ui/copy";
import { rightNowTiles, type RightNowFacts } from "@/domain/health/right-now";
import { HealthTiles } from "./HealthTiles";

/**
 * The Health tab as markup.
 *
 * png/health-demo-1440.png and png/health-demo-390.png: a "Right now" heading and exactly four
 * tiles — Kids placed, Vans checked, Running late, Needs you. No chart, no Systems row, no
 * Savings row. The pills are grey.
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
    const labels = [...markup.matchAll(/<article[\s\S]*?<\/article>/g)].map((m) => m[0]);
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

  /** Hard rule: health pills are grey, which is the neutral tone and not a status colour. */
  it("draws every pill in the neutral tone", () => {
    const pills = markup.match(/data-pill="true"/g) ?? [];
    expect(pills.length).toBeGreaterThan(0);
    expect(markup.match(/data-tone="neutral"/g)).toHaveLength(pills.length);
    expect(markup).not.toMatch(/data-tone="ok"|data-tone="warn"|data-tone="crit"|data-tone="info"/);
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
