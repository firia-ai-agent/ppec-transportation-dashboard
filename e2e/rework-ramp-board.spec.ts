/**
 * Rework 2 in a real browser: the ramp iPad's arrival counters (§2) and the plan board (§1).
 *
 * One walk per role, because one browser-check run is one role: the server is started with
 * `E2E_DEMO_ROLE` (playwright.config.ts), so this file reads that role and runs the half of the
 * story that role can see — all three see the ramp, the two console roles see the board, and the
 * front desk is refused it twice over (no page, and a 403 from the endpoint).
 *
 * Every screenshot lands in `artifacts/rework-ramp-board/<role>-<screen>-<width>.png`, at both
 * review widths, so the design review has the picture beside the assertion and can lay it over
 * the mockups in ppec-redesign/png/.
 *
 * No database and no credentials. On this server the board's store is the memory fallback
 * (src/modules/plan/memory.ts), which starts from exactly what a reset writes: **no** van setup
 * and no plan, so every column opens on "Using default setup" (Firia/Veri, 2026-10-17 6:00 PM
 * ET). The SQL a deployment runs instead is asserted against the real migrations in
 * src/modules/plan/sql.test.ts.
 */
import { mkdirSync } from "node:fs";
import path from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { flow, planBoard, vanArrival } from "../src/ui/copy";
import {
  ARTIFACTS,
  boxOf,
  expectDemoBarPinned,
  expectNoInternalCodes,
  expectVioletOnlyOnDemoChrome,
} from "./helpers";

const ROLE = (process.env.E2E_DEMO_ROLE ?? "DIRECTOR").toUpperCase();
/** The word that goes in a file name: `director`, `coordinator`, `frontdesk`. */
const WHO = ROLE.toLowerCase().replace(/_/g, "");
const CONSOLE_ROLE = ROLE === "DIRECTOR" || ROLE === "COORDINATOR";

const WIDE = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

/**
 * Each walk gets its own service date. The board and the ramp are **stateful** screens on one
 * reused server, so a van confirmed by one test would change what the next one opens on; a date
 * is a URL parameter (§9.3) and a day nobody has touched reads the same way every run.
 */
const DAY = {
  ramp: "2026-11-04",
  wontFit: "2026-11-05",
  confirm: "2026-11-06",
  board: "2026-11-07",
  empty: "2026-11-08",
  drag: "2026-11-09",
  keyboard: "2026-11-10",
  save: "2026-11-11",
  refusal: "2026-11-12",
};

/*
 * The project's device preset brings its own 1280 × 720 viewport, so every test starts by
 * setting the wide review width explicitly — a screenshot named 1440 has to be one.
 */
test.beforeEach(async ({ page }) => {
  await page.setViewportSize(WIDE);
});

const rampUrl = (day: string) => `/ramp-ipad?date=${day}`;
const boardUrl = (day: string) => `/plan-routes?date=${day}&leg=pm`;

/** The review screenshots this PR is gated on, named for the role and the width. */
async function review(page: Page, screen: string): Promise<void> {
  const dir = path.join(ARTIFACTS, "rework-ramp-board");
  mkdirSync(dir, { recursive: true });
  const width = page.viewportSize()?.width ?? WIDE.width;
  await page.screenshot({ path: path.join(dir, `${WHO}-${screen}-${width}.png`), fullPage: false });
}

/** Take the same shot at both review widths, leaving the page back at 1440. */
async function reviewBoth(page: Page, screen: string, go: () => Promise<void>): Promise<void> {
  for (const size of [WIDE, PHONE]) {
    await page.setViewportSize(size);
    await go();
    await review(page, screen);
  }
  await page.setViewportSize(WIDE);
}

/* ───────────────────────────── the ramp ───────────────────────────── */

const stepper = (page: Page, key: string): Locator => page.locator(`[data-stepper="${key}"]`);
const fewer = (page: Page, key: string): Locator => stepper(page, key).getByRole("button").first();
const openTab = (page: Page): Locator => page.locator('[data-tab][aria-current="page"]');

