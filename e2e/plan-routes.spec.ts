/**
 * The plan board, in a real browser (redesign spec §1.7, the acceptance Veri gates).
 *
 * One walk, in order, because the board is one stateful screen and the acceptance is a story
 * about it: a child placed from the keyboard, a drag the van refuses, the same drag succeeding
 * once that van's counts are raised, the unsaved-change question, and a plan that survives a
 * reload. `describe.serial` is deliberate — each step leaves the board where the next one starts,
 * exactly as a coordinator would. The screenshots land in artifacts/ so a design review has the
 * picture beside the assertion, at both review widths (1440 × 900 and 390 × 844).
 *
 * No database and no credentials: the server runs with the test-only synthetic session (see
 * playwright.config.ts), which grants a role and nothing else. On that server the board's store is
 * the memory fallback (src/modules/plan/memory.ts), which starts from exactly what the demo seed
 * writes — yesterday's van setup, no plan for today — so what is walked here is the same first-run
 * state a founder sees after "Start demo day". The SQL a deployment runs instead is asserted
 * against the real migrations in src/modules/plan/sql.test.ts.
 *
 * §1.7 #5 (the front desk's refusal) is not here: one browser-check run is one role, and the
 * refusal is asserted without a browser in src/auth/access.test.ts, guard-matrix.test.ts and
 * src/app/api/plan/save/route.test.ts — a 403 from the endpoint and no rail item, which is the
 * pair that matters.
 */
import { expect, test, type Locator, type Page } from "@playwright/test";
import { flow, planBoard } from "../src/ui/copy";
import {
  boxOf,
  expectDemoBarPinned,
  expectNoInternalCodes,
  expectVioletOnlyOnDemoChrome,
  shot,
} from "./helpers";

/** The two children of the synthetic day who ride in their own chair. */
const [NOAH, ZOE] = ["Noah O.", "Zoe B."];

/**
 * The day this walk plans.
 *
 * Its own, and not today's, because the board is a **stateful** screen and the browser check
 * reuses one server: a van confirmed by the ramp spec or a plan saved by another walk would
 * change what this one opens on. A date is a URL parameter (§9.3), and a day nobody has touched
 * reads the same way every run — yesterday's van setup, no plan saved — which is exactly the
 * state a founder sees after "Start demo day".
 */
const DAY = "2026-11-02";
const BOARD = `/plan-routes?date=${DAY}&leg=pm`;

/** §1.7 #6: nothing internal reaches the words — the regex the spec writes out. */
const INTERNAL = /\b[A-Z]\d\b|\d+WC\/|[A-Z]{3,}-[A-Z]{3,}|\b\d{2}:\d{2}\b/;

/** How far the keyboard sensor has to travel to leave a 176 px column. */
const ARROWS_TO_NEXT_COLUMN = 12;

async function openBoard(page: Page): Promise<void> {
  await page.goto(BOARD);
  await expect(page.getByRole("heading", { name: planBoard.heading, level: 1 })).toBeVisible();
  await expect(page.locator("[data-van]")).toHaveCount(3);
}

/** The columns, in the order the board draws them. */
const vans = (page: Page): Locator => page.locator("[data-van]");
const unassigned = (page: Page): Locator => page.locator('[data-role="unassigned"]');

/** One child's card, wherever it currently is. */
function card(page: Page, name: string): Locator {
  return page.locator("[data-rider]").filter({ hasText: name }).first();
}

/** Our own announcement region — not dnd-kit's, and not the DEMO bar's status. */
const announced = (page: Page): Locator => page.locator("[data-announce]");

/**
 * A pointer drag dnd-kit will accept, in two halves so a test can read the screen **while** the
 * child is held: press, travel past the 5 px activation distance in steps, settle over the
 * target — and release separately. One `move` is not a drag; the sensor needs the movement to
 * cross its constraint before it lifts anything.
 */
