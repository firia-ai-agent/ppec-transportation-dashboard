/**
 * S1 (Firia 7:55 AM ET, Veri's gate 8:08–8:09 AM ET): Morning | Afternoon is always on the board.
 *
 * MOCKUPS THIS FILE COVERS (team rule — every test names the picture it is about):
 *  - `/workspace/ppec-redesign/mockups/plan-board.html` + `png/plan-board.png` (1440) and
 *    `png/plan-board-390.png` (390): the board's toolbar on the header row — the date, the
 *    segmented Morning | Afternoon (Morning by default), the placed count and the save state.
 *
 * THE BUG. Reaching Plan routes through the menu (a client-side `<Link>` navigation) drew no
 * toolbar at all; a typed address was fine. Plan routes has its own layout, so the board and a new
 * header bar mount in the same commit, and src/ui/HeaderSlot.tsx looked the slot up once, before
 * that bar existed. Every walk below therefore arrives through the menu link, from Today, the Live
 * map and the Ramp iPad, at 390 and 1440, and counts the toolbar: exactly one, never none, never
 * two — including after five round trips and the browser's Back.
 *
 * Every label comes from src/ui/copy.ts. Written and typechecked; Veri runs it.
 */
import { expect, test, type Page } from "@playwright/test";
import { liveMap, nav, planBoard, planRoutes, rampIpad } from "../src/ui/copy";

const ROLE = (process.env.E2E_DEMO_ROLE ?? "DIRECTOR").toUpperCase();
const CONSOLE_ROLE = ROLE === "DIRECTOR" || ROLE === "COORDINATOR";

const WIDTHS = [
  { name: "390", viewport: { width: 390, height: 844 } },
  { name: "1440", viewport: { width: 1440, height: 900 } },
] as const;

/** Where the walks start, by the menu label that screen carries (src/ui/nav-items.ts). */
const FROM = [
  { path: "/today", label: nav.today },
  { path: "/live-map", label: liveMap.heading },
  { path: "/ramp-ipad", label: rampIpad.heading },
] as const;

const TOOLBAR = "[data-header-slot] [data-placed]";
const morning = (page: Page) => page.getByRole("link", { name: planBoard.morning, exact: true });
const afternoon = (page: Page) => page.getByRole("link", { name: planBoard.afternoon, exact: true });
const placedPattern = new RegExp(
  planBoard.placed.replace("{n}", "\\d+").replace("{total}", "\\d+"),
);

/** The menu's own link to a screen, whichever menu this width draws (rail or tab bar). */
async function viaMenu(page: Page, path: string, label: string) {
  const link = page.locator(`a[data-nav-item][href="${path}"]`).filter({ visible: true }).first();
  await expect(link).toBeVisible();
  await expect(link).toHaveAccessibleName(new RegExp(label));
  await link.click();
  await expect(page).toHaveURL(new RegExp(`${path}(\\?|$)`));
}

/** One toolbar, both segments fully on screen, and the given leg current. */
async function expectToolbar(page: Page, current: "AM" | "PM") {
  await expect(page.locator(TOOLBAR)).toHaveCount(1);
  await expect(page.locator(TOOLBAR)).toHaveText(placedPattern);
  await expect(page.locator("[data-header-slot] [data-save-state]")).toHaveCount(1);
  for (const segment of [morning(page), afternoon(page)]) {
    await expect(segment).toHaveCount(1);
    await expect(segment).toBeInViewport({ ratio: 1 });
  }
  const [on, off] = current === "AM" ? [morning(page), afternoon(page)] : [afternoon(page), morning(page)];
  await expect(on).toHaveAttribute("aria-current", "page");
  await expect(off).not.toHaveAttribute("aria-current", "page");
}

test.describe("plan-board.png: the toolbar after a menu navigation", () => {
  test.skip(!CONSOLE_ROLE, "Plan routes is a console screen");

  for (const { name, viewport } of WIDTHS) {
    for (const from of FROM) {
      test(`${from.label} -> menu -> ${planRoutes.heading} at ${name}: one toolbar, ${planBoard.morning} current`, async ({ page }) => {
        await page.setViewportSize(viewport);
        await page.goto(from.path);
        await viaMenu(page, "/plan-routes", planRoutes.heading);
        await expectToolbar(page, "AM");
      });
    }

    test(`${planBoard.afternoon} switches the leg at ${name}`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.goto("/today");
      await viaMenu(page, "/plan-routes", planRoutes.heading);
      await expectToolbar(page, "AM");
      await afternoon(page).click();
      await expect(page).toHaveURL(/[?&]leg=pm\b/);
      await expectToolbar(page, "PM");
      await morning(page).click();
      await expect(page).toHaveURL(/[?&]leg=am\b/);
      await expectToolbar(page, "AM");
    });

    test(`five round trips ${nav.today} <-> ${planRoutes.heading}, then Back, at ${name}: always exactly one toolbar`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.goto("/today");
      for (let i = 0; i < 5; i += 1) {
        await viaMenu(page, "/plan-routes", planRoutes.heading);
        await expectToolbar(page, "AM");
        await viaMenu(page, "/today", nav.today);
        await expect(page.locator(TOOLBAR)).toHaveCount(0);
      }
      await viaMenu(page, "/plan-routes", planRoutes.heading);
      await expectToolbar(page, "AM");
      await page.goBack();
      await expect(page).toHaveURL(/\/today(\?|$)/);
      await expect(page.locator(TOOLBAR)).toHaveCount(0);
      await page.goBack();
      await expect(page).toHaveURL(/\/plan-routes(\?|$)/);
      await expectToolbar(page, "AM");
    });
  }
});

test.describe("live-map.png: the Live map's own Morning | Afternoon after a menu navigation", () => {
  test.skip(!CONSOLE_ROLE, "the Live map is a console screen");

  for (const { name, viewport } of WIDTHS) {
    test(`${nav.today} -> menu -> ${liveMap.heading} at ${name}: its leg switch is drawn once`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.goto("/today");
      await viaMenu(page, "/live-map", liveMap.heading);
      await expect(page.locator("[data-header-slot]").getByRole("group", { name: liveMap.legLabel })).toHaveCount(1);
    });
  }
});