/** The van tab carrying a named child, so a test does not depend on which van the day picked. */
async function tabWith(page: Page, child: string): Promise<void> {
  for (const tab of await page.locator("[data-tab]").all()) {
    await tab.click();
    await expect(page.locator("[data-rider]").first()).toBeVisible();
    if (await page.locator("[data-rider]").filter({ hasText: child }).count()) return;
  }
  throw new Error(`no van is carrying ${child}`);
}

test.describe.serial("§2: the van that just arrived", () => {
  test("opens on a van, pre-filled, with the riders it would carry", async ({ page }) => {
    await page.goto(rampUrl(DAY.ramp));
    await expect(page.getByRole("heading", { level: 1, name: vanArrival.heading })).toBeVisible();
    // One tab per van, each saying when it leaves, and the open one marked by more than colour.
    await expect(page.locator("[data-tab]")).toHaveCount(3);
    await expect(openTab(page)).toHaveCount(1);
    await expect(openTab(page)).toContainText(/Leaves \d{1,2}:\d{2} (AM|PM)/);

    // The counters open on the van's own numbers, not on zero, so nobody re-enters a van.
    await expect(stepper(page, "seats").locator("output")).not.toHaveText("0");
    for (const key of ["seats", "wheelchairSpots", "carSeats", "oxygenMounts"]) {
      await expect(stepper(page, key)).toHaveAttribute("data-changed", "false");
    }
    // Nothing on this screen says a count was "planned", and nothing promises tomorrow.
    await expect(page.getByText(/Planned \d/)).toHaveCount(0);
    await expect(page.getByText(/Tomorrow starts/i)).toHaveCount(0);

    // Vera's differences list, item 3: the riders card is populated with no saved plan, so the
    // check is walkable on a fresh day.
    await expect(page.locator("[data-rider]").first()).toBeVisible();
    await expect(page.locator("[data-verdict]").first()).toContainText(vanArrival.fits);
  });

  test("the review shots of the ramp, at both widths", async ({ page }) => {
    await reviewBoth(page, "ramp", async () => {
      await page.goto(rampUrl(DAY.ramp));
      await expect(page.locator("[data-rider]").first()).toBeVisible();
    });
  });

  test("one car seat fewer, and the child who needs it is named with the way out", async ({ page }) => {
    await page.goto(rampUrl(DAY.wontFit));
    await tabWith(page, "Mia R.");

    const carSeats = stepper(page, "carSeats");
    const before = await carSeats.locator("output").innerText();
    await expect(page.locator("[data-shortfall]")).toHaveCount(0);

    // Count down to one car seat short of what is aboard: the verdicts change live.
    for (let i = 0; i < Number(before); i += 1) {
      if (await page.locator("[data-shortfall]").count()) break;
      await fewer(page, "carSeats").click();
    }
    await expect(carSeats).toHaveAttribute("data-changed", "true");
    // The hint under a changed counter names the van's default, and never calls it "Planned".
    await expect(carSeats).toContainText(/Default \d/);

    const banner = page.locator("[data-shortfall]");
    await expect(banner).toBeVisible();
    await expect(banner).toContainText(/won’t fit/);
    await expect(banner).toContainText(/\d+ car seats? short/);
    await expect(page.locator('[data-verdict="CAR_SEAT"]').first()).toBeVisible();

    // Re-plan hands the leg to a coordinator rather than moving anybody here — and the front
    // desk, who cannot open the board, is offered no link to it (§9.3).
    const replan = page.locator("[data-replan]");
    if (CONSOLE_ROLE) {
      await expect(replan).toHaveText(vanArrival.replan);
      await expect(replan).toHaveAttribute("href", /\/plan-routes\?date=\d{4}-\d{2}-\d{2}&leg=pm&van=/);
    } else {
      await expect(replan).toHaveCount(0);
    }

    await review(page, "ramp-wontfit");
    await page.setViewportSize(PHONE);
    await review(page, "ramp-wontfit");
    await page.setViewportSize(WIDE);
  });

  test("Confirm writes CHECKED, and a reload says so", async ({ page }) => {
    await page.goto(rampUrl(DAY.confirm));
    const vanName = (await openTab(page).locator("span").first().innerText()).trim();
    await fewer(page, "seats").click();
    const seats = await stepper(page, "seats").locator("output").innerText();

    await page.locator("[data-confirm]").click();
    await expect(page.locator("[data-confirm]")).toHaveText(vanArrival.confirmed);

    // A reload reads the row back: the counts are the ramp's, and the van is confirmed.
    await page.reload();
    await expect(stepper(page, "seats").locator("output")).toHaveText(seats);
    await expect(page.locator("[data-confirm]")).toHaveText(vanArrival.confirmed);

    if (!CONSOLE_ROLE) return;
    // And the coordinator's board now reads that van as Checked rather than on its defaults.
    await page.goto(boardUrl(DAY.confirm));
    const column = page.locator("[data-van]").filter({ hasText: vanName }).first();
    await expect(column.locator("[data-checked]")).toHaveText(planBoard.checked);
    await expect(column.getByText(planBoard.usingDefault)).toHaveCount(0);
    await expect(column.locator('[data-counter="seats"]')).toContainText(`/${seats}`);
  });

  test("no internal code, no fixture date, and the DEMO bar is the only violet", async ({ page }) => {
    await page.goto(rampUrl(DAY.ramp));
    await expectDemoBarPinned(page);
    await expectVioletOnlyOnDemoChrome(page);
    await expectNoInternalCodes(page);
    await expectNoCodesOrOldDates(page);
  });

  test("at 390 the counters are still thumb-sized, with room for the tab bar", async ({ page }) => {
    await page.setViewportSize(PHONE);
    await page.goto(rampUrl(DAY.ramp));
    const confirm = page.locator("[data-confirm]");
    expect((await boxOf(confirm)).height).toBeGreaterThanOrEqual(56);
    for (const key of ["seats", "carSeats"]) {
      expect((await boxOf(fewer(page, key))).height).toBeGreaterThanOrEqual(56);
    }
    await expectRoomForTabBar(page);
  });
});

