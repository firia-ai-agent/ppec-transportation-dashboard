/**
 * The ramp iPad's van arrival, in a real browser (redesign spec §2, demo goal 2).
 *
 * The walk is the one the founder is shown: a van pulls in, the front desk counts what is on it,
 * a child no longer fits, and the shortfall is named with the way out beside it — then Confirm,
 * which is what tomorrow starts from and what makes the van read "Checked" on the coordinator's
 * board today.
 *
 * It plans and saves the day itself first, because the riders beside the steppers are the saved
 * plan's (§9.3: with no plan saved the card says so instead). `describe.serial` for the same
 * reason the board's spec is: this is one story about one stateful screen.
 *
 * The server runs with the test-only synthetic session and no database (playwright.config.ts), so
 * the store is the memory fallback; the SQL the same calls make is asserted against the real
 * migrations in src/modules/plan/sql.test.ts.
 */
import { expect, test, type Locator, type Page } from "@playwright/test";
import { planBoard, vanArrival } from "../src/ui/copy";
import { expectDemoBarPinned, expectNoInternalCodes, expectVioletOnlyOnDemoChrome, shot } from "./helpers";

const RAMP = "/ramp-ipad";

/** The child on the afternoon's first van who needs a car seat (the synthetic day's own). */
const CAR_SEAT_CHILD = "Mia R.";

const stepper = (page: Page, key: string): Locator => page.locator(`[data-stepper="${key}"]`);
const fewer = (page: Page, key: string): Locator => stepper(page, key).getByRole("button").first();

/** The van tab that is open. */
const openTab = (page: Page): Locator => page.locator('[data-tab][aria-current="page"]');

async function planTheDay(page: Page): Promise<void> {
  await page.goto("/plan-routes");
  await expect(page.locator("[data-van]")).toHaveCount(3);
  if ((await page.locator("[data-unassigned-count]").innerText()) !== "0") {
    await page.locator("[data-auto-plan]").click();
  }
  if (await page.locator("[data-save]").isEnabled()) {
    await page.locator("[data-save]").click();
  }
  await expect(page.locator("[data-save-state]")).toHaveText(/^Saved /);
}

test.describe.serial("§2: what is on the van that just arrived", () => {
  test("the day is planned and saved, so the ramp has riders to check", async ({ page }) => {
    await planTheDay(page);
  });

  test("opens on the first van to leave, pre-filled with what the plan had", async ({ page }) => {
    await page.goto(RAMP);
    await expect(page.getByRole("heading", { level: 1, name: vanArrival.heading })).toBeVisible();
    // One tab per van, each saying when it leaves, and the open one marked by more than colour.
    await expect(page.locator("[data-tab]")).toHaveCount(3);
    await expect(openTab(page)).toHaveCount(1);
    await expect(openTab(page)).toContainText(/Leaves \d{1,2}:\d{2} (AM|PM)/);

    // The counts are the plan's, so nothing starts at zero and nobody has to re-enter a van.
    await expect(stepper(page, "seats").locator("output")).not.toHaveText("0");
    await expect(page.getByText(vanArrival.tomorrow)).toBeVisible();
    // Every rider the plan put on this van, each with a verdict in words.
    await expect(page.locator("[data-verdict]").first()).toContainText(vanArrival.fits);
    await shot(page, "ramp-arrival");
  });

  test("one car seat fewer: the child who needs it is named, and how short the van is", async ({ page }) => {
    await page.goto(RAMP);
    // Find the van carrying the child who needs a car seat, since the plan decides which it is.
    for (const tab of await page.locator("[data-tab]").all()) {
      await tab.click();
      if (await page.locator("[data-rider]").filter({ hasText: CAR_SEAT_CHILD }).count()) break;
    }
    await expect(page.locator("[data-rider]").filter({ hasText: CAR_SEAT_CHILD })).toHaveCount(1);

    // Take car seats down until the van is short of one.
    const carSeats = stepper(page, "carSeats");
    await expect(carSeats).toHaveAttribute("data-changed", "false");
    await fewer(page, "carSeats").click();
    await expect(carSeats).toHaveAttribute("data-changed", "true");
    // What the plan had is said under the label, now that the count differs from it.
    await expect(carSeats).toContainText(/Planned \d/);

    const banner = page.locator("[data-shortfall]");
    await expect(banner).toBeVisible();
    await expect(banner).toContainText(/won’t fit/);
    await expect(banner).toContainText(/\d+ car seats? short/);
    // A child who no longer fits says which thing is missing, in one word.
    await expect(page.locator('[data-verdict="CAR_SEAT"]')).toHaveCount(1);
    await shot(page, "ramp-arrival-short");

    // Re-plan hands the leg to a coordinator rather than moving anybody here.
    const replan = page.locator("[data-replan]");
    await expect(replan).toHaveText(vanArrival.replan);
    await expect(replan).toHaveAttribute("href", /\/plan-routes\?date=\d{4}-\d{2}-\d{2}&leg=pm&van=/);
  });

  test("Confirm writes what arrived, and the board says the van is checked", async ({ page }) => {
    await page.goto(RAMP);
    const vanName = (await openTab(page).locator("span").first().innerText()).trim();
    // One seat fewer than the plan: something real to confirm.
    await fewer(page, "seats").click();
    const seats = await stepper(page, "seats").locator("output").innerText();

    await page.locator("[data-confirm]").click();
    await expect(page.locator("[data-confirm]")).toHaveText(planBoard.checked);

    // The coordinator's board now reads this van as checked, with the counts the ramp gave it.
    await page.goto("/plan-routes?leg=pm");
    const column = page.locator("[data-van]").filter({ hasText: vanName }).first();
    await expect(column.locator("[data-checked]")).toHaveText(planBoard.checked);
    await expect(column.locator('[data-counter="seats"]')).toContainText(`/${seats}`);
    await shot(page, "plan-board-van-checked");
  });

  test("the DEMO bar, the Simulated chip, and no internal code anywhere", async ({ page }) => {
    await page.goto(RAMP);
    await expectDemoBarPinned(page);
    await expectVioletOnlyOnDemoChrome(page);
    await expectNoInternalCodes(page);
    await expect(page.getByText(/\d+WC\/\d+A/)).toHaveCount(0);
  });

  test("at 390: the cards stack and every control is still a thumb wide", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(RAMP);
    await expect(page.getByRole("heading", { level: 1, name: vanArrival.heading })).toBeVisible();
    const confirm = page.locator("[data-confirm]");
    const box = await confirm.boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(56);
    await shot(page, "ramp-arrival-390");
  });
});
