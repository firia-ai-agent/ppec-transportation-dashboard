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
import { board as boardCopy, fill, flow, healthNow, nav, planRoutes } from "../src/ui/copy";
import { TILE_LINKS } from "../src/app/(app)/today/HealthTiles";
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
      // png/health-demo-1440.png, png/health-demo-390.png: the selected tab is a filled pill,
      // info-bg behind info-fg, the same fill today-saved uses. The other tab is not filled.
      const tabTone = await healthTab.evaluate((el) => {
        const probe = document.createElement("div");
        probe.style.backgroundColor = "var(--color-info-bg)";
        probe.style.color = "var(--color-info-fg)";
        document.body.appendChild(probe);
        const want = getComputedStyle(probe);
        const got = getComputedStyle(el);
        const board = document.getElementById("today-tab-board");
        const boardBg = board ? getComputedStyle(board).backgroundColor : "";
        const read = {
          bg: got.backgroundColor,
          fg: got.color,
          wantBg: want.backgroundColor,
          wantFg: want.color,
          boardBg,
        };
        probe.remove();
        return read;
      });
      expect(tabTone.bg).toBe(tabTone.wantBg);
      expect(tabTone.fg).toBe(tabTone.wantFg);
      expect(tabTone.boardBg).not.toBe(tabTone.wantBg);
      await expect(page.getByRole("navigation", { name: flow.stepsAria })).toBeHidden();

      const panel = page.getByRole("tabpanel", { name: healthNow.health });
      await expect(panel.getByRole("heading", { level: 2, name: healthNow.rightNow })).toBeVisible();
      // png/health-demo-1440.png, png/health-demo-390.png: four tiles, each a link.
      const cards = panel.getByRole("link");
      await expect(cards).toHaveCount(4);

      for (const tile of TILES) {
        const card = cards.filter({ hasText: tile.label });
        await expect(card).toHaveCount(1);
        // The value is the unread day's, which is what this session can count.
        await expect(card).toContainText(figure(tile.count, tile.outOf));
        await expect(card).toHaveAttribute("href", TILE_LINKS[tile.key]);
      }

      // Firia ruling 2026-10-17: Vans checked agrees with Van setup.
      const vans = TILES.find((t) => t.key === "VANS_CHECKED");
      expect(vans?.count).toBe(READINESS.setup.checked);
      expect(vans?.outOf).toBe(READINESS.setup.total);
      await expect(cards.filter({ hasText: healthNow.vansChecked })).toContainText(
        figure(READINESS.setup.checked, READINESS.setup.total),
      );

      // png/health-demo-1440.png: title, tabs and date on one row.
      // png/health-demo-390.png: title and date on row 1; png/today-saved-390.png: tabs and
      // Morning | Afternoon on row 2. The date does not wrap under the tabs.
      const titleBox = await page.getByRole("heading", { level: 1, name: boardCopy.heading }).boundingBox();
      const dateBox = await page.locator("time").boundingBox();
      const healthBox = await healthTab.boundingBox();
      expect(titleBox).not.toBeNull();
      expect(dateBox).not.toBeNull();
      expect(healthBox).not.toBeNull();
      expect(Math.abs(titleBox!.y - dateBox!.y)).toBeLessThan(24);
      expect(dateBox!.x).toBeGreaterThan(titleBox!.x);
      if (width === 1440) {
        expect(Math.abs(titleBox!.y - healthBox!.y)).toBeLessThan(24);
        expect(dateBox!.x).toBeGreaterThan(healthBox!.x);
      } else {
        // The date stays on the title's row. It does not drop under the tabs.
        expect(dateBox!.y + dateBox!.height).toBeLessThanOrEqual(healthBox!.y + 4);
        expect(healthBox!.y).toBeGreaterThan(titleBox!.y + titleBox!.height / 2);
        const morning = page.getByRole("button", { name: planRoutes.directionButton.AM, exact: true });
        const morningBox = await morning.boundingBox();
        expect(morningBox).not.toBeNull();
        expect(Math.abs(morningBox!.y - healthBox!.y)).toBeLessThan(24);
      }

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
      await expect(page.getByRole("tabpanel", { name: healthNow.health }).getByRole("link")).toHaveCount(0);
    });

    // png/health-demo-1440.png, png/health-demo-390.png: the chevron opens that screen, and the menu stays.
    for (const tile of TILES) {
      test(`${tile.label} opens its screen and the menu stays`, async ({ page }) => {
        await page.goto("/today");
        await page.getByRole("tab", { name: healthNow.health }).click();
        await page.getByRole("tabpanel", { name: healthNow.health }).getByRole("link", { name: tile.label }).click();
        await expect(page).toHaveURL(new RegExp(TILE_LINKS[tile.key].replace("?", "\\?")));
        const menuName = width < 768 ? nav.menuLabel : nav.landmarkLabel;
        const menu = page.getByRole("navigation", { name: menuName });
        await expect(menu).toBeVisible();
        await expect(menu.getByRole("link", { name: nav.today })).toBeVisible();
      });
    }
  });
}
