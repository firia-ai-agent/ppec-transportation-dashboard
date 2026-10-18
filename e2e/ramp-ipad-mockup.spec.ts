/**
 * THE RAMP iPAD AGAINST VERA'S MOCKUP, in a real browser at both review widths.
 *
 * The mockup is the authority for every assertion in this file:
 *   ppec-redesign/png/ramp-arrival.png      (1440)
 *   ppec-redesign/png/ramp-arrival-390.png  (390)
 *   ppec-redesign/mockups/ramp-arrival.html (the layout and the tokens)
 *
 * What the mockup says, and what production did instead (Vera's marked-up
 * ppec-visual-walk/feedback/prod-ramp-ipad-vs-mockup.png, and the room list of 7:50 AM ET):
 *
 *  1 Three van tabs in one row, in door order — Van 1, Van 2, Van 3 — each under a bar of its
 *    own colour with the time it leaves under the name. Production drew 1, 3, 2 (the order the
 *    vans leave) and wrapped them onto two rows at 390.
 *  2 One joined stepper per counter, a single box with the minus, the number and the plus in it.
 *  3 "Planned 3" under a counter's label, and the number cell amber when what was counted is
 *    below it.
 *  4 A coral banner naming the child the van has run out for, with Re-plan beside it, which
 *    **navigates** to the coordinator's board and writes nothing.
 *  6 At 390, Confirm pinned above the shell's bottom tab bar, never over it.
 *
 * DATA: the riders are the saved plan's, for the leg in the address (`?leg=am`), and the ramp
 * invents none — the Auto-plan fallback is gone (Firia's S1 ruling).
 *
 * One browser-check run is one role (`E2E_DEMO_ROLE`, playwright.config.ts). A front desk cannot
 * save a plan, and the ramp no longer shows one nobody saved, so on that role this file asserts
 * the screen the ruling specifies — the one line, with no link to a board they may not open —
 * and the mockup walk belongs to the roles that can plan.
 */
import { expect, test, type Locator, type Page } from "@playwright/test";
import { planBoard, vanArrival } from "../src/ui/copy";
import { boxOf, overlaps } from "./helpers";

const ROLE = (process.env.E2E_DEMO_ROLE ?? "DIRECTOR").toUpperCase();
const CONSOLE_ROLE = ROLE === "DIRECTOR" || ROLE === "COORDINATOR";

const WIDE = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

/** Its own service dates: the board and the ramp are stateful on one reused server. */
const DAY = {
  tabs: "2026-12-01",
  counters: "2026-12-02",
  wontFit: "2026-12-03",
  sticky: "2026-12-04",
  riders: "2026-12-05",
};

const LEG = "am";
const rampUrl = (day: string) => `/ramp-ipad?date=${day}&leg=${LEG}`;
const boardUrl = (day: string) => `/plan-routes?date=${day}&leg=${LEG}`;

const tabs = (page: Page): Locator => page.locator("[data-tab]");
const stepper = (page: Page, key: string): Locator => page.locator(`[data-stepper="${key}"]`);
const fewer = (page: Page, key: string): Locator => stepper(page, key).getByRole("button").first();
const more = (page: Page, key: string): Locator => stepper(page, key).getByRole("button").last();

test.beforeEach(async ({ page }) => {
  await page.setViewportSize(WIDE);
});

/** The plan the server has, through the read-only board route. Nothing here writes. */
async function savedPlan(
  page: Page,
  day: string,
): Promise<{ version: number; plan: Record<string, { bucket: string; vanId: string | null }> }> {
  const response = await page.request.get(`/api/plan?date=${day}&leg=${LEG}`);
  expect(response.status()).toBe(200);
  return (await response.json()) as {
    version: number;
    plan: Record<string, { bucket: string; vanId: string | null }>;
  };
}

/**
 * A saved morning for this day, made on the board the way a coordinator makes one: Auto-plan,
 * then Save. The ramp reads the saved plan and nothing else, so a walk has to be given one.
 */
async function planTheMorning(page: Page, day: string): Promise<void> {
  await page.goto(boardUrl(day));
  await expect(page.getByRole("heading", { name: planBoard.heading, level: 1 })).toBeVisible();
  const state = page.locator("[data-save-state]");
  if (!/^Saved /.test((await state.textContent()) ?? "")) {
    await page.locator("[data-auto-plan]").click();
    /*
     * Nobody waiting. The "✓ 0" chip is gone since Vera's check of b3453cd (png/plan-board.png
     * draws a count only while children are unplaced), so the column says it with the chip's
     * absence and its own green line.
     */
    await expect(page.locator("[data-unassigned-count]")).toHaveCount(0);
    await expect(page.locator('[data-role="unassigned"]')).toContainText(planBoard.allPlaced);
    await page.locator("[data-save]").click();
  }
  await expect(state).toHaveText(/^Saved /);
}

