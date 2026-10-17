/**
 * The order of the day, at the top of Today (redesign spec §9.2, §9.6 #2 and #5).
 *
 * Three steps — Van setup, Plan routes, Live map — each saying where it is in a word, each a link
 * to the screen that moves it on, and each changing when the thing behind it changes. That last
 * part is the whole point of §9.4's one shared helper: the strip is not a second opinion about
 * the day, it is the same `getDayReadiness` the board's banners and the server guards read.
 *
 * `describe.serial`: this walks a day forwards, the way a coordinator does.
 */
import { expect, test, type Page } from "@playwright/test";
import { flow } from "../src/ui/copy";
import { expectNoInternalCodes, shot } from "./helpers";

const strip = (page: Page) => page.getByRole("navigation", { name: flow.steps.aria });
const step = (page: Page, key: "setup" | "plan" | "live") => page.locator(`[data-day-step="${key}"]`);

test.describe.serial("§9.2: the three steps of the day", () => {
  test("says where the day is, with a word on every card", async ({ page }) => {
    await page.goto("/today");
    await expect(strip(page)).toBeVisible();
    await expect(page.locator("[data-day-step]")).toHaveCount(3);

    // Nothing confirmed on the ramp today, nothing planned, so the live map is locked behind it.
    await expect(step(page, "setup")).toContainText(flow.state.needed);
    await expect(step(page, "plan")).toContainText(flow.plan.detailNone);
    await expect(step(page, "live")).toContainText(flow.live.detailLocked);
    await expect(step(page, "live")).toContainText(flow.state.locked);
    // The first step that is not done is the current one, for a screen reader as well as an eye.
    await expect(step(page, "setup")).toHaveAttribute("aria-current", "step");
    await shot(page, "today-steps");
    await expectNoInternalCodes(page);
  });

  test("a step is a link to the screen that moves it on", async ({ page }) => {
    await page.goto("/today");
    await step(page, "plan").getByRole("link").click();
    await expect(page).toHaveURL(/\/plan-routes\?date=\d{4}-\d{2}-\d{2}&leg=(am|pm)/);
  });

  test("§9.6 #5: the order flips once a plan is saved", async ({ page }) => {
    await page.goto("/plan-routes");
    await expect(page.locator("[data-van]")).toHaveCount(3);
    await page.locator("[data-auto-plan]").click();
    await page.locator("[data-save]").click();
    await expect(page.locator("[data-save-state]")).toHaveText(/^Saved /);

    await page.goto("/today");
    await expect(step(page, "plan")).toContainText(/^Plan routesSaved \d{1,2}:\d{2} (AM|PM)Done$/);
    // With a plan saved, the live map is no longer locked — it is waiting for a van to move.
    await expect(step(page, "live")).toContainText(flow.live.detailNeeded);
    await expect(step(page, "live")).not.toContainText(flow.state.locked);
    await shot(page, "today-steps-planned");
  });

  test("§9.6 #5: confirming a van on the ramp moves the first step too", async ({ page }) => {
    await page.goto("/ramp-ipad");
    await page.locator("[data-confirm]").click();
    await expect(page.locator("[data-confirm]")).toContainText(/Checked/);

    await page.goto("/today");
    await expect(step(page, "setup")).toContainText("1/3 checked");
    await expect(step(page, "setup")).toContainText(flow.state.needed);
  });

  test("at 390 the three cards stay in one row", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/today");
    const boxes = await Promise.all(
      (await page.locator("[data-day-step]").all()).map((card) => card.boundingBox()),
    );
    expect(boxes).toHaveLength(3);
    for (const box of boxes) expect(box?.y).toBeCloseTo(boxes[0]?.y ?? 0, 0);
    await shot(page, "today-steps-390");
  });
});
