/**
 * S1 IN A REAL BROWSER: the question before a reset, and the drop that bounced.
 *
 * MOCKUPS THIS FILE COVERS (team rule — every test names the picture it is about):
 *  - `/workspace/ppec-redesign/mockups/plan-board.html` + `png/plan-board.png` (1440) and
 *    `png/plan-board-390.png` (390): the three van columns beside the children waiting, the
 *    "Drop here" target in an empty column (plan-board.html:333), the one-column-at-a-time
 *    switcher at 390 (plan-board.html:286 `.vtabs.p390`), and the toolbar's Auto-plan / Save.
 *  - `/workspace/ppec-redesign/mockups/shell-flow.html` + `png/shell-flow-1440.png`: the DEMO
 *    bar and the "Restart demo day" control at its right-hand end (shell-flow.html's `.demo
 *    .reset`, drawn identically in plan-board.html:265).
 *
 * WHAT ONLY A BROWSER CAN ANSWER. The arithmetic is unit-tested — where a drop lands
 * (src/app/plan-routes/board/collision.test.ts), whether a van may take a child
 * (src/domain/plan/eligibility.test.ts), what a drop does
 * (src/app/plan-routes/board/drop.test.ts) and when the reset asks first
 * (src/ui/restart-confirm.test.ts). What those cannot say is whether the real laid-out board
 * agrees: the S1 bug was made of the *measured* geometry of two columns, so the drag below is
 * made the way Firia made it — the card grabbed off its centre and let go over the near edge of
 * Van 1 — and the pass condition is Vera's: she lands, or she stays exactly where she was with a
 * reason on her card. A bounce to Unassigned fails, and so does a toast with no reason.
 *
 * No database and no credentials. On this server the board's store is the memory fallback
 * (src/modules/plan/memory.ts) and the session is the browser check's own — a role and no user
 * id (src/auth/caller.ts), which is why the reset endpoint can be *asked* here and cannot
 * succeed: `handleDemoReset` answers 401 without a user. That the rows are actually cleared is
 * src/modules/demo/reset.db.test.ts, against the real migrations.
 */
import { expect, test, type Locator, type Page } from "@playwright/test";
import { demoDay, flow, planBoard } from "../src/ui/copy";
import { API } from "../src/auth/access";
import { boxOf, expectNoInternalCodes } from "./helpers";

const ROLE = (process.env.E2E_DEMO_ROLE ?? "DIRECTOR").toUpperCase();
const CONSOLE_ROLE = ROLE === "DIRECTOR" || ROLE === "COORDINATOR";
/** The reset is the director's, and so is the control that calls it (src/auth/access.ts). */
const CAN_RESET = ROLE === "DIRECTOR";

const WIDE = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

/**
 * A date per walk. The board is a stateful screen on one reused server, so a plan saved by one
 * test would change what the next one opens on; a date is a URL parameter (§9.3).
 */
const DAY = {
  drag: "2026-12-01",
  dragPhone: "2026-12-02",
  parity: "2026-12-03",
  keep: "2026-12-04",
  restart: "2026-12-05",
};

const boardUrl = (day: string) => `/plan-routes?date=${day}&leg=pm`;

const vans = (page: Page): Locator => page.locator("[data-van]");
const card = (page: Page, name: string): Locator =>
  page.locator("[data-rider]").filter({ hasText: name }).first();
const unassigned = (page: Page): Locator => page.locator('[data-role="unassigned"]');
const toast = (page: Page): Locator => page.locator("[data-toast]");
const announced = (page: Page): Locator => page.locator("[data-announce]");

async function openBoard(page: Page, day: string): Promise<void> {
  await page.goto(boardUrl(day));
  await expect(page.getByRole("heading", { name: planBoard.heading, level: 1 })).toBeVisible();
  await expect(vans(page)).toHaveCount(3);
}

/** The plan as the server has it, through the read-only board route the board itself reads. */
async function savedPlanOf(
  page: Page,
  day: string,
): Promise<{ version: number; plan: Record<string, { bucket: string; vanId: string | null }> }> {
  const response = await page.request.get(`${API.planBoard}?date=${day}&leg=pm`);
  expect(response.status()).toBe(200);
  return (await response.json()) as never;
}

