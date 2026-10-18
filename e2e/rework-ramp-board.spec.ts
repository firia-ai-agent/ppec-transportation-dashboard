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
import { flow, planBoard, toast, vanArrival } from "../src/ui/copy";
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
  child: "2026-11-13",
  childPhone: "2026-11-16",
  absent: "2026-11-14",
  today: "2026-11-15",
  ramp: "2026-11-04",
  wontFit: "2026-11-05",
  confirm: "2026-11-06",
  board: "2026-11-07",
  empty: "2026-11-08",
  drag: "2026-11-09",
  keyboard: "2026-11-10",
  save: "2026-11-11",
  refusal: "2026-11-12",
  undo: "2026-11-17",
  autoplan: "2026-11-18",
  conflict: "2026-11-19",
  legs: "2026-11-20",
  dragPhone: "2026-11-21",
};

/*
 * The project's device preset brings its own 1280 × 720 viewport, so every test starts by
 * setting the wide review width explicitly — a screenshot named 1440 has to be one.
 */
test.beforeEach(async ({ page }) => {
  await page.setViewportSize(WIDE);
});

/*
 * The ramp carries its leg now (`?leg=`), because it reads the plan saved for THAT leg rather
 * than a constant afternoon (src/app/ramp-ipad/page.tsx `resolveLeg`). Without one the address
 * opens on the morning, which is the default leg, and this walk is about the afternoon.
 */
const rampUrl = (day: string) => `/ramp-ipad?date=${day}&leg=pm`;
const boardUrl = (day: string) => `/plan-routes?date=${day}&leg=pm`;

/**
 * The review screenshots this PR is gated on, named for the role and the width.
 *
 * It waits for the map to have painted when there is one: MapLibre fetches its tiles over the
 * network and a shot taken the instant a test finishes catches an empty canvas, which reads as a
 * broken map rather than as a fast test.
 */