/* ───────────────────────────── the board ───────────────────────────── */

const vans = (page: Page): Locator => page.locator("[data-van]");
const card = (page: Page, name: string): Locator =>
  page.locator("[data-rider]").filter({ hasText: name }).first();
const announced = (page: Page): Locator => page.locator("[data-announce]");

async function openBoard(page: Page, day: string): Promise<void> {
  await page.goto(boardUrl(day));
  await expect(page.getByRole("heading", { name: planBoard.heading, level: 1 })).toBeVisible();
  await expect(vans(page)).toHaveCount(3);
}

/** A pointer drag dnd-kit accepts, in two halves so a test can read the screen mid-drag. */
async function liftOver(page: Page, child: Locator, target: Locator): Promise<void> {
  const from = await boxOf(child);
  const to = await boxOf(target);
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2 + 12, from.y + from.height / 2 + 12, { steps: 4 });
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 12 });
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2 + 4, { steps: 4 });
}

test.describe.serial("§1: the board a coordinator plans on", () => {
  test.skip(!CONSOLE_ROLE, "the board is not this role's screen");

  test("opens empty, on every van's default counts, and says so once per van", async ({ page }) => {
    await openBoard(page, DAY.empty);
    // Nothing is placed and nothing is saved on a day nobody has touched.
    await expect(page.locator("[data-save-state]")).toHaveText(planBoard.notSaved);
    await expect(page.locator("[data-rider]").first()).toBeVisible();
    // Firia/Veri 6:00 PM ET: one line per unconfirmed van, no button, and no "Not checked" chip.
    // (The board's own banner says the same words once more, over the columns, with the link to
    // the ramp beside it — so the count inside the columns is the one asserted here.)
    await expect(vans(page).getByText(planBoard.usingDefault)).toHaveCount(3);
    await expect(page.locator("[data-banner]")).toContainText(flow.banner.usingDefault);
    await expect(page.getByText("Not checked")).toHaveCount(0);
    await expect(page.getByText(/yesterday/i)).toHaveCount(0);
    // The board reads counts and never writes them: no ⚙, no popover, no Apply.
    await expect(page.locator("[data-setup-button]")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /setup/i })).toHaveCount(0);

    await review(page, "board-empty");
    await page.setViewportSize(PHONE);
    await expectRoomForTabBar(page);
    await review(page, "board-empty");
    await page.setViewportSize(WIDE);
  });

  test("a count chip is the way to the ramp, on that van", async ({ page }) => {
    await openBoard(page, DAY.empty);
    const chip = vans(page).first().locator('[data-counter="seats"]');
    await expect(chip).toContainText(/Seats \d+\/\d+/);
    await expect(chip).toHaveAttribute("href", /\/ramp-ipad\?date=\d{4}-\d{2}-\d{2}&leg=pm&van=/);
  });

  test("a chair over the van with no spot is refused, and the card goes back", async ({ page }) => {
    await openBoard(page, DAY.drag);
    await page.locator("[data-auto-plan]").click();
    const vanThree = vans(page).nth(2);
    const before = await vanThree.locator("[data-rider]").count();

    // Noah O. rides in his own chair; Van 3 has no wheelchair spot and no lift.
    await liftOver(page, card(page, "Noah O."), vanThree);
    await expect(vanThree).toHaveAttribute("data-fit", "no");
    await expect(vanThree.locator("[data-reject-chip]")).toHaveText(planBoard.reject.WHEELCHAIR);
    await review(page, "board-dragreject");
    await page.mouse.up();

    // Nothing moved, and the refusal was said as a sentence rather than only drawn.
    await expect(vanThree.locator("[data-rider]")).toHaveCount(before);
    await expect(announced(page)).toContainText("Noah O.");
    await expect(announced(page)).toContainText(planBoard.rejectThing.WHEELCHAIR);

    /*
     * The same refusal at 390, where there is no cross-column drag to make: a phone moves a
     * child with `Move to…` (§9.3), and the refusal comes back the same way — nobody moves, and
     * the reason is announced. The shot is the phone's rendering of that refusal.
     */
    await page.setViewportSize(PHONE);
    await page.reload();
    // Nobody is placed yet on a fresh load, so Noah O. is in the Unassigned column, which is the
    // one a phone opens on — no switching, and the card is on screen to act on.
    const noah = card(page, "Noah O.");
    const token = await noah.getAttribute("data-rider");
    // At 390 the `Move to…` select is on every card already (§9.3), so it is used directly:
    // the right-click that reveals it on a wide screen is a pointer affordance, not the control.
    const vanThreeName = await vans(page).nth(2).getAttribute("aria-label");
    await page.locator(`[data-move-to="${token}"]`).selectOption({ label: vanThreeName ?? "Van 3" });
    await expect(announced(page)).toContainText(planBoard.rejectThing.WHEELCHAIR);
    await review(page, "board-dragreject");
    await page.setViewportSize(WIDE);
  });

  test("the same drag onto a van that can take him lands", async ({ page }) => {
    await openBoard(page, DAY.drag);
    const target = vans(page).nth(1);
    const before = await target.locator("[data-rider]").count();
    const noah = card(page, "Noah O.");
    await liftOver(page, noah, target);
    await expect(target).toHaveAttribute("data-fit", "yes");
    await page.mouse.up();
    await expect(target.locator("[data-rider]").filter({ hasText: "Noah O." })).toHaveCount(1);
    expect(await target.locator("[data-rider]").count()).toBeGreaterThan(before);
    await expect(page.locator("[data-toast]")).toContainText("Noah O.");
  });

  test("a child placed from the keyboard alone", async ({ page }) => {
    await openBoard(page, DAY.keyboard);
    const zoe = card(page, "Zoe B.");
    await zoe.focus();
    await page.keyboard.press("Space");
    for (let i = 0; i < 12; i += 1) await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Space");
    // Wherever the sensor landed her, she is in a van and the move was announced in words.
    await expect(page.locator('[data-van] [data-rider]').filter({ hasText: "Zoe B." })).toHaveCount(1);
    await expect(announced(page)).toContainText("Zoe B.");
  });

  test("Auto-plan, Save, reload — the same plan, with the minute it was kept", async ({ page }) => {
    await openBoard(page, DAY.save);
    await page.locator("[data-auto-plan]").click();
    await expect(page.locator("[data-unassigned-count]")).toHaveText("0");
    const placed = await page.locator("[data-van] [data-rider]").allInnerTexts();

    await page.locator("[data-save]").click();
    await expect(page.locator("[data-save-state]")).toHaveText(/^Saved /);
    await review(page, "board");
    await page.setViewportSize(PHONE);
    await review(page, "board");
    await page.setViewportSize(WIDE);

    await page.reload();
    await expect(page.locator("[data-save-state]")).toHaveText(/^Saved /);
    expect(await page.locator("[data-van] [data-rider]").allInnerTexts()).toEqual(placed);
  });

  test("no internal code, no fixture date, and the DEMO bar is the only violet", async ({ page }) => {
    await openBoard(page, DAY.save);
    await expectDemoBarPinned(page);
    await expectVioletOnlyOnDemoChrome(page);
    await expectNoInternalCodes(page);
    await expectNoCodesOrOldDates(page);
  });

  test("at 390: one column at a time, and the map does not cover the rider cards", async ({ page }) => {
    await page.setViewportSize(PHONE);
    await openBoard(page, DAY.board);
    await page.locator("[data-auto-plan]").click();
    // The switcher picks the column; only one is on screen.
    const switcher = page.getByRole("tablist");
    await expect(switcher).toBeVisible();
    await switcher.getByRole("tab").nth(1).click();
    const shown = page.locator('[data-van][data-shown="true"]');
    await expect(shown).toHaveCount(1);

    // The map is a strip below the column and covers no rider card (Vera's item 4).
    const map = await boxOf(page.locator('[aria-label="Route map"]'));
    const rider = await boxOf(shown.locator("[data-rider]").first());
    expect(rider.y + rider.height).toBeLessThanOrEqual(map.y + 1);
    expect(map.height).toBeLessThanOrEqual(240);
    await expectRoomForTabBar(page);
  });
});