/** Open the ramp on a day with a saved morning; false when this role cannot make one. */
async function openRamp(page: Page, day: string): Promise<boolean> {
  if (!CONSOLE_ROLE) {
    await page.goto(rampUrl(day));
    await expect(page.locator("[data-no-plan]")).toHaveText(vanArrival.noPlanSaved);
    await expect(page.locator("[data-plan-routes]")).toHaveCount(0);
    return false;
  }
  await planTheMorning(page, day);
  await page.goto(rampUrl(day));
  await expect(tabs(page)).toHaveCount(3);
  return true;
}

/** The tokens of the riders listed on the open tab, in the order they are drawn. */
async function ridersOnScreen(page: Page): Promise<string[]> {
  return (await page.locator("[data-rider]").all()).reduce<Promise<string[]>>(
    async (soFar, row) => [...(await soFar), (await row.getAttribute("data-rider")) ?? ""],
    Promise.resolve([]),
  );
}

test.describe.serial("the ramp iPad, as ramp-arrival.png draws it", () => {
  test("1 · three van tabs in one row, 1-2-3, at 1440 and at 390", async ({ page }) => {
    if (!(await openRamp(page, DAY.tabs))) return;

    for (const size of [WIDE, PHONE]) {
      await page.setViewportSize(size);
      await page.goto(rampUrl(DAY.tabs));
      await expect(tabs(page)).toHaveCount(3);

      // Door order, which is not the order the vans leave (ramp-arrival.html's three `.vtab`).
      await expect(tabs(page).nth(0)).toContainText("Van 1");
      await expect(tabs(page).nth(1)).toContainText("Van 2");
      await expect(tabs(page).nth(2)).toContainText("Van 3");

      // ONE row: every tab shares a top edge, and none of them has wrapped under another.
      const boxes = await Promise.all((await tabs(page).all()).map((tab) => boxOf(tab)));
      for (const box of boxes) expect(Math.abs(box.y - boxes[0].y)).toBeLessThanOrEqual(2);
      expect(boxes[0].x).toBeLessThan(boxes[1].x);
      expect(boxes[1].x).toBeLessThan(boxes[2].x);

      // Each one says when its van leaves, under the name (the mockup's `.vtab small`).
      await expect(tabs(page).nth(1)).toContainText(/Leaves \d{1,2}:\d{2} (AM|PM)/);
      // The one being counted is marked by more than its colour.
      await expect(page.locator('[data-tab][aria-current="page"]')).toHaveCount(1);
    }
    await page.setViewportSize(WIDE);
  });

  test("2 · one joined stepper per counter, a thumb's height", async ({ page }) => {
    if (!(await openRamp(page, DAY.counters))) return;

    for (const key of ["seats", "wheelchairSpots", "carSeats", "oxygenMounts"]) {
      const minus = await boxOf(fewer(page, key));
      const plus = await boxOf(more(page, key));
      const value = await boxOf(stepper(page, key).locator("output"));

      // §9's ramp target, and the work order's 44 px floor: the box is one height throughout.
      expect(minus.height, `${key} minus`).toBeGreaterThanOrEqual(44);
      expect(Math.abs(plus.height - minus.height)).toBeLessThanOrEqual(1);
      expect(Math.abs(value.height - minus.height)).toBeLessThanOrEqual(1);

      // JOINED: minus, number, plus, touching, in that order (the mockup's `.st`).
      expect(minus.x).toBeLessThan(value.x);
      expect(value.x).toBeLessThan(plus.x);
      expect(value.x - (minus.x + minus.width)).toBeLessThanOrEqual(2);
      expect(plus.x - (value.x + value.width)).toBeLessThanOrEqual(2);
      expect(Math.abs(value.y - minus.y)).toBeLessThanOrEqual(1);
    }
  });

  test("3 · Planned N under every counter, and the cell goes amber under it", async ({ page }) => {
    if (!(await openRamp(page, DAY.counters))) return;

    await expect(page.locator("[data-planned]")).toHaveCount(4);
    await expect(page.locator('[data-planned="carSeats"]')).toHaveText(/^Planned \d+$/);
    // Never the old words: nothing on this screen compares a count against a config default.
    await expect(page.getByText(/Default \d/)).toHaveCount(0);

    const carSeats = stepper(page, "carSeats");
    const planned = Number(
      /Planned (\d+)/.exec((await carSeats.locator("[data-planned]").innerText()) ?? "")?.[1],
    );
    expect(Number.isFinite(planned)).toBe(true);

    // Count down to one under what the plan needs: that is when the cell turns amber.
    while (Number(await carSeats.locator("output").innerText()) > planned) {
      await fewer(page, "carSeats").click();
    }
    await expect(carSeats).toHaveAttribute("data-short", "false");
    await fewer(page, "carSeats").click();
    await expect(carSeats).toHaveAttribute("data-short", "true");

    // Amber is `warn-bg` on the value cell, which is the mockup's `.st.chg b`.
    const cell = carSeats.locator("output");
    const background = await cell.evaluate((node) => getComputedStyle(node).backgroundColor);
    expect(background).toBe("rgb(254, 249, 195)");

    // Putting it back clears it.
    await more(page, "carSeats").click();
    await expect(carSeats).toHaveAttribute("data-short", "false");
  });

  test("4 · one car seat short: the coral banner, and Re-plan only navigates", async ({ page }) => {
    if (!(await openRamp(page, DAY.wontFit))) return;
    const before = await savedPlan(page, DAY.wontFit);

    // Find the van that is carrying somebody who needs a car seat, and take one away.
    let banner = page.locator("[data-shortfall]");
    for (const tab of await tabs(page).all()) {
      await tab.click();
      await expect(page.locator("[data-rider]").first()).toBeVisible();
      const carSeats = stepper(page, "carSeats");
      const start = Number(await carSeats.locator("output").innerText());
      for (let i = 0; i < start; i += 1) {
        if (await banner.count()) break;
        await fewer(page, "carSeats").click();
      }
      if (await banner.count()) break;
    }
    await expect(banner).toBeVisible();

    // The whole line the mockup draws: "Mia R. won't fit · 1 car seat short".
    const said = await banner.getAttribute("data-shortfall");
    expect(said).toMatch(/^.+ won’t fit · \d+ (car seat|seat|wheelchair spot|oxygen mount)s? short$/);
    await expect(banner).toContainText(/won’t fit/);
    // Coral: the crit pair on the banner, and a chip naming the gap on the row it costs.
    expect(await banner.evaluate((node) => getComputedStyle(node).backgroundColor)).toBe(
      "rgb(254, 226, 226)",
    );
    await expect(page.locator('[data-rider][data-fits="false"]')).toHaveCount(1);
    await expect(page.locator('[data-verdict="CAR_SEAT"]').first()).toContainText("Car seat");

    // Re-plan is a link to the board for this date, leg and van — and nothing else happens.
    const replan = page.locator("[data-replan]");
    await expect(replan).toHaveText(vanArrival.replan);
    await expect(replan).toHaveAttribute(
      "href",
      new RegExp(`/plan-routes\\?date=${DAY.wontFit}&leg=${LEG}&van=`),
    );
    await replan.click();
    await page.waitForURL(/\/plan-routes\?/);
    await expect(page.getByRole("heading", { name: planBoard.heading, level: 1 })).toBeVisible();

    // Nothing was written: the same version, and the same placements.
    const after = await savedPlan(page, DAY.wontFit);
    expect(after.version).toBe(before.version);
    expect(after.plan).toEqual(before.plan);
  });

  test("6 · at 390 Confirm is pinned above the tab bar and never over it", async ({ page }) => {
    if (!(await openRamp(page, DAY.sticky))) return;
    await page.setViewportSize(PHONE);
    await page.goto(rampUrl(DAY.sticky));

    const bar = page.getByRole("navigation").last();
    await expect(bar).toBeVisible();
    const barBox = await boxOf(bar);
    expect(barBox.height).toBeGreaterThanOrEqual(64);

    const confirm = page.locator("[data-confirm]");
    await expect(confirm).toBeVisible();
    const confirmBox = await boxOf(confirm);
    expect(confirmBox.height).toBeGreaterThanOrEqual(44);
    expect(overlaps(confirmBox, barBox), "Confirm sits over the tab bar").toBe(false);
    expect(confirmBox.y + confirmBox.height).toBeLessThanOrEqual(barBox.y + 1);

    // Pinned: it is still there, and still clear of the bar, at the foot of the riders.
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(300);
    const scrolled = await boxOf(confirm);
    await expect(confirm).toBeVisible();
    expect(overlaps(scrolled, await boxOf(bar))).toBe(false);
    // And the last rider can be scrolled clear of both.
    const lastRider = page.locator("[data-rider]:visible").last();
    if (await lastRider.count()) {
      expect((await boxOf(lastRider)).y + (await boxOf(lastRider)).height).toBeLessThanOrEqual(
        scrolled.y + 1,
      );
    }
    await page.setViewportSize(WIDE);
  });

  test("DATA · the riders for ?leg=am are the ones the saved morning put there", async ({ page }) => {
    if (!(await openRamp(page, DAY.riders))) return;
    const saved = await savedPlan(page, DAY.riders);

    let seen = 0;
    for (const tab of await tabs(page).all()) {
      const vanId = await tab.getAttribute("data-tab");
      await tab.click();
      await expect(page.locator('[data-tab][aria-current="page"]')).toHaveAttribute(
        "data-tab",
        vanId ?? "",
      );
      const expected = Object.entries(saved.plan)
        .filter(([, placement]) => placement.bucket === "VAN" && placement.vanId === vanId)
        .map(([token]) => token)
        .sort();
      expect((await ridersOnScreen(page)).sort(), `the riders on ${vanId}`).toEqual(expected);
      seen += expected.length;
    }
    // The point of the check: the saved morning really does put children on these vans.
    expect(seen).toBeGreaterThan(5);
  });
});
