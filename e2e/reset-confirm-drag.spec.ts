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
 *    .reset`, drawn identically in plan-board.html:265) — and Today itself (`<h1>Today`,
 *    shell-flow.html:144, with its step strip at :156), which the last describe below compares
 *    against the board.
 *  - `/workspace/ppec-redesign/mockups/ramp-arrival.html`: the Ramp iPad's Oxygen stepper
 *    (ramp-arrival.html:181) and the big "Confirm Van 1" beneath them (:183), which is where
 *    the counts both of those screens plan on are set.
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
 * EVERY TEST SETS UP ITS OWN STATE, and there is no serial block and no order between them
 * (#79's review). The board is stateful on one reused server, so each drag walk works on a date
 * of its own (`DAY` below), and each walk of the question states the one fact it is about —
 * today has a plan to lose, or today has none — before pressing anything.
 *
 * No database and no credentials. On this server the board's store is the memory fallback
 * (src/modules/plan/memory.ts) and the session is the browser check's own — a role and no user
 * id (src/auth/caller.ts), which is why the reset endpoint can be *asked* here and cannot
 * succeed: `handleDemoReset` answers 401 without a user. That the rows are actually cleared is
 * src/modules/demo/reset.db.test.ts, against the real migrations. The same fallback answers
 * "started" for every date (`dayContext`), which is why the board's own "Start demo day" is not
 * on any screen this check can open, and why the question is walked through the DEMO bar's
 * control — the same dialog, the same decision, the same request.
 */
import { expect, test, type Locator, type Page } from "@playwright/test";
import { board as boardCopy, demoDay, fill, flow, planBoard, sentence, vanArrival } from "../src/ui/copy";
import { API } from "../src/auth/access";
import { boxOf, expectNoInternalCodes } from "./helpers";

const ROLE = (process.env.E2E_DEMO_ROLE ?? "DIRECTOR").toUpperCase();
const CONSOLE_ROLE = ROLE === "DIRECTOR" || ROLE === "COORDINATOR";
/** The reset is the director's, and so is the control that calls it (src/auth/access.ts). */
const CAN_RESET = ROLE === "DIRECTOR";

const WIDE = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

/**
 * A DATE PER WALK, WHICH IS WHAT MAKES THESE TESTS INDEPENDENT OF EACH OTHER.
 *
 * The board is a stateful screen on one reused server, so a plan saved by one test would change
 * what the next one opens on. A date is a URL parameter (§9.3) and a plan is stored per date and
 * leg (`resolveDate` in src/modules/plan/when.ts takes any real date; the plan's key is
 * `date/leg`), so a test with a date of its own opens a board nothing else has touched — in any
 * order, and run alone.
 *
 * The walks of the question are not in here: the DEMO bar's control is about *today* and reads
 * today (src/ui/restart-confirm.ts `savedPlanToday`), so each of them states today's own state.
 */
const DAY = {
  drag: "2026-12-01",
  dragPhone: "2026-12-02",
  parity: "2026-12-03",
  family: "2026-12-04",
  /** The S1 of 2026-10-18: a van nobody has counted, full on the counts it is planned on. */
  full: "2026-12-05",
  /** The same S1: a van the ramp has counted, on a board of its own. */
  counted: "2026-12-06",
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

/**
 * Three walks, three dates, no order between them: each opens a board of its own (see `DAY`), so
 * one of them failing says nothing about the other two and any one can be run alone.
 */
test.describe("S1: Zoe B. onto Van 1", () => {
  test.skip(!CONSOLE_ROLE, "the board is not this role's screen");

  /**
   * MOCKUP: mockups/plan-board.html + png/plan-board.png (1440) — the Unassigned column beside
   * Van 1, and the "Drop here" target in an empty van column (plan-board.html:333).
   */
  test("lands on Van 1 at 1440, and stays there after Save and a reload", async ({ page }) => {
    await openBoard(page, DAY.drag);
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
    //    eligibility check the drag runs. Since Vera's 390 pass it is held open, not printed under
    //    every card, so open it the way rework-ramp-board.spec.ts:487 does (PPE-78).
    await expect(page.locator("[data-move-hint]")).toBeVisible();
    await zoe.click({ button: "right" });
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

/* ───────────────────────── the Family drives lane ───────────────────────── */

/**
 * FIRIA'S SECOND REPORT, 2026-10-18: the Family drives group was one collapsed line reading "3".
 *
 * MOCKUP: mockups/plan-board.html + png/plan-board.png (1440) and png/plan-board-390.png — the
 * Unassigned column and the two groups at the foot of it (plan-board.html's `.group`), beside
 * the three van columns a card is dragged onto.
 *
 * Its own day (`DAY.family`), its own plan, no order against anything else in this file. The
 * board opens started on this server — the memory store answers "started" for every date
 * (src/modules/plan/memory.ts `dayContext`), which is the same thing the Start the founder
 * pressed leaves behind — so the walk begins where their report begins: at the lane.
 *
 * What a browser is needed for: that the lane is open with no click, that what is in it is the
 * same card Unassigned draws rather than a name, and that a real drag of one of those cards onto
 * a real van survives a Save and a reload — both ways. The arithmetic underneath is unit-tested
 * (src/app/plan-routes/board/family-drives.test.ts) and the rows are
 * src/modules/plan/place.db.test.ts.
 */
test.describe("S1: Family drives is an open lane of cards", () => {
  test.skip(!CONSOLE_ROLE, "the board is not this role's screen");

  const FAMILY_CHILDREN = ["Ana S.", "Beni A.", "Cleo M."];
  const lane = (page: Page): Locator => page.locator('[data-bucket="FAMILY_DRIVES"]');
  const laneList = (page: Page): Locator => page.locator('[data-bucket-list="FAMILY_DRIVES"]');

  test("opens with Ana S., Beni A. and Cleo M. as cards, and carries one onto a van and back", async ({
    page,
  }) => {
    await openBoard(page, DAY.family);

    /* ── 1. the lane, open, with a card each — and Absent untouched beside it ── */
    await expect(lane(page).locator("button[aria-expanded]")).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    await expect(lane(page)).toContainText(planBoard.familyDrives);
    await expect(laneList(page)).toBeVisible();
    await expect(laneList(page).locator("[data-rider]")).toHaveCount(FAMILY_CHILDREN.length);
    for (const name of FAMILY_CHILDREN) {
      const child = laneList(page).locator("[data-rider]").filter({ hasText: name });
      await expect(child, name).toHaveCount(1);
      // A full card and not a name: it has the grip's own `Move to…` control beside it.
      const token = await child.getAttribute("data-rider");
      await expect(page.locator(`[data-move-to="${token}"]`), name).toHaveCount(1);
    }
    // No kerb of ours: the card's second line is the lane's own label, the same words the card
    // sits under (Vera's 390 pass, 2026-10-18 — it used to read "No pickup stop").
    await expect(laneList(page).first()).toContainText(planBoard.familyDrives);

    // ABSENT IS UNCHANGED (founder 6:49): still a count row, still closed, no list at all.
    const absent = page.locator('[data-bucket="ABSENT"]');
    await expect(absent).toContainText(planBoard.absent);
    await expect(absent.locator("button[aria-expanded]")).toHaveAttribute("aria-expanded", "false");
    await expect(page.locator('[data-bucket-list="ABSENT"]')).toHaveCount(0);

    /* ── 2. Ana S. onto Van 1, the same off-centre drag the S1 walk makes ── */
    const vanOne = vans(page).first();
    await expect(vanOne).toHaveAttribute("aria-label", "Van 1");
    const ana = laneList(page).locator("[data-rider]").filter({ hasText: "Ana S." });
    const token = await ana.getAttribute("data-rider");
    const vanId = await vanOne.getAttribute("data-van");

    await liftOffCentre(page, ana, vanOne);
    // The one eligibility rule answers for her too: she needs a seat, and Van 1 is empty.
    await expect(vanOne).toHaveAttribute("data-fit", "yes");
    await page.mouse.up();
    expect(await expectLandedOrRefused(page, "Ana S.", vanOne, lane(page))).toBe("LANDED");

    /* ── 3. Save, and it is a row: the reload draws her in the van ── */
    await page.locator("[data-save]").click();
    await expect(page.locator("[data-save-state]")).toHaveText(/^Saved /);
    expect((await savedPlanOf(page, DAY.family)).plan[token ?? ""]).toMatchObject({
      bucket: "VAN",
      vanId,
    });
    await page.reload();
    await expect(vans(page).first().locator(`[data-rider="${token}"]`)).toHaveCount(1);
    await expect(laneList(page).locator(`[data-rider="${token}"]`)).toHaveCount(0);
    // The other two are still in the lane, and it is still open after the reload.
    await expect(laneList(page).locator("[data-rider]")).toHaveCount(FAMILY_CHILDREN.length - 1);

    /* ── 4. and back into Family drives, saved, and still there after a reload ── */
    await liftOffCentre(page, vans(page).first().locator(`[data-rider="${token}"]`), lane(page));
    await page.mouse.up();
    await expect(laneList(page).locator(`[data-rider="${token}"]`)).toHaveCount(1);
    await expect(toast(page)).toContainText(planBoard.familyDrives);

    await page.locator("[data-save]").click();
    await expect(page.locator("[data-save-state]")).toHaveText(/^Saved /);
    expect((await savedPlanOf(page, DAY.family)).plan[token ?? ""]).toMatchObject({
      bucket: "FAMILY_DRIVES",
      vanId: null,
    });
    await page.reload();
    await expect(laneList(page).locator("[data-rider]")).toHaveCount(FAMILY_CHILDREN.length);
    await expect(laneList(page).locator(`[data-rider="${token}"]`)).toHaveCount(1);
    await expect(vans(page).first().locator(`[data-rider="${token}"]`)).toHaveCount(0);

    await expectNoInternalCodes(page);
  });
});

/* ───────────────────────── the question before a reset ───────────────────────── */

/**
 * NOT SERIAL, AND NOTHING HANDED ON — every test here puts the server into the state it is about.
 *
 * #79's blocker was the shape rather than the assertions: the first test pressed "Start demo day"
 * on a board that had just saved a plan, and those two cannot both be true. The strip only offers
 * Start while the day has *not* been started (lines.ts `boardBanner`), and a day that has not
 * started has no riders to plan and a disabled Save — so the test could never pass, and because
 * the block was `describe.serial` the three after it never ran at all.
 *
 * So the question is walked through the control this server actually draws: the DEMO bar's
 * "Restart demo day", on today, which is the day that control is about. The board's own "Start
 * demo day" is the *same* decision and the same request — one module, src/ui/restart-confirm.ts,
 * and one dialog — and it cannot be pressed in this browser check at all: the memory store the
 * check runs on answers "started" for every date it is asked about
 * (src/modules/plan/memory.ts `dayContext`), so the strip never has a Start to offer. What that
 * decision does for each answer is src/ui/restart-confirm.test.ts, which is where "a press with
 * nothing saved sends straight away" is proved for both controls at once.
 */
test.describe("S1: Restart today?", () => {
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

  /**
   * The leg `/plan-routes` opens with no `?leg=` in the address: Morning (`resolveLeg`, Firia's
   * 1:34 AM ET ruling). The board on screen below is this leg's, so the plan these tests save and
   * read is this leg's too — and the bar's control reads *both* legs (src/ui/restart-confirm.ts
   * `savedPlanToday`), so a plan on this one is a plan for it to ask about.
   */
  const TODAY_LEG = "am";

  /** Today's saved version on one leg, through the read-only board route the board itself reads. */
  async function savedToday(page: Page, leg: string = TODAY_LEG): Promise<number> {
    const response = await page.request.get(`${API.planBoard}?leg=${leg}`);
    expect(response.status()).toBe(200);
    return ((await response.json()) as { version: number }).version;
  }

  /**
   * Today's board with a plan saved on it — this test's own precondition, built by the screen's
   * own Auto-plan and Save and by nothing else.
   *
   * Saves only when this leg has nothing saved yet. A plan an earlier test (or an earlier spec)
   * saved is the same precondition, and the board correctly disables Save when what is on screen
   * is already what is stored, so pressing it again would be a wait on a button that is right to
   * be disabled. Either way the version it returns is the one the assertions compare against, and
   * the board on screen is showing it.
   */
  async function todayWithAPlan(page: Page): Promise<number> {
    await page.goto("/plan-routes");
    await expect(page.getByRole("heading", { name: planBoard.heading, level: 1 })).toBeVisible();
    await expect(vans(page)).toHaveCount(3);
    if ((await savedToday(page)) === 0) {
      await page.locator("[data-auto-plan]").click();
      await page.locator("[data-save]").click();
    }
    await expect(page.locator("[data-save-state]")).toHaveText(/^Saved /);
    const version = await savedToday(page);
    expect(version, "today has a plan a reset would throw away").toBeGreaterThan(0);
    return version;
  }

  /**
   * The bar's control, pressed, and the question it opens — in Vera's words, with the body
   * counting the vans this day runs rather than a number somebody typed (Veri's S2 on #79): the
   * count is the van columns on the board behind the dialog, and `demoDay.confirm.body` is the
   * one place the sentence is made.
   */
  async function askThroughTheBar(page: Page): Promise<Locator> {
    const bar = page.locator("[data-demo-restart]");
    await expect(bar).toContainText(demoDay.restart);
    await bar.click();
    const dialog = page.locator("[data-restart-confirm]");
    await expect(dialog).toContainText(demoDay.confirm.title);
    await expect(dialog).toContainText(demoDay.confirm.body(await vans(page).count()));
    return dialog;
  }

  /**
   * MOCKUP: mockups/shell-flow.html (`.demo .reset` at the bar's right-hand end, drawn the same
   * way in plan-board.html:265) + png/shell-flow-1440.png — and the board behind it,
   * mockups/plan-board.html + png/plan-board.png, whose three van columns the body counts.
   *
   * The safe answer, by the button and by Escape (the scrim is the same callback —
   * src/ui/ConfirmRestart.tsx). Neither sends anything, and the plan is still saved afterwards,
   * which is the whole claim of this commit.
   */
  test("Keep plan closes the question, sends nothing, and keeps the plan", async ({ page }) => {
    test.skip(!CAN_RESET, "the bar draws this control for the director alone (REDESIGN-SPEC §0)");
    const version = await todayWithAPlan(page);
    const resets = countResets(page);

    const dialog = await askThroughTheBar(page);
    // The safe answer holds the focus, so Enter is Keep plan too (§9).
    await expect(page.locator("[data-restart-keep]")).toBeFocused();
    expect(resets(), "the question alone sends nothing").toBe(0);

    await page.locator("[data-restart-keep]").click();
    await expect(dialog).toHaveCount(0);
    expect(resets(), "Keep plan sends no reset").toBe(0);
    expect(await savedToday(page), "Keep plan kept the plan").toBe(version);
    await expect(page.locator("[data-save-state]"), "the board still says it is saved").toHaveText(
      /^Saved /,
    );

    // And Escape is that same answer, on a dialog opened again from scratch.
    await askThroughTheBar(page);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    expect(resets(), "Escape sends no reset either").toBe(0);
    expect(await savedToday(page), "Escape kept the plan").toBe(version);

    /*
     * And while both are on this screen: the two restart controls are deliberately nowhere near
     * each other (the review's ask). The bar's is a pill in the violet chrome at the top of the
     * window; anything the board's own strip carries is below it, in the page.
     */
    const barBox = await boxOf(page.locator("[data-demo-restart]"));
    const strip = page.locator("[data-banner]");
    if ((await strip.count()) > 0) {
      const stripBox = await boxOf(strip);
      expect(barBox.y + barBox.height).toBeLessThanOrEqual(stripBox.y);
    }
    await expectNoInternalCodes(page);
  });

  /**
   * MOCKUP: mockups/shell-flow.html (the same control at the bar's right-hand end) +
   * png/shell-flow-1440.png.
   *
   * "Restart" is the one answer that sends, and it sends once. Whether the rows are then cleared
   * is not assertable on this server and is asserted where it is real: the browser check's
   * session has a role and **no user id** (src/auth/caller.ts), so `handleDemoReset` answers 401
   * to it by construction, and the reset's own effect is src/modules/demo/reset.db.test.ts
   * against the real migrations.
   */
  test("Restart sends the reset, once", async ({ page }) => {
    test.skip(!CAN_RESET, "the bar draws this control for the director alone (REDESIGN-SPEC §0)");
    await todayWithAPlan(page);
    const resets = countResets(page);

    const dialog = await askThroughTheBar(page);
    await page.locator("[data-restart-go]").click();
    await expect(dialog).toHaveCount(0);
    await expect.poll(resets, { message: "Restart posts the reset" }).toBe(1);
    // The answer is back — the control is pressable again, whichever answer it was — and the
    // press is still one request and not two.
    await expect(page.locator("[data-demo-restart]")).toBeEnabled();
    expect(resets(), "one press, one request").toBe(1);
  });

  /**
   * MOCKUP: mockups/shell-flow.html + png/shell-flow-1440.png (the bar's control), which is the
   * press "Start demo day" makes in mockups/plan-board.html's banner row — one decision, shared.
   *
   * NOTHING SAVED IS NOTHING TO WARN ABOUT: the press goes straight through, exactly as it did
   * before this commit, and no question is asked at all.
   *
   * The precondition is stated to the control rather than built on the server, and that is not a
   * convenience: this server cannot be *put* back into "nothing saved for today". The reset is
   * the only thing that clears a plan and it answers 401 here (above), so once any test has
   * saved today's plan the state is one-way — and a test that only passed when it ran first is
   * the fault this file was rewritten to remove. So the one read the decision is made from
   * (`GET /api/plan`, no date, both legs) answers "no plan", and everything else is real: the
   * real control, the real module, the real request, counted.
   */
  test("with nothing saved for today, the press asks nothing and resets once", async ({ page }) => {
    test.skip(!CAN_RESET, "the bar draws this control for the director alone (REDESIGN-SPEC §0)");
    await page.route(
      (url) => url.pathname === API.planBoard && !url.searchParams.has("date"),
      async (route) => {
        await route.fulfill({ json: { version: 0, plan: {}, savedAt: null, savedBy: null } });
      },
    );
    await page.goto("/plan-routes");
    await expect(page.getByRole("heading", { name: planBoard.heading, level: 1 })).toBeVisible();
    const resets = countResets(page);

    await page.locator("[data-demo-restart]").click();
    await expect.poll(resets, { message: "the press posts the reset" }).toBe(1);
    /*
     * And no question was asked. This is a count after the fact and still airtight: had the
     * dialog opened, nobody answered it, so it would still be on screen and there would be no
     * request at all.
     */
    await expect(page.locator("[data-restart-confirm]")).toHaveCount(0);
    expect(resets(), "one press, one request").toBe(1);
  });

  /** The front desk sees neither control, and the endpoint refuses them too (§0). */
  test("the front desk is offered no restart at all", async ({ page }) => {
    test.skip(CAN_RESET, "this is the role that may reset");
    await page.goto("/");
    await expect(page.locator("[data-demo-restart]")).toHaveCount(0);
    await expect(page.locator("[data-restart-confirm]")).toHaveCount(0);
  });
});
/* ──────────────── one van setup, read by the board and by Today ──────────────── */

/**
 * FIRIA'S THIRD REPORT, 2026-10-18: the board allowed six children and a wheelchair in a van,
 * while Today — about the same van, on the same day — said that van holds one chair and three
 * seats. Two capacity sources: the board's `van.setup` (today's `CHECKED`
 * `ops.vehicle_setup_day` row, else the shared default) and the seeded seating layouts Today's
 * fit check was reading (src/modules/demo/fixtures/standard.ts).
 *
 * MOCKUPS THESE TWO TESTS ARE ABOUT:
 *  - `/workspace/ppec-redesign/mockups/plan-board.html` — the van column's read-only count
 *    meters (plan-board.html:319 `.meters`, styled at :99) and the toolbar's Auto-plan;
 *  - `/workspace/ppec-redesign/mockups/ramp-arrival.html` — the Ramp iPad: the Oxygen stepper
 *    (ramp-arrival.html:181) and the big "Confirm Van 1" with "Tomorrow starts from this"
 *    beneath it (ramp-arrival.html:183);
 *  - `/workspace/ppec-redesign/mockups/shell-flow.html` — Today (`<h1>Today`, shell-flow.html:144)
 *    with its step strip (:156), which is the screen whose rows must agree with that board.
 *
 * WHAT ONLY A BROWSER CAN ANSWER. The arithmetic and the rows are unit- and db-tested
 * (src/app/(app)/today/one-van-setup.test.ts, src/app/(app)/today/saved-plan.db.test.ts "one
 * stored setup, two screens"). What those cannot say is whether the two *screens* a person walks
 * between show one answer: the meter a coordinator reads, the refusal the card gets, the stepper
 * the front desk pushes, and the step on Today's row, all from the one stored setup.
 *
 * EACH TEST SETS UP ITS OWN STATE. The first works on a date of its own (`DAY.full`), where
 * nobody has counted a van. The second is about *today*, because that is the only day the Ramp
 * iPad writes, so it states today's counts through the iPad itself before changing one of them —
 * and puts the counter back at the end, so it leaves today as it found it.
 */
test.describe("S1: one van setup, read by the board and by Today", () => {
  test.skip(!CONSOLE_ROLE, "the board is not this role's screen");

  const lane = (page: Page): Locator => page.locator('[data-bucket-list="FAMILY_DRIVES"]');
  const stepper = (page: Page, counter: string): Locator =>
    page.locator(`[data-stepper="${counter}"]`);
  /** The two buttons of a stepper, in the order the iPad draws them (VanArrival.tsx). */
  const fewer = (page: Page, counter: string): Locator =>
    stepper(page, counter).getByRole("button").first();
  const more = (page: Page, counter: string): Locator =>
    stepper(page, counter).getByRole("button").last();
  /** Zoe B.'s rows on Today — both of her rides, so a step cannot hide on the other one. */
  const zoeRows = (page: Page): Locator =>
    page.locator("tbody tr").filter({ hasText: "Zoe B." });

  /** A card dragged into a van and asserted to have landed in it — the board's ordinary Move. */
  const dragInto = async (page: Page, name: string, van: Locator): Promise<void> => {
    await liftOffCentre(page, card(page, name), van);
    await expect(van, `${name} fits`).toHaveAttribute("data-fit", "yes");
    await page.mouse.up();
    await expect(van.locator("[data-rider]").filter({ hasText: name })).toHaveCount(1);
  };

  /**
   * MOCKUP: plan-board.html (the `.meters` row under a van's header, :319) + the Family drives
   * lane at the foot of Unassigned.
   *
   * An unchecked van is planned on its default counts and says so in words ("Using default
   * setup"). A coordinator fills it to those counts; the next card let go on it is refused, stays
   * where it was, and carries one coral line naming the van and what ran out. Before this fix
   * Today checked the same van against a seeded seating layout instead, so it reported the plan
   * the board had just taken.
   *
   * Filling it takes three drags because the default is Firia's six seats (ruling of 2026-10-18
   * 8:49 AM ET, src/config/vans.ts): Auto-plan's afternoon leaves Van 1 with three of them used,
   * and Mia R., Owen C. and Theo V. are the three a coordinator moves across. Their car seats are
   * the three that van carries too, so it ends the drags exactly at two counters and over none —
   * the same arrangement src/app/(app)/today/one-van-setup.test.ts holds in arithmetic.
   */
  test("an unchecked van, full on its default counts, refuses the drop with the coral reason", async ({
    page,
  }) => {
    await openBoard(page, DAY.full);
    // Nobody has counted a van on this date, and the **board** states the assumption it stands
    // on — once, in its banner, since Vera's check of b3453cd; the columns no longer repeat it.
    await expect(page.locator("[data-banner]")).toContainText(flow.banner.usingDefault);
    await expect(vans(page).first()).not.toContainText(planBoard.usingDefault);

    await page.locator("[data-auto-plan]").click();
    const vanOne = vans(page).first();
    for (const name of ["Mia R.", "Owen C.", "Theo V."]) await dragInto(page, name, vanOne);
    // Each of those landings put a toast up (§1.3's four seconds). Wait it out, so the refusal
    // below is asserted against a board with nothing already on it.
    await expect(toast(page), "the landing toasts have gone").toHaveCount(0, { timeout: 10_000 });

    // The van whose Seats meter is full — "full" is the meter's own word for used === total, so
    // this test does not write down a number the config owns (src/config/vans.ts).
    const full = vans(page)
      .filter({ has: page.locator('[data-counter="seats"][data-level="full"]') })
      .first();
    await expect(full).toHaveCount(1);
    const label = (await full.getAttribute("aria-label")) ?? "Van";
    expect(label, "and it is the one the drags filled").toBe(
      await vanOne.getAttribute("aria-label"),
    );

    // Ana S. is driven by her family today and may still be put in a van (#79) — she needs a
    // seat like anybody else, and this van has none left.
    const ana = lane(page).locator("[data-rider]").filter({ hasText: "Ana S." });
    const token = await ana.getAttribute("data-rider");
    await liftOffCentre(page, ana, full);
    // While she is held the column says what it would do with her, and it is a no.
    await expect(full).toHaveAttribute("data-fit", "no");
    await page.mouse.up();

    await expect(lane(page).locator(`[data-rider="${token}"]`), "she did not move").toHaveCount(1);
    await expect(full.locator(`[data-rider="${token}"]`)).toHaveCount(0);
    await expect(page.locator(`[data-refusal="${token}"]`)).toHaveText(
      fill(planBoard.rejectCard.SEAT, { van: label }),
    );
    // A refusal belongs on the card: no toast, and still said once for the ear.
    await expect(toast(page)).toHaveCount(0);
    await expect(announced(page)).toContainText("Ana S.");
    await expectNoInternalCodes(page);
  });

  /**
   * MOCKUP: ramp-arrival.html:181 (the Oxygen stepper) and :183 (Confirm Van 1), then
   * plan-board.html:319 (Van 1's meters) and shell-flow.html:144 (Today).
   *
   * The walk the report is about, in three screens: the front desk counts Van 1 at the ramp, and
   * after a reload the coordinator's board and Today both plan that van on what was counted.
   * Zoe B. travels with oxygen and the morning has her on Van 1, so the mount is the one counter
   * that moves both screens at once — and when it is gone, Auto-plan stops putting her there and
   * Today's row asks for her to be moved. Put back, both screens let go of it.
   */
  test("after the ramp changes a counter, the board and Today both follow it", async ({ page }) => {
    /* ── Van 1 by its own id: the ramp iPad is addressed with it (§9.3's `?van=`) ── */
    await openBoard(page, DAY.counted);
    const vanOne = vans(page).first();
    await expect(vanOne).toHaveAttribute("aria-label", "Van 1");
    const vanId = await vanOne.getAttribute("data-van");
    const oxygen = () => page.locator(`[data-van="${vanId}"] [data-counter="oxygenMounts"]`);
    // The dated half opens the Ramp on the board's own leg (boardUrl is `leg=pm`); with no leg the
    // Ramp opens on Morning, which has no plan on this date (#82 resolveLeg, PPE-77).
    const rampOn = (day?: string) =>
      day ? `/ramp-ipad?date=${day}&leg=pm&van=${vanId}` : `/ramp-ipad?van=${vanId}`;

    /* ── 0. A saved plan for this date and leg, so the Ramp has riders to open on (PPE-77) ──
     * Since #82 the Ramp shows "No plan saved" for a date+leg with no plan. Auto-plan and Save
     * first; Zoe B. goes back to Unassigned before the save, because step 1 drags her from there. */
    await page.locator("[data-auto-plan]").click();
    const zoeCard = () => card(page, "Zoe B.");
    const zoeToken = await zoeCard().getAttribute("data-rider");
    if ((await unassigned(page).locator(`[data-rider="${zoeToken}"]`).count()) === 0) {
      await liftOffCentre(page, zoeCard(), unassigned(page));
      await page.mouse.up();
      await expect(unassigned(page).locator(`[data-rider="${zoeToken}"]`)).toHaveCount(1);
    }
    await page.locator("[data-save]").click();
    await expect(page.locator("[data-save-state]")).toHaveText(/^Saved /);

    /* ── 1. THE BOARD, on a date of its own: the mount counted away, and the drag refused ── */
    await page.goto(rampOn(DAY.counted));
    await expect(
      page.locator('[data-tab][aria-current="page"]'),
      "the iPad opens on the van the address names",
    ).toContainText("Van 1");
    // It opens on this van's default — nobody has counted it on this date — and the front desk
    // finds the mount missing.
    await expect(stepper(page, "oxygenMounts").locator("output")).toHaveText("1");
    await fewer(page, "oxygenMounts").click();
    await expect(stepper(page, "oxygenMounts").locator("output")).toHaveText("0");
    await page.locator("[data-confirm]").click();
    await expect(page.locator("[data-confirm]")).toContainText(vanArrival.confirmed);

    await openBoard(page, DAY.counted);
    await expect(vanOne, "the column stops standing on a default").toContainText(
      planBoard.checked,
    );
    await expect(oxygen(), "no mount, counted").toContainText("/0");
    await expect(oxygen()).toHaveAttribute("data-level", "none");
    // Zoe B. travels with oxygen. Van 1 is empty on this board and still cannot take her, and
    // the coral line names the counter the ramp changed rather than a seat.
    const zoe = await card(page, "Zoe B.").getAttribute("data-rider");
    await liftOffCentre(page, card(page, "Zoe B."), vanOne);
    await expect(vanOne).toHaveAttribute("data-fit", "no");
    await page.mouse.up();
    await expect(unassigned(page).locator(`[data-rider="${zoe}"]`), "she did not move").toHaveCount(
      1,
    );
    await expect(page.locator(`[data-refusal="${zoe}"]`)).toHaveText(
      fill(planBoard.rejectCard.OXYGEN, { van: "Van 1" }),
    );
    await expectNoInternalCodes(page);

    /* ── 2. AND TODAY, which is the only day it reads — so this half states today's counts ── */
    await page.goto(rampOn());
    await expect(stepper(page, "oxygenMounts").locator("output")).toHaveText("1");
    await page.locator("[data-confirm]").click();
    await expect(page.locator("[data-confirm]")).toContainText(vanArrival.confirmed);

    await page.goto("/today");
    await expect(zoeRows(page).first()).toBeVisible();
    await expect(
      zoeRows(page).locator('[data-step="MOVE_TO_FITTING_VAN"]'),
      "with the mount on board there is nothing to move her for",
    ).toHaveCount(0);

    await page.goto(rampOn());
    await fewer(page, "oxygenMounts").click();
    await expect(stepper(page, "oxygenMounts").locator("output")).toHaveText("0");
    await page.locator("[data-confirm]").click();
    await expect(page.locator("[data-confirm]")).toContainText(vanArrival.confirmed);

    // The board and Today, both reloaded, on the one number the front desk just set.
    await page.goto("/plan-routes");
    await expect(oxygen(), "the board reads today's count").toContainText("/0");
    await page.goto("/today");
    const asked = zoeRows(page).locator('[data-step="MOVE_TO_FITTING_VAN"]');
    // Her morning, and only her morning: the afternoon's van has not been reported on at all, so
    // that row is honestly pending rather than a second copy of this answer.
    await expect(asked, "the morning has her on Van 1, which has no mount").toHaveCount(1);
    await expect(asked.first()).toHaveText(
      sentence(fill(boardCopy.nextSteps.MOVE_TO_FITTING_VAN, { child: "Zoe B." })),
    );
    await expect(zoeRows(page).first(), "the van they disagreed about").toContainText("Van 1");
    await expectNoInternalCodes(page);

    /* ── 3. put back, and both screens let go of it — today is left as it was found ── */
    await page.goto(rampOn());
    await more(page, "oxygenMounts").click();
    await expect(stepper(page, "oxygenMounts").locator("output")).toHaveText("1");
    await page.locator("[data-confirm]").click();
    await expect(page.locator("[data-confirm]")).toContainText(vanArrival.confirmed);

    await page.goto("/plan-routes");
    await expect(oxygen()).toContainText("/1");
    await page.goto("/today");
    await expect(zoeRows(page).locator('[data-step="MOVE_TO_FITTING_VAN"]')).toHaveCount(0);
  });
});