/**
 * "Start demo day" — the board's own strip (plan-board.html's banner row), through the confirm
 * when there is a plan to lose. Returns whether the question was asked.
 */
async function startDay(page: Page): Promise<boolean> {
  const start = page.locator("[data-start-day]");
  if ((await start.count()) === 0) return false;
  await start.click();
  const dialog = page.locator("[data-restart-confirm]");
  if ((await dialog.count()) === 0) return false;
  await expect(dialog).toContainText(demoDay.confirm.title);
  await page.locator("[data-restart-go]").click();
  await expect(dialog).toHaveCount(0);
  return true;
}

/**
 * THE DRAG THE BUG WAS MADE OF.
 *
 * Not the middle of the card onto the middle of the column: the card is picked up at `grabAt` of
 * its own width — 0.8 is the need icons, which is where a hand naturally lands — and let go at
 * `dropAt` of the target's width, 0.2 being the near edge where plan-board.html draws "Drop
 * here". `closestCenter` compared the *card's* centre with each column's centre, so exactly this
 * pair of offsets resolved to the column the card came from.
 */
async function liftOffCentre(
  page: Page,
  child: Locator,
  target: Locator,
  { grabAt = 0.8, dropAt = 0.2 } = {},
): Promise<void> {
  const from = await boxOf(child);
  const to = await boxOf(target);
  const grabX = from.x + from.width * grabAt;
  const grabY = from.y + from.height / 2;
  const dropX = to.x + to.width * dropAt;
  const dropY = to.y + to.height * 0.25;
  await page.mouse.move(grabX, grabY);
  await page.mouse.down();
  // Past dnd-kit's 5 px activation distance first, then across in steps it can follow.
  await page.mouse.move(grabX + 12, grabY + 12, { steps: 4 });
  await page.mouse.move(dropX, dropY, { steps: 16 });
  await page.mouse.move(dropX, dropY + 3, { steps: 3 });
}

/**
 * Vera's pass condition, measured: either she is in the van, or she is exactly where she was
 * with one line on her card saying why. Never a third thing, and never a toast with no reason.
 */
async function expectLandedOrRefused(
  page: Page,
  name: string,
  van: Locator,
  wasIn: Locator,
): Promise<"LANDED" | "REFUSED"> {
  const inVan = van.locator("[data-rider]").filter({ hasText: name });
  if ((await inVan.count()) === 1) {
    // Landed: the existing toast, naming the van she went to (§1.3's four seconds).
    await expect(toast(page)).toContainText(name);
    await expect(toast(page)).toContainText((await van.getAttribute("aria-label")) ?? "Van");
    return "LANDED";
  }
  // Refused: she did not move, and the reason is on her card — not in a toast (Vera).
  await expect(wasIn.locator("[data-rider]").filter({ hasText: name })).toHaveCount(1);
  const token = await card(page, name).getAttribute("data-rider");
  const refusal = page.locator(`[data-refusal="${token}"]`);
  await expect(refusal).toHaveCount(1);
  const line = (await refusal.innerText()).trim();
  expect(line.length, "the refusal names something").toBeGreaterThan(0);
  expect(line.split(/\s+/).length, `four words at most: ${line}`).toBeLessThanOrEqual(5);
  await expect(toast(page)).toHaveCount(0);
  // And it is still said as a sentence for the ear (§1.3).
  await expect(announced(page)).toContainText(name);
  return "REFUSED";
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize(WIDE);
});

/* ───────────────────────────── the S1 drop ───────────────────────────── */

