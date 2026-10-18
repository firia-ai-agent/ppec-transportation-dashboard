/**
 * THE HEALTH TAB ON TODAY, in a real browser, at the phone width and at the founder's laptop.
 *
 * png/health-demo-1440.png and png/health-demo-390.png: Board | Health, and on Health exactly
 * four "Right now" tiles — Kids placed, Vans checked, Running late, Needs you. Nothing else.
 * png/today-saved-1440.png and png/today-saved-390.png: the same two tabs, with Board selected
 * on the board.
 *
 * The browser check has no database and no site (playwright.config.ts), so the numbers are the
 * unread day — the same day the step strip is reading. "Vans checked" agrees with "Van setup"
 * because they are that one count (Firia ruling 2026-10-17: the tile numbers come from the
 * same day facts as the step strip). The populated figures on the mockup are what those rows
 * add up to, and src/domain/health/right-now-facts.test.ts is where a changed row moves them.
 */
import { expect, test } from "@playwright/test";
import { legAt, serviceDateAt } from "../src/domain/day/day-facts";
import { deriveReadiness, unreadFacts } from "../src/domain/day/readiness";
import { rightNowTiles, unreadRightNow } from "../src/domain/health/right-now";
import { fill, flow, healthNow } from "../src/ui/copy";
import {
  expectDemoBarPinned,
  expectNoInternalCodes,
  expectOneSimulatedChip,
  expectVioletOnlyOnDemoChrome,
  shot,
} from "./helpers";

const WIDTHS = [390, 1440] as const;

/** The day this run can see: no site, so nothing was read. */
const READINESS = deriveReadiness(unreadFacts(serviceDateAt(), legAt()));
const TILES = rightNowTiles(unreadRightNow());

function figure(count: number, outOf: number | null): string {
  return outOf === null ? String(count) : `${count}/${outOf}`;
}

for (const width of WIDTHS) {
  test.describe(`the Health tab at ${width}px`, () => {
    test.use({ viewport: { width, height: width === 390 ? 844 : 900 } });

    test("Board and Health switch, and Health is the four Right now tiles", async ({ page }) => {
      await page.goto("/today");
      await expectDemoBarPinned(page);
      await expectOneSimulatedChip(page);

      // png/today-saved-1440.png, png/today-saved-390.png: the tabs are Board | Health, Board first.
      const tabs = page.getByRole("tablist", { name: healthNow.tabsLabel });
      const boardTab = tabs.getByRole("tab", { name: healthNow.board });
      const healthTab = tabs.getByRole("tab", { name: healthNow.health });
      await expect(boardTab).toBeVisible();
      await expect(healthTab).toBeVisible();
      await expect(boardTab).toHaveAttribute("aria-selected", "true");
      await expect(page.getByRole("navigation", { name: flow.stepsAria })).toBeVisible();

      // The step strip's van line, read before the switch, so Health can be asked to agree with it.
      const setup = fill(flow.detail.setup, {
        checked: READINESS.setup.checked,
        total: READINESS.setup.total,
      });
      await expect(page.getByRole("navigation", { name: flow.stepsAria })).toContainText(setup);

      // png/health-demo-1440.png, png/health-demo-390.png: Health is the four tiles.
      await healthTab.click();
      await expect(healthTab).toHaveAttribute("aria-selected", "true");
      await expect(boardTab).toHaveAttribute("aria-selected", "false");
      await expect(page.getByRole("navigation", { name: flow.stepsAria })).toBeHidden();

      const panel = page.getByRole("tabpanel", { name: healthNow.health });
      await expect(panel.getByRole("heading", { level: 2, name: healthNow.rightNow })).toBeVisible();
      const articles = panel.getByRole("article");
      await expect(articles).toHaveCount(4);

      for (const tile of TILES) {
        const card = articles.filter({ hasText: tile.label });
        await expect(card).toHaveCount(1);
        // The value is the unread day's, which is what this session can count.
        await expect(card).toContainText(figure(tile.count, tile.outOf));
      }

      // Firia ruling 2026-10-17: Vans checked agrees with Van setup.
      const vans = TILES.find((t) => t.key === "VANS_CHECKED");
      expect(vans?.count).toBe(READINESS.setup.checked);
      expect(vans?.outOf).toBe(READINESS.setup.total);
      await expect(articles.filter({ hasText: healthNow.vansChecked })).toContainText(
        figure(READINESS.setup.checked, READINESS.setup.total),
      );

      // png/health-demo-1440.png: no chart, no Systems row, no Savings row, no second section.
      const text = await panel.innerText();
      expect(text).not.toMatch(/Hours saved|Money saved|Not measured|Systems|Done for you/i);
      await expect(panel.getByRole("heading")).toHaveCount(1);

      // The page stays inside the screen. png/health-demo-390.png is one column of pairs.
      const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
      expect(scrollWidth).toBeLessThanOrEqual(width);

      await expectNoInternalCodes(page);
      await expectVioletOnlyOnDemoChrome(page);
      console.log("screenshot:", await shot(page, `health-tab-${width}`));

      // Back to the board: the tiles go, and the step strip is the board's again.
      await boardTab.click();
      await expect(boardTab).toHaveAttribute("aria-selected", "true");
      await expect(page.getByRole("navigation", { name: flow.stepsAria })).toBeVisible();
      await expect(page.getByRole("article")).toHaveCount(0);
    });
  });
}