async function liftOver(page: Page, child: Locator, target: Locator): Promise<void> {
  const from = await boxOf(child);
  const to = await boxOf(target);
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2 + 12, from.y + from.height / 2 + 12, { steps: 4 });
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 12 });
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2 + 4, { steps: 4 });
}

async function dragOnto(page: Page, child: Locator, target: Locator): Promise<void> {
  await liftOver(page, child, target);
  await page.mouse.up();
}

/** The same move without a drag: the card's own `Move to…` control (§1.2, §9.3). */
async function moveToColumn(page: Page, name: string, columnLabel: string): Promise<void> {
  const rider = card(page, name);
  await rider.click({ button: "right" });
  const select = page.locator(`[data-move-to="${await rider.getAttribute("data-rider")}"]`);
  await select.selectOption({ label: columnLabel });
}

async function ridersIn(column: Locator): Promise<number> {
  return column.locator("[data-rider]").count();
}

test.describe.serial("§1.7: the board a coordinator plans on", () => {
  test("4: a child placed from the keyboard, and a refusal announced in words", async ({ page }) => {
    await openBoard(page);
    const vanOne = vans(page).nth(0);

    // Space lifts, the arrows move between columns, Space drops (dnd-kit's keyboard sensor).
    await card(page, NOAH).focus();
    await page.keyboard.press("Space");
    for (let step = 0; step < ARROWS_TO_NEXT_COLUMN; step += 1) await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Space");
    await expect(vanOne.locator("[data-rider]").filter({ hasText: NOAH })).toHaveCount(1);
    await expect(announced(page)).toContainText(NOAH);

    // Van 1 has one wheelchair spot and it is now taken, so the second chair is refused — and the
    // refusal is a sentence a screen reader reads, not only a dimmed column.
    await card(page, ZOE).focus();
    await page.keyboard.press("Space");
    for (let step = 0; step < ARROWS_TO_NEXT_COLUMN; step += 1) await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Space");
    await expect(announced(page)).toContainText(ZOE);
    await expect(announced(page)).toContainText(planBoard.rejectThing.WHEELCHAIR);
    await expect(vanOne.locator("[data-rider]").filter({ hasText: ZOE })).toHaveCount(0);

    // Put the board back as it was, so the next step starts from a board nobody has planned.
    await moveToColumn(page, NOAH, planBoard.unassigned);
    await expect(unassigned(page).locator("[data-rider]").filter({ hasText: NOAH })).toHaveCount(1);
  });

  test("1: the van with no wheelchair spot refuses the drop, and nothing moves", async ({ page }) => {
    await openBoard(page);
    const vanThree = vans(page).nth(2);
    const before = await ridersIn(vanThree);

    await liftOver(page, card(page, NOAH), vanThree);
    // Three cues while the child is held: dimmed, outlined as a refusal, and one word.
    await expect(vanThree).toHaveAttribute("data-fit", "no");
    await expect(vanThree.locator("[data-reject-chip]")).toHaveText(planBoard.reject.WHEELCHAIR);
    await shot(page, "plan-board-drop-refused");

    await page.mouse.up();
    expect(await ridersIn(vanThree)).toBe(before);
    await expect(announced(page)).toContainText(NOAH);
    await expect(announced(page)).toContainText(planBoard.rejectThing.WHEELCHAIR);
  });

  test("2: raise that van's Wheelchair and lift, and the same drag succeeds", async ({ page }) => {
    await openBoard(page);
    const vanThree = vans(page).nth(2);

    await vanThree.locator("[data-setup-button]").click();
    const setup = page.locator("[data-setup]");
    await expect(setup).toBeVisible();
    // The live line is about the child this van is refusing, before anything is applied.
    await expect(setup).toContainText(planBoard.wontFit.replace("{child}", NOAH));
    await setup.locator('[data-stepper="wheelchairSpots"] button').last().click();
    await setup.getByRole("switch").click();
    await expect(setup).toContainText(planBoard.fits.replace("{child}", NOAH));
    await shot(page, "plan-board-setup");
    await setup.getByRole("button", { name: planBoard.apply }).click();
    await expect(setup).toHaveCount(0);

    await dragOnto(page, card(page, NOAH), vanThree);
    await expect(vanThree.locator("[data-rider]").filter({ hasText: NOAH })).toHaveCount(1);
    await shot(page, "plan-board-drop-taken");
  });

  test("§9.2: a board with an unsaved change asks before it is left", async ({ page }) => {
    await openBoard(page);
    // A change nobody has saved: one child moved into the van beside them.
    await moveToColumn(page, ZOE, (await vans(page).nth(0).getAttribute("aria-label")) ?? "");
    await expect(page.locator("[data-save-state]")).toHaveText(planBoard.notSaved);

    await page.locator("[data-banner] a").click();
    await expect(page.getByRole("dialog", { name: flow.leave.title })).toBeVisible();
    await page.getByRole("button", { name: flow.leave.stay }).click();
    await expect(page.getByRole("heading", { name: planBoard.heading, level: 1 })).toBeVisible();
  });

  test("3: Auto-plan, Save, reload — the plan is still there, with the minute it was kept", async ({ page }) => {
    await openBoard(page);
    await page.locator("[data-auto-plan]").click();
    // Everybody placed: the Unassigned column says so in a word, not only in a colour.
    await expect(page.locator("[data-unassigned-count]")).toHaveText("0");
    await expect(page.getByText(planBoard.allPlaced)).toBeVisible();
    await shot(page, "plan-board-planned");

    await page.locator("[data-save]").click();
    const saved = page.locator("[data-save-state]");
    await expect(saved).toHaveText(/^Saved \d{1,2}:\d{2} (AM|PM)$/);
    const savedText = await saved.innerText();

    // The reload is the point: a plan kept in rows comes back, and says when it was kept.
    await page.reload();
    await expect(page.locator("[data-save-state]")).toHaveText(savedText);
    await expect(page.locator("[data-unassigned-count]")).toHaveText("0");
  });

  test("6 + 7: no internal code anywhere, the DEMO bar, and the one Simulated chip", async ({ page }) => {
    await openBoard(page);
    await expectDemoBarPinned(page);
    await expectNoInternalCodes(page);
    await expectVioletOnlyOnDemoChrome(page);

    const text = await page.locator("body").innerText();
    const found = text.match(INTERNAL);
    expect(found, `an internal code reached the screen: ${found?.[0] ?? ""}`).toBeNull();
  });

  test("§9.3: the day's missing step is said in place, and links to the step that fixes it", async ({ page }) => {
    await openBoard(page);
    const banner = page.locator("[data-banner]");
    await expect(banner).toContainText(flow.banner.usingYesterday);
    await expect(banner.getByRole("link", { name: flow.action.checkVans })).toHaveAttribute(
      "href",
      /\/ramp-ipad\?date=\d{4}-\d{2}-\d{2}&leg=(am|pm)&van=/,
    );
  });

  test("§9.3 at 390: one column at a time, with Move to… instead of a cross-column drag", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openBoard(page);
    const switcher = page.getByRole("tablist", { name: planBoard.columnSwitcher });
    await expect(switcher).toBeVisible();
    // The Unassigned column is the one on screen, and the vans are not.
    await expect(unassigned(page)).toBeVisible();
    await expect(vans(page).nth(0)).toBeHidden();
    await shot(page, "plan-board-390-unassigned");

    // One tap to the first van, which is where the plan put its riders.
    await switcher.getByRole("tab").nth(1).click();
    await expect(vans(page).nth(0)).toBeVisible();
    expect(await ridersIn(vans(page).nth(0))).toBeGreaterThan(0);
    // The move control is on the card itself here: there is no cross-column drag on a phone.
    await expect(vans(page).nth(0).locator("[data-move-to]").first()).toBeVisible();
    await shot(page, "plan-board-390-van");
  });
});