async function review(page: Page, screen: string): Promise<void> {
  const dir = path.join(ARTIFACTS, "rework-ramp-board");
  mkdirSync(dir, { recursive: true });
  const canvas = page.locator("canvas");
  if (await canvas.count()) await page.waitForTimeout(2500);
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

/**
 * A saved afternoon for this day, made the way a coordinator makes one: Auto-plan, then Save.
 *
 * The ramp reads the **saved** plan and nothing else now — Firia's S1 ruling deleted the
 * `planSaved ? plan : autoPlan(day, plan)` fallback from src/app/ramp-ipad/arrival/view.ts — so a
 * ramp walk on a day nobody has planned has nothing to count against and must be given one.
 */
async function planTheAfternoon(page: Page, day: string): Promise<void> {
  await openBoard(page, day);
  const state = page.locator("[data-save-state]");
  // The walk is serial on one server, so a day planned by an earlier test is still planned.
  if (!/^Saved /.test((await state.textContent()) ?? "")) {
    await page.locator("[data-auto-plan]").click();
    await expect(page.locator("[data-unassigned-count]")).toHaveText("0");
    await page.locator("[data-save]").click();
  }
  await expect(state).toHaveText(/^Saved /);
}

/**
 * Open the ramp on a day with a saved afternoon, and say whether there is one to open.
 *
 * A front desk cannot plan (§9.3), and one browser-check run is one role, so on that role's
 * server no plan can exist: what they get is the screen the ruling specifies — one line, and no
 * link to a board they may not open — and the walk honestly ends there rather than asserting
 * about a plan the ramp used to invent.
 */
async function openRamp(page: Page, day: string): Promise<boolean> {
  if (!CONSOLE_ROLE) {
    await page.goto(rampUrl(day));
    await expect(page.locator("[data-no-plan]")).toHaveText(vanArrival.noPlanSaved);
    await expect(page.locator("[data-plan-routes]")).toHaveCount(0);
    await expect(page.locator("[data-stepper]")).toHaveCount(0);
    await expect(page.locator("[data-tab]")).toHaveCount(0);
    return false;
  }
  await planTheAfternoon(page, day);
  await page.goto(rampUrl(day));
  return true;
}

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
  test("opens on a van, pre-filled, with the riders the saved plan gave it", async ({ page }) => {
    if (!(await openRamp(page, DAY.ramp))) return;
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
    /*
     * Every counter says what the SAVED plan needs of this van under its label — "Planned 3"
     * (ramp-arrival.png). This replaces the old rule that nothing on the screen says a count was
     * "planned", which was written when nothing planned counts: the ramp reads a saved plan now,
     * so there is a planned number and the amber cell is measured against it (Vera's item 3).
     */
    await expect(page.locator("[data-planned]")).toHaveCount(4);
    await expect(page.locator('[data-planned="carSeats"]')).toHaveText(/^Planned \d+$/);
    await expect(page.getByText(/Default \d/)).toHaveCount(0);
    /*
     * And nothing on this screen promises tomorrow. The mockup draws "Tomorrow starts from this"
     * under Confirm and Vera's polish list asks for it, but an unconfirmed van is planned on the
     * shared config's defaults and never on yesterday's counts (Firia/Veri, 2026-10-17 6:00 PM
     * ET, src/domain/plan/setup.ts) — so that sentence would promise a carry-over the app does
     * not do. It is not shipped, and this is the assertion that says so.
     */
    await expect(page.getByText(/Tomorrow starts/i)).toHaveCount(0);

    // The riders are the ones the plan that was just saved put on this van — the ramp shows a
    // saved plan or it shows nothing at all.
    await expect(page.locator("[data-rider]").first()).toBeVisible();
  });

  test("the review shots of the ramp, at both widths", async ({ page }) => {
    if (!(await openRamp(page, DAY.ramp))) return;
    await reviewBoth(page, "ramp", async () => {
      await page.goto(rampUrl(DAY.ramp));
      await expect(page.locator("[data-rider]").first()).toBeVisible();
    });
  });

  test("one car seat fewer, and the child who needs it is named with the way out", async ({ page }) => {
    if (!(await openRamp(page, DAY.wontFit))) return;
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
    // Counted below what the plan needs: the hint names that number and the cell goes amber.
    await expect(carSeats).toContainText(/Planned \d/);
    await expect(carSeats).toHaveAttribute("data-short", "true");

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
    if (!(await openRamp(page, DAY.confirm))) return;
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
    if (!(await openRamp(page, DAY.ramp))) return;
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
/** One child's card, wherever it is on the board. */
const card2 = (page: Page, name: string): Locator =>
  page.locator("[data-rider]").filter({ hasText: name }).first();

/** How many oxygen mounts the board says are in use, across every van. */
async function oxygenUsed(page: Page): Promise<number> {
  const texts = await page.locator('[data-counter="oxygenMounts"]').allInnerTexts();
  return texts.reduce((sum, text) => sum + Number(/(\d+)\s*\//.exec(text)?.[1] ?? 0), 0);
}
const card = (page: Page, name: string): Locator =>
  page.locator("[data-rider]").filter({ hasText: name }).first();
const announced = (page: Page): Locator => page.locator("[data-announce]");

/**
 * The plan as the server has it, through the read-only board route (`GET /api/plan`, the same
 * one the board itself reads). Nothing here writes: it is how a test says "and the rows did not
 * change" without reaching past the app into a database.
 */
async function savedPlanOf(
  page: Page,
  day: string,
): Promise<{ version: number; plan: Record<string, { bucket: string; vanId: string | null }> }> {
  const response = await page.request.get(`/api/plan?date=${day}&leg=pm`);
  expect(response.status()).toBe(200);
  const body = (await response.json()) as {
    version: number;
    plan: Record<string, { bucket: string; vanId: string | null }>;
  };
  return { version: body.version, plan: body.plan };
}

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

  /**
   * A VAN WITH NO SPOT **LEFT** — "Firia 8:02 PM seed ruling, exactly three generic vans"
   * (d1334d2; the three are src/modules/demo/fixtures/standard.ts:320 `VEHICLES`).
   *
   * Van 3 used to be a sedan with no wheelchair place and no lift, so one chair was refused by
   * what the van *was*. All three vans are the same generic van now — one wheelchair spot each,
   * every one of them lift-equipped — so the refusal is made of counts: the spot is filled first,
   * on screen, by dragging a chair rider into it, and the second chair is the one that will not
   * fit. Nothing is seeded and no endpoint is posted to: the board does both moves.
   */
  test("a chair over the van with no spot is refused, and the card goes back", async ({ page }) => {
    await openBoard(page, DAY.drag);
    const vanThree = vans(page).nth(2);
    const spots = vanThree.locator('[data-counter="wheelchairSpots"]');
    // The van starts with its one spot free — the day is not auto-planned, so what fills it is
    // the drag below and nothing else.
    await expect(spots).toContainText("0/1");
    const empty = await vanThree.locator("[data-rider]").count();

    // 1. Zoe B. rides in her own chair, and a real drag puts her in the van's only spot.
    await liftOver(page, card(page, "Zoe B."), vanThree);
    await expect(vanThree).toHaveAttribute("data-fit", "yes");
    await page.mouse.up();
    await expect(vanThree.locator("[data-rider]").filter({ hasText: "Zoe B." })).toHaveCount(1);
    await expect(vanThree.locator("[data-rider]")).toHaveCount(empty + 1);
    await expect(spots).toContainText("1/1");

    // The plan as the server has it, before the refused move: a draft is not a write (option A),
    // so this is read back unchanged afterwards (the read-only board route, GET /api/plan).
    const planBefore = await savedPlanOf(page, DAY.drag);

    // 2. Noah O. rides in his own chair too, and the spot is gone.
    const before = await vanThree.locator("[data-rider]").count();
    await liftOver(page, card(page, "Noah O."), vanThree);
    await expect(vanThree).toHaveAttribute("data-fit", "no");
    await expect(vanThree.locator("[data-reject-chip]")).toHaveText(planBoard.reject.WHEELCHAIR);
    await review(page, "board-dragreject");
    await page.mouse.up();

    // Nothing moved, and the refusal was said as a sentence rather than only drawn.
    await expect(vanThree.locator("[data-rider]")).toHaveCount(before);
    await expect(vanThree.locator("[data-rider]").filter({ hasText: "Noah O." })).toHaveCount(0);
    await expect(announced(page)).toContainText("Noah O.");
    await expect(announced(page)).toContainText(planBoard.rejectThing.WHEELCHAIR);
    await expect(spots).toContainText("1/1");

    // 3. And in the data: the refused move wrote nothing. Same version, same rows.
    expect(await savedPlanOf(page, DAY.drag)).toEqual(planBefore);

    // …and when the draft **is** saved, the save is the one move that landed: Zoe is in Van 3
    // and Noah is in no van at all, because a refusal cannot be saved by pressing Save.
    await page.locator("[data-save]").click();
    await expect(page.locator("[data-save-state]")).toHaveText(/^Saved /);
    const saved = await savedPlanOf(page, DAY.drag);
    const vanThreeId = await vanThree.getAttribute("data-van");
    const zoe = await card(page, "Zoe B.").getAttribute("data-rider");
    const noah = await page
      .locator('[data-role="unassigned"] [data-rider]')
      .filter({ hasText: "Noah O." })
      .getAttribute("data-rider");
    expect(saved.plan[zoe ?? ""]).toMatchObject({ bucket: "VAN", vanId: vanThreeId });
    expect(saved.plan[noah ?? ""]?.bucket).not.toBe("VAN");
  });

  /**
   * The same refusal at 390, where there is no cross-column drag to make: a phone moves a child
   * with `Move to…` (§9.3), and the refusal comes back the same way — nobody moves, and the
   * reason is announced. The van's one spot is filled the same way first, through the sheet, so
   * what refuses the second chair is a count a person can see (the 3-van rule, d1334d2).
   *
   * The control is **held open** rather than printed under every card: Vera's 390 pass of
   * 2026-10-18 took the always-open select off the cards, because three of them doubled the
   * Family drives lane's height and png/plan-board-390.png draws no such control on a van card.
   * A long press is the phone's own form of the right-click that opens it on a wide screen, and
   * the board says so once above the columns ("Hold a card to move it").
   */
  test("at 390 the same chair is refused by Move to…, once the spot is taken", async ({ page }) => {
    await page.setViewportSize(PHONE);
    // Its own day, with nothing saved on it: both chair riders start in Unassigned, which is
    // the column a phone opens on, so both cards are on screen to act on.
    await openBoard(page, DAY.dragPhone);
    const vanThreeName = (await vans(page).nth(2).getAttribute("aria-label")) ?? "Van 3";

    // The spot is filled on screen first: Zoe B., by the control a phone has.
    const zoe = card(page, "Zoe B.");
    const zoeToken = await zoe.getAttribute("data-rider");
    await expect(page.locator("[data-move-hint]")).toBeVisible();
    await zoe.click({ button: "right" });
    await page.locator(`[data-move-to="${zoeToken}"]`).selectOption({ label: vanThreeName });
    await expect(
      vans(page).nth(2).locator("[data-rider]").filter({ hasText: "Zoe B." }),
    ).toHaveCount(1);
    await expect(vans(page).nth(2).locator('[data-counter="wheelchairSpots"]')).toContainText("1/1");

    // The same control on the second card, opened the same way the hint above the columns says.
    const noah = card(page, "Noah O.");
    const token = await noah.getAttribute("data-rider");
    await noah.click({ button: "right" });
    await page.locator(`[data-move-to="${token}"]`).selectOption({ label: vanThreeName });
    await expect(announced(page)).toContainText("Noah O.");
    await expect(announced(page)).toContainText(planBoard.rejectThing.WHEELCHAIR);
    // Nobody moved: the second chair is still where it was.
    await expect(
      vans(page).nth(2).locator("[data-rider]").filter({ hasText: "Noah O." }),
    ).toHaveCount(0);
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

  /**
   * The child panel (founder 2026-10-17 7:17 PM ET, mockup `plan-board-child-*.png`): tap a
   * card, answer three Yes/No questions, Save — and the plan moves, because the Save writes the
   * child's approved needs and re-runs the one placement function on them.
   */
  test("a child's panel: three answers, a Save, and a board that moved", async ({ page }) => {
    await openBoard(page, DAY.child);
    /*
     * Auto-plan proposes and Save keeps it (Firia's option A, 2026-10-17 9:41 PM ET): until
     * Save the toolbar says "Not saved" (plan-board.html header, the amber dot). The panel's
     * own Save re-plans the **saved** leg, so the board is saved first, as a coordinator would.
     */
    await page.locator("[data-auto-plan]").click();
    await expect(page.locator("[data-unassigned-count]")).toHaveText("0");
    await expect(page.locator("[data-save-state]")).toHaveText(planBoard.notSaved);
    await page.locator("[data-save]").click();
    await expect(page.locator("[data-save-state]")).toHaveText(/^Saved /);

    // Theo V. needs nothing today, so every van's oxygen meter reads 0 of what it carries.
    const card = card2(page, "Theo V.");
    await card.click();
    const panel = page.locator("[data-child-panel]");
    await expect(panel).toBeVisible();
    await expect(panel).toContainText("Theo V.");
    // Three controls and no more: no "riding today", no van setup, no second page.
    await expect(panel.locator("[data-need]")).toHaveCount(3);
    await expect(panel.locator('[data-need="oxygen"] [aria-pressed="true"]')).toHaveText("No");
    await review(page, "board-child");

    const usedBefore = await oxygenUsed(page);
    await panel.locator('[data-need="oxygen"] [data-answer="yes"]').click();
    await panel.locator("[data-panel-save]").click();
    await expect(panel).toHaveCount(0);

    // The board moved: somebody is using an oxygen mount now, and the save status says so.
    await expect.poll(async () => oxygenUsed(page)).toBeGreaterThan(usedBefore);
    await expect(page.locator("[data-save-state]")).toHaveText(/^Saved /);
    await review(page, "board-child-saved");

    // And it is in the plan, not only on the screen.
    await page.reload();
    await expect.poll(async () => oxygenUsed(page)).toBeGreaterThan(usedBefore);
  });

  test("the panel at 390 is the sheet the mockup draws", async ({ page }) => {
    await page.setViewportSize(PHONE);
    // Its own day, with nobody placed: at 390 one column shows at a time, and Unassigned is the
    // one a board opens on — so the card is on screen without switching anything.
    await openBoard(page, DAY.childPhone);
    await card2(page, "Theo V.").click();
    await expect(page.locator("[data-child-panel]")).toBeVisible();
    await expect(page.locator("[data-child-panel] [data-need]")).toHaveCount(3);
    await review(page, "board-child");
    await page.setViewportSize(WIDE);
  });

  /**
   * Absent and Family drives are placements on **this day's** plan (founder 7:17 PM ET): a drop
   * writes `plan_assignment.bucket` with no van, it survives a reload, and the child can be
   * dragged back out of the group.
   */
  test("a child dropped on Absent stays there over a reload, and comes back", async ({ page }) => {
    await openBoard(page, DAY.absent);
    await page.locator("[data-auto-plan]").click();
    const absent = page.locator('[data-bucket="ABSENT"]');
    const count = absent.locator('[data-bucket-count="ABSENT"]');
    /*
     * The count is read rather than assumed to be zero: one `next start` serves every spec and
     * `reuseExistingServer` keeps it between runs, so a day this test saved on an earlier run
     * is still saved. What is asserted is the **change** this test makes, which is the rule.
     */
    const before = Number((await count.innerText()).trim());

    const theo = card2(page, "Theo V.");
    await liftOver(page, theo, absent);
    await page.mouse.up();
    await expect(count).toHaveText(String(before + 1));
    // A drop on a group is a draft like any other move (Firia option A, 9:41 PM ET)…
    await expect(page.locator("[data-save-state]")).toHaveText(planBoard.notSaved);
    await page.locator("[data-save]").click();
    await expect(page.locator("[data-save-state]")).toHaveText(/^Saved /);

    // …and once saved it is a row, not a screen state.
    await page.reload();
    await expect(page.locator('[data-bucket="ABSENT"] [data-bucket-count="ABSENT"]')).toHaveText(
      String(before + 1),
    );

    // And they come back out of it: open the group, then the card's own `Move to…` — which on
    // a wide screen is the context menu §1.2 puts it behind.
    await page.locator('[data-bucket="ABSENT"] button').first().click();
    const inGroup = page.locator('[data-bucket-list="ABSENT"] [data-rider]').first();
    await expect(inGroup).toBeVisible();
    const token = await inGroup.getAttribute("data-rider");
    await inGroup.click({ button: "right" });
    /*
     * Back to Unassigned, which is the move that is always allowed: the point here is that a
     * child can be taken **out** of the group. A van may honestly refuse them, because the fit
     * rule still decides and an earlier test in this run may have changed what they need.
     */
    await page.locator(`[data-move-to="${token}"]`).selectOption({ label: planBoard.unassigned });
    await expect(page.locator('[data-bucket="ABSENT"] [data-bucket-count="ABSENT"]')).toHaveText(
      String(before),
    );
    await expect(
      page.locator('[data-role="unassigned"] [data-rider]').filter({ hasText: "Theo V." }),
    ).toHaveCount(1);
  });

  test("no internal code, no fixture date, and the DEMO bar is the only violet", async ({ page }) => {
    await openBoard(page, DAY.save);
    await expectDemoBarPinned(page);
    await expectVioletOnlyOnDemoChrome(page);
    await expectNoInternalCodes(page);
    await expectNoCodesOrOldDates(page);
  });

  /**
   * Firia's option A (2026-10-17 9:41 PM ET), and the test contract's "Plan routes board,
   * Layer 2": a drag is a **draft**. It changes the screen, writes nothing, and the toolbar
   * says "Not saved" until somebody presses Save.
   */
  test("a drag is unsaved until Save, and a reload forgets it", async ({ page }) => {
    await openBoard(page, DAY.undo);
    const target = vans(page).nth(1);

    await liftOver(page, card2(page, "Theo V."), target);
    await page.mouse.up();
    // On screen, in the van (plan-board.html: the card moves on drop)…
    await expect(target.locator("[data-rider]").filter({ hasText: "Theo V." })).toHaveCount(1);
    // …and the toolbar says it is a draft (plan-board.png header: the amber "Not saved").
    await expect(page.locator("[data-save-state]")).toHaveText(planBoard.notSaved);

    // Nothing was written: a reload is the saved plan again, which has nobody in it.
    await page.reload();
    await expect(
      vans(page).nth(1).locator("[data-rider]").filter({ hasText: "Theo V." }),
    ).toHaveCount(0);
    await expect(page.locator("[data-save-state]")).toHaveText(planBoard.notSaved);
  });

  /** Option A: Undo reverses **unsaved** moves only, most recent first, and never a save. */
  test("Undo takes back the last unsaved move, and nothing that was saved", async ({ page }) => {
    await openBoard(page, DAY.undo);
    const vanOne = vans(page).first();
    const vanTwo = vans(page).nth(1);

    // One move, then Save: this is the one Undo must never touch.
    await liftOver(page, card2(page, "Theo V."), vanOne);
    await page.mouse.up();
    await page.locator("[data-save]").click();
    await expect(page.locator("[data-save-state]")).toHaveText(/^Saved /);
    await expect(vanOne.locator("[data-rider]").filter({ hasText: "Theo V." })).toHaveCount(1);
    /*
     * Undo is offered only while there is something unsaved: a bare icon button named "Undo"
     * in the header (plan-board.html header; test contract, Plan routes Layer 1 #6). The move
     * toast offers its own Undo, so the header one is pinned by its hook as well as its name.
     */
    const undoButton = page
      .getByRole("button", { name: planBoard.undo })
      .and(page.locator("[data-undo]"));
    await expect(undoButton).toBeDisabled();

    // One unsaved move, then Undo: the card goes back, and the saved one stays put.
    await liftOver(page, card2(page, "Mia R."), vanTwo);
    await page.mouse.up();
    await expect(vanTwo.locator("[data-rider]").filter({ hasText: "Mia R." })).toHaveCount(1);
    await undoButton.click();
    await expect(vanTwo.locator("[data-rider]").filter({ hasText: "Mia R." })).toHaveCount(0);
    await expect(vanOne.locator("[data-rider]").filter({ hasText: "Theo V." })).toHaveCount(1);
    // With nothing unsaved left, the header says what is kept, not "Not saved".
    await expect(page.locator("[data-save-state]")).toHaveText(/^Saved /);
  });

  /** Option A: Auto-plan proposes. Nothing is written until Save. */
  test("Auto-plan fills unsaved moves, and the plan is written only on Save", async ({ page }) => {
    await openBoard(page, DAY.autoplan);
    await page.locator("[data-auto-plan]").click();
    await expect(page.locator("[data-unassigned-count]")).toHaveText("0");
    // Still a draft (plan-board.png: the amber dot and "Not saved").
    await expect(page.locator("[data-save-state]")).toHaveText(planBoard.notSaved);

    // A reload proves nothing was written: everybody is waiting again.
    await page.reload();
    await expect(page.locator("[data-unassigned-count]")).not.toHaveText("0");

    await page.locator("[data-auto-plan]").click();
    await page.locator("[data-save]").click();
    await expect(page.locator("[data-save-state]")).toHaveText(/^Saved /);
    const placed = await page.locator("[data-van] [data-rider]").allInnerTexts();
    await page.reload();
    expect(await page.locator("[data-van] [data-rider]").allInnerTexts()).toEqual(placed);
  });

  /**
   * Two coordinators, one plan: the second Save loses and is **told**, and its draft survives
   * (Firia option A; the test contract's "Plan changed, reload", simulated with a second tab).
   */
  test("a stale Save says 'Plan changed, reload' and keeps the unsaved moves", async ({
    page,
    context,
  }) => {
    await openBoard(page, DAY.conflict);
    // This tab builds a draft…
    await liftOver(page, card2(page, "Theo V."), vans(page).first());
    await page.mouse.up();
    await expect(page.locator("[data-save-state]")).toHaveText(planBoard.notSaved);

    // …while a second tab saves one of its own, moving the version on.
    const other = await context.newPage();
    await other.setViewportSize(WIDE);
    await openBoard(other, DAY.conflict);
    await other.locator("[data-auto-plan]").click();
    await other.locator("[data-save]").click();
    await expect(other.locator("[data-save-state]")).toHaveText(/^Saved /);
    await other.close();

    // The first tab's Save is refused in words, and its own move is still on screen.
    await page.locator("[data-save]").click();
    await expect(page.locator("[data-save-state]")).toHaveText(planBoard.changedReload);
    await expect(
      vans(page).first().locator("[data-rider]").filter({ hasText: "Theo V." }),
    ).toHaveCount(1);
  });

  /** The two legs are two plans (DATA-MODEL §1: `plan_run` is per site, date **and** direction). */
  test("Morning and Afternoon keep separate plans", async ({ page }) => {
    await openBoard(page, DAY.legs);
    await page.locator("[data-auto-plan]").click();
    await page.locator("[data-save]").click();
    await expect(page.locator("[data-save-state]")).toHaveText(/^Saved /);

    // The other leg of the same day has nothing saved on it.
    await page.goto(`/plan-routes?date=${DAY.legs}&leg=am`);
    await expect(page.getByRole("heading", { name: planBoard.heading, level: 1 })).toBeVisible();
    await expect(page.locator("[data-save-state]")).toHaveText(planBoard.notSaved);
    await expect(page.locator("[data-unassigned-count]")).not.toHaveText("0");
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

/* ───────────────────────────── Today does not plan ───────────────────────────── */

/*
 * The two tests that lived here planned from Today — Auto-plan and Save on `/today`, and a
 * copy of the board's columns on it. today-saved-1440.png has neither: Today's board is
 * read-only and the planning toolbar belongs to Plan routes (Veri's alignment audit,
 * 2026-10-17 10:53 PM ET; Firia's 8:36 PM scope). The UI half moves to Plan routes below, and
 * the read-only board arrives with the Today PR, which is where its mockup assertions belong.
 */
test.describe("Today shows the day; Plan routes plans it", () => {
  test.skip(!CONSOLE_ROLE, "Today is not this role's screen");

  test("Today has no Auto-plan and no Save, and the plan kept on Plan routes stays kept", async ({
    page,
  }) => {
    // Planning is a Plan routes toolbar (plan-board.html header; Firia option A).
    await openBoard(page, DAY.today);
    await page.locator("[data-auto-plan]").click();
    await expect(page.locator("[data-unassigned-count]")).toHaveText("0");
    await expect(page.locator("[data-save-state]")).toHaveText(planBoard.notSaved);
    await page.locator("[data-save]").click();
    await expect(page.locator("[data-save-state]")).toHaveText(/^Saved /);
    const moved = await page
      .locator("[data-van]")
      .first()
      .locator("[data-rider]")
      .first()
      .innerText();

    // Today carries neither control (today-saved-1440.png: a read-only board, no toolbar).
    await page.goto(`/today?date=${DAY.today}&leg=pm`);
    await expect(page.locator("[data-auto-plan]")).toHaveCount(0);
    await expect(page.locator("[data-save]")).toHaveCount(0);

    // And the plan is a row: the screen that keeps it reads the same one back.
    await page.goto(boardUrl(DAY.today));
    await expect(page.locator("[data-unassigned-count]")).toHaveText("0");
    await expect(page.locator("[data-van]").first()).toContainText(moved.split("\n")[0]);
  });
});

/* ───────────────────────── the role that cannot plan ───────────────────────── */

test.describe("§1.7 #5: the front desk cannot plan, and the endpoint says so too", () => {
  test.skip(CONSOLE_ROLE, "this role may plan");

  /**
   * Two halves, and they are deliberately different answers (§9.3, and the frame's own rule):
   * the **page** sends them home with "Not on your menu" — a refusal page with no way back was
   * the dead end the founder's walk found — while the **endpoint** still answers a flat 403,
   * because hiding a link is a courtesy and the guard is the guard.
   */
  test("the board sends them home with a word, and the save endpoint is a 403", async ({ page }) => {
    await page.goto(boardUrl(DAY.refusal));
    await expect(page.locator("[data-notice]")).toContainText(toast.notOnMenu);
    expect(new URL(page.url()).pathname).not.toBe("/plan-routes");
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
    // A 24-hour time is a clock time with no AM/PM after it, so "Saved 11:40 PM" is fine and
    // "17:40" is not. This also catches a bare "9:30", which the \d{2} form used to let through.
    [/\b\d{1,2}:\d{2}\b(?!\s*[AP]M)/, "a 24-hour time"],
    [/\bOct 14\b/, "the fixture date"],
    [/\bSYN\b|Palm Lift|Provider P\d/, "a provider name"],
  ];
  for (const [pattern, what] of banned) {
    expect(text, `${what} on ${page.url()}`).not.toMatch(pattern);
  }
}

/**
 * The frame's bottom tab bar is 64 px plus the safe area (§9.2, Firia's 3:08 PM ET ruling, built
 * in the Rework 1 PR and merged into this branch). A screen that ends under it is a screen whose
 * last card cannot be reached — so the bar is there, and nothing the person has to touch is
 * underneath it.
 */
async function expectRoomForTabBar(page: Page): Promise<void> {
  const bar = page.getByRole("navigation").last();
  await expect(bar).toBeVisible();
  const barBox = await boxOf(bar);
  expect(barBox.height).toBeGreaterThanOrEqual(64);
  // Scrolled all the way down is where a page that reserved nothing hides its last control
  // under the bar. Everything has to be clear of it *there*, not only at the top of the page.
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(300);
  // Only what is actually on screen: at 390 the columns that are not showing are display:none,
  // and a hidden card has no box to compare.
  for (const locator of [page.locator("[data-rider]:visible").last(), page.locator("[data-confirm]:visible")]) {
    if ((await locator.count()) === 0) continue;
    const box = await boxOf(locator.first());
    expect(box.y + box.height, "a control sits under the tab bar").toBeLessThanOrEqual(barBox.y + 1);
  }
}