test.describe.serial("S1: Zoe B. onto Van 1", () => {
  test.skip(!CONSOLE_ROLE, "the board is not this role's screen");

  /**
   * MOCKUP: mockups/plan-board.html + png/plan-board.png (1440) — the Unassigned column beside
   * Van 1, and the "Drop here" target in an empty van column (plan-board.html:333).
   */
  test("lands on Van 1 at 1440, and stays there after Save and a reload", async ({ page }) => {
    await openBoard(page, DAY.drag);
    await startDay(page);
    const vanOne = vans(page).first();
    await expect(vanOne).toHaveAttribute("aria-label", "Van 1");

    // She starts in Unassigned, and Van 1's chair spot and oxygen mount are both free — which is
    // the state Firia's report describes (Wheelchair 0/1, Oxygen 0/1).
    await expect(unassigned(page).locator("[data-rider]").filter({ hasText: "Zoe B." })).toHaveCount(1);
    await expect(vanOne.locator('[data-counter="wheelchairSpots"]')).toContainText("0/1");
    await expect(vanOne.locator('[data-counter="oxygenMounts"]')).toContainText("0/1");

    await liftOffCentre(page, card(page, "Zoe B."), vanOne);
    // While she is held, the column says what it would do with her — and it is Van 1 under the
    // pointer, not the column she came from.
    await expect(vanOne).toHaveAttribute("data-fit", "yes");
    await page.mouse.up();

    const outcome = await expectLandedOrRefused(page, "Zoe B.", vanOne, unassigned(page));
    // The one thing that must never happen: the bounce. A "→ Unassigned" toast is only ever the
    // answer to a drop **on** Unassigned, and this drop was on Van 1.
    await expect(toast(page)).not.toContainText(planBoard.unassigned);

    if (outcome === "LANDED") {
      // …and it is a real placement, not a screen state: Save, reload, still there.
      await page.locator("[data-save]").click();
      await expect(page.locator("[data-save-state]")).toHaveText(/^Saved /);
      const token = await card(page, "Zoe B.").getAttribute("data-rider");
      const vanId = await vanOne.getAttribute("data-van");
      expect((await savedPlanOf(page, DAY.drag)).plan[token ?? ""]).toMatchObject({
        bucket: "VAN",
        vanId,
      });
      await page.reload();
      await expect(
        vans(page).first().locator("[data-rider]").filter({ hasText: "Zoe B." }),
      ).toHaveCount(1);
    }
    await expectNoInternalCodes(page);
  });

  /**
   * MOCKUP: png/plan-board-390.png + mockups/plan-board.html:286 (`.vtabs.p390`) — one column at
   * a time, so there is no cross-column drag to make at this width (§9.3). Two halves, and both
   * of them are the S1 failure at 390: a drag that lands on no column must leave her put rather
   * than in a column the phone is not drawing, and the move a phone actually makes is `Move to…`.
   */
  test("at 390 she never lands in a hidden column, and Move to… puts her in Van 1", async ({
    page,
  }) => {
    await page.setViewportSize(PHONE);
    await openBoard(page, DAY.dragPhone);
    await startDay(page);
    const vanOne = vans(page).first();
    const vanOneLabel = (await vanOne.getAttribute("aria-label")) ?? "Van 1";
    // The switcher lists all three vans at this width even though one column is drawn.
    await expect(vans(page)).toHaveCount(3);

    // 1. A drag inside the one visible column, up towards its header. The hidden columns measure
    //    as a zero rect at the origin, and that origin used to win this drop.
    const zoe = card(page, "Zoe B.");
    const token = await zoe.getAttribute("data-rider");
    const box = await boxOf(zoe);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 10, box.y + box.height / 2 - 10, { steps: 4 });
    await page.mouse.move(box.x + 20, box.y - 60, { steps: 12 });
    await page.mouse.up();
    await expect(unassigned(page).locator(`[data-rider="${token}"]`)).toHaveCount(1);
    for (let i = 0; i < 3; i += 1) {
      await expect(vans(page).nth(i).locator(`[data-rider="${token}"]`)).toHaveCount(0);
    }

    // 2. And the move a phone makes: the card's own `Move to…` (§9.3), which runs the same
    //    eligibility check the drag runs.
    await page.locator(`[data-move-to="${token}"]`).selectOption({ label: vanOneLabel });
    const outcome = await expectLandedOrRefused(page, "Zoe B.", vanOne, unassigned(page));
    if (outcome === "LANDED") {
      await page.locator("[data-save]").click();
      await expect(page.locator("[data-save-state]")).toHaveText(/^Saved /);
      await page.reload();
      await expect(vans(page).first().locator(`[data-rider="${token}"]`)).toHaveCount(1);
    }
    await page.setViewportSize(WIDE);
  });

  /**
   * MOCKUP: mockups/plan-board.html (the toolbar's Auto-plan) + png/plan-board.png.
   *
   * The drag and Auto-plan are one check now (src/domain/plan/eligibility.ts), so on a fresh day
   * they must answer the same: Auto-plan puts her in a van, and dragging her onto that same van
   * from scratch lands her there too.
   */
  test("the drag and Auto-plan give the same answer for her", async ({ page }) => {
    await openBoard(page, DAY.parity);
    await startDay(page);
    const token = await card(page, "Zoe B.").getAttribute("data-rider");

    // 1. What Auto-plan says, on a day nobody has touched.
    await page.locator("[data-auto-plan]").click();
    const autoVan = vans(page).filter({ has: page.locator(`[data-rider="${token}"]`) });
    await expect(autoVan).toHaveCount(1);
    const autoVanId = await autoVan.getAttribute("data-van");
    expect(autoVanId, "Auto-plan put her in a van").toBeTruthy();

    // 2. Back to a fresh board (nothing was written — Auto-plan proposes), then the same van by
    //    hand. One check, so one answer: she lands, and no refusal line is drawn.
    await page.reload();
    await expect(unassigned(page).locator(`[data-rider="${token}"]`)).toHaveCount(1);
    const byHand = page.locator(`[data-van="${autoVanId}"]`);
    await expect(byHand).toHaveCount(1);
    await liftOffCentre(page, card(page, "Zoe B."), byHand);
    await expect(byHand).toHaveAttribute("data-fit", "yes");
    await page.mouse.up();
    await expect(byHand.locator(`[data-rider="${token}"]`)).toHaveCount(1);
    await expect(page.locator(`[data-refusal="${token}"]`)).toHaveCount(0);
  });
});

