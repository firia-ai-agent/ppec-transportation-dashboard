/**
 * S1 (Firia 7:55 AM ET): Morning | Afternoon is always visible on the default /plan-routes.
 *
 * MOCKUPS THIS FILE COVERS:
 *  - `/workspace/ppec-redesign/mockups/plan-board.html` + `png/plan-board.png` (1440) and
 *    `png/plan-board-390.png` (390): the segmented Morning | Afternoon on the header row.
 *
 * Firia found the switch missing on the default address (no `leg=`) at 1280. Two causes, both
 * fixed: the header slot was looked up once and stayed empty after a soft navigation
 * (src/ui/HeaderSlot.tsx), and the row scrolled sideways with `.segmented` free to shrink to 0
 * (board.module.css `.toolbar`). So each width is walked both ways in: typed, and from the menu.
 * Each test sets up its own state.
 */
import { expect, test, type Page } from "@playwright/test";
import { planBoard } from "../src/ui/copy";

const ROLE = (process.env.E2E_DEMO_ROLE ?? "DIRECTOR").toUpperCase();
const CONSOLE_ROLE = ROLE === "DIRECTOR" || ROLE === "COORDINATOR";

const WIDTHS = [
  { width: 390, height: 844 },
  { width: 768, height: 1024 },
  { width: 1024, height: 768 },
  { width: 1280, height: 800 },
  { width: 1440, height: 900 },
];

async function expectToggleInView(page: Page, viewport: { width: number; height: number }) {
  const morning = page.locator('a[data-leg="AM"]');
  const afternoon = page.locator('a[data-leg="PM"]');
  for (const segment of [morning, afternoon]) {
    await expect(segment).toBeVisible();
    await expect(segment).toBeInViewport({ ratio: 1 });
    const box = await segment.boundingBox();
    expect(box && box.width).toBeGreaterThan(40);
    expect(box && box.x + box.width).toBeLessThanOrEqual(viewport.width);
  }
  await expect(morning).toHaveText(new RegExp(planBoard.morning));
  await expect(afternoon).toHaveText(new RegExp(planBoard.afternoon));
}

test.describe("plan-board.png: Morning | Afternoon on the default board", () => {
  test.skip(!CONSOLE_ROLE, "Plan routes is a console screen");

  for (const viewport of WIDTHS) {
    test(`typed /plan-routes at ${viewport.width}: both segments in view, Morning current`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.goto("/plan-routes");
      await expectToggleInView(page, viewport);
      await expect(page.locator('a[data-leg="AM"]')).toHaveAttribute("aria-current", "page");
      await expect(page.locator('a[data-leg="PM"]')).not.toHaveAttribute("aria-current", "page");
    });

    test(`from the menu at ${viewport.width}: the toggle is drawn after a soft navigation`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.goto("/today");
      await page.locator('a[href="/plan-routes"]').first().click();
      await expect(page).toHaveURL(/\/plan-routes(\?|$)/);
      await expectToggleInView(page, viewport);
    });
  }

  test("clicking Afternoon switches to leg=pm, and Morning back to leg=am", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/plan-routes");
    await page.locator('a[data-leg="PM"]').click();
    await expect(page).toHaveURL(/[?&]leg=pm\b/);
    await expect(page.locator('a[data-leg="PM"]')).toHaveAttribute("aria-current", "page");
    await page.locator('a[data-leg="AM"]').click();
    await expect(page).toHaveURL(/[?&]leg=am\b/);
    await expect(page.locator('a[data-leg="AM"]')).toHaveAttribute("aria-current", "page");
  });
});