/* ───────────────────────── the role that cannot plan ───────────────────────── */

test.describe("§1.7 #5: the front desk is refused the board, twice", () => {
  test.skip(CONSOLE_ROLE, "this role may plan");

  test("the page is a 403, and the endpoint says the same", async ({ page }) => {
    const response = await page.goto(boardUrl(DAY.refusal));
    expect(response?.status()).toBe(403);
    await expect(page.getByRole("heading", { name: planBoard.heading, level: 1 })).toHaveCount(0);

    const refused = await page.request.post("/api/plan/save", {
      data: { date: DAY.refusal, direction: "PM", version: 0, placements: {} },
    });
    expect(refused.status()).toBe(403);
  });
});

/* ───────────────────────────── the two DOM lints ───────────────────────────── */

/**
 * Vera's differences list, item 5: no V-codes, no layout codes, no provider or vendor name, no
 * "Oct 14" and no 24-hour time anywhere on these two screens. Dates come from the one shared NY
 * helper, so the only date on screen is the one the app was opened on.
 */
async function expectNoCodesOrOldDates(page: Page): Promise<void> {
  const text = await page.locator("main, body").first().innerText();
  const banned: [RegExp, string][] = [
    [/\bV\d\b/, "a vehicle code"],
    [/\d+WC\/\d+A/, "a layout code"],
    [/\b\d{2}:\d{2}\b/, "a 24-hour time"],
    [/\bOct 14\b/, "the fixture date"],
    [/\bSYN\b|Palm Lift|Provider P\d/, "a provider name"],
  ];
  for (const [pattern, what] of banned) {
    expect(text, `${what} on ${page.url()}`).not.toMatch(pattern);
  }
}

/**
 * The frame's bottom tab bar is 64 px plus the safe area (§9.2, built in the Rework 1 PR). A
 * screen that ends under it is a screen whose last card cannot be reached, so these two leave
 * the room whether or not the bar is mounted yet.
 */
async function expectRoomForTabBar(page: Page): Promise<void> {
  const padding = await page.evaluate(() => {
    const main = document.querySelector("main") ?? document.body;
    const page = main.querySelector<HTMLElement>("[class*='page']") ?? (main as HTMLElement);
    return Number.parseFloat(getComputedStyle(page).paddingBottom || "0");
  });
  expect(padding).toBeGreaterThanOrEqual(64);
}