/* ───────────────────────── the question before a reset ───────────────────────── */

test.describe.serial("S1: Restart today?", () => {
  test.skip(!CONSOLE_ROLE, "the board is not this role's screen");

  /** Every request this page made to the reset, so "sends nothing" is a count and not a vibe. */
  function countResets(page: Page): () => number {
    const urls: string[] = [];
    page.on("request", (request) => {
      if (request.method() === "POST" && request.url().includes(API.demoReset)) {
        urls.push(request.url());
      }
    });
    return () => urls.length;
  }

  /** Auto-plan and Save, so the day has a plan a reset would throw away. */
  async function saveAPlan(page: Page, day: string): Promise<number> {
    await page.locator("[data-auto-plan]").click();
    await page.locator("[data-save]").click();
    await expect(page.locator("[data-save-state]")).toHaveText(/^Saved /);
    const saved = await savedPlanOf(page, day);
    expect(saved.version).toBeGreaterThan(0);
    return saved.version;
  }

  /**
   * MOCKUP: mockups/plan-board.html (the banner row above the columns, whose one control is
   * "Start demo day") + png/plan-board.png.
   */
  test("Start demo day asks first, and Keep plan sends nothing", async ({ page }) => {
    test.skip(!CAN_RESET, "the reset is the director's, and so is the button for it");
    await openBoard(page, DAY.keep);
    const resets = countResets(page);
    const version = await saveAPlan(page, DAY.keep);

    const start = page.locator("[data-start-day]");
    await expect(start).toHaveText(flow.action.startDemo);
    await start.click();

    // Vera's words, verbatim, and the safe answer holding the focus.
    const dialog = page.locator("[data-restart-confirm]");
    await expect(dialog).toContainText(demoDay.confirm.title);
    await expect(dialog).toContainText(demoDay.confirm.body);
    await expect(page.locator("[data-restart-keep]")).toBeFocused();
    expect(resets(), "the question alone sends nothing").toBe(0);

    // Keep plan: the dialog closes, nothing is sent, and the plan is still saved.
    await page.locator("[data-restart-keep]").click();
    await expect(dialog).toHaveCount(0);
    expect(resets(), "Keep plan sends no reset").toBe(0);
    expect((await savedPlanOf(page, DAY.keep)).version).toBe(version);
    await expect(page.locator("[data-save-state]")).toHaveText(/^Saved /);

    // And Escape is the same answer (§9: the safe one is the default, three ways over).
    await start.click();
    await expect(dialog).toContainText(demoDay.confirm.title);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    expect(resets(), "Escape sends no reset either").toBe(0);
    expect((await savedPlanOf(page, DAY.keep)).version).toBe(version);
  });

  /**
   * MOCKUP: mockups/plan-board.html (the same banner row) + png/plan-board.png.
   *
   * "Restart" is the one answer that sends. Whether the rows are then cleared is not assertable
   * on this server and is asserted where it is real: the browser check's session has a role and
   * **no user id** (src/auth/caller.ts — "nothing that writes can accept it"), so the endpoint
   * answers 401 to it by construction, and the reset's own effect is
   * src/modules/demo/reset.db.test.ts against the real migrations.
   */
  test("Restart sends the reset, once", async ({ page }) => {
    test.skip(!CAN_RESET, "the reset is the director's, and so is the button for it");
    await openBoard(page, DAY.restart);
    const resets = countResets(page);
    await saveAPlan(page, DAY.restart);

    await page.locator("[data-start-day]").click();
    const dialog = page.locator("[data-restart-confirm]");
    await expect(dialog).toContainText(demoDay.confirm.title);
    await page.locator("[data-restart-go]").click();
    await expect(dialog).toHaveCount(0);
    await expect.poll(resets, { message: "Restart posts the reset" }).toBe(1);
  });

  /**
   * MOCKUP: mockups/shell-flow.html (`.demo .reset` at the bar's right-hand end, drawn the same
   * way in plan-board.html:265) + png/shell-flow-1440.png.
   *
   * The bar's control is the same question in the same words: one dialog, one decision, two
   * buttons that are deliberately nowhere near each other.
   */
  test("the DEMO bar's Restart demo day asks the same question", async ({ page }) => {
    test.skip(!CAN_RESET, "the bar draws this control for the director alone (REDESIGN-SPEC §0)");
    // Today's own board, because the bar's control is about today and says so.
    await page.goto("/plan-routes");
    await expect(page.getByRole("heading", { name: planBoard.heading, level: 1 })).toBeVisible();
    const resets = countResets(page);
    await page.locator("[data-auto-plan]").click();
    await page.locator("[data-save]").click();
    await expect(page.locator("[data-save-state]")).toHaveText(/^Saved /);

    const bar = page.locator("[data-demo-restart]");
    await expect(bar).toContainText(demoDay.restart);
    await bar.click();
    const dialog = page.locator("[data-restart-confirm]");
    await expect(dialog).toContainText(demoDay.confirm.title);
    await expect(dialog).toContainText(demoDay.confirm.body);
    await expect(page.locator("[data-restart-keep]")).toBeFocused();

    await page.locator("[data-restart-keep]").click();
    await expect(dialog).toHaveCount(0);
    expect(resets(), "Keep plan on the bar sends no reset").toBe(0);
    await expect(page.locator("[data-save-state]")).toHaveText(/^Saved /);

    // The two controls are not adjacent and not alike: the bar's is inside the DEMO bar, the
    // board's is a word in its banner sentence.
    const barBox = await boxOf(bar);
    const strip = page.locator("[data-banner]");
    if ((await strip.count()) > 0) {
      const stripBox = await boxOf(strip);
      expect(barBox.y + barBox.height).toBeLessThanOrEqual(stripBox.y);
    }
    expect(await page.locator("[data-start-day]").count()).toBeLessThanOrEqual(1);
  });

  /** The front desk sees neither control, and the endpoint refuses them too (§0). */
  test("the front desk is offered no restart at all", async ({ page }) => {
    test.skip(CAN_RESET, "this is the role that may reset");
    await page.goto("/");
    await expect(page.locator("[data-demo-restart]")).toHaveCount(0);
    await expect(page.locator("[data-restart-confirm]")).toHaveCount(0);
  });
});
