/**
 * One ramp check, through the three screens it is about, in a real browser (AT-04: equipment
 * found unknown at arrival).
 *
 * The ramp iPad used to be a surface that recorded onto itself — staff answered the §4.4
 * checklist, the solver said whether the run fitted, and the run's other two screens never heard
 * about it. This is the walk that proves it is one day now: answer the check on the iPad, read
 * what the solver does about it, click through to the plan a coordinator decides from and to the
 * Today board, and find the same children in the same vans with the same words on all three.
 *
 * The questions here are the ones no unit test can answer, because the answer is the screen: is
 * the panel actually reachable by tapping the checklist, does the link carry the result, and do
 * the other two screens open on it. The screenshots land in artifacts/ so a design review has
 * the picture beside the assertion.
 *
 * No database and no credentials: the server runs with the test-only synthetic session (see
 * playwright.config.ts), which grants a role and nothing else.
 */
import { expect, test, type Page } from "@playwright/test";
import { fill, rampIpad, rampReplan, vanName } from "../src/ui/copy";
import {
  boxOf,
  expectDemoBarPinned,
  expectNoInternalCodes,
  expectVioletOnlyOnDemoChrome,
  overlaps,
  shot,
} from "./helpers";

/** The three children the scenario puts on the convertible van's afternoon run. */
const CHAIR_CHILD = "Zoe B.";
const MOVED = ["Owen C.", "Ivy H."] as const;

const CONVERTIBLE = vanName("convertible van");
const CENTER_VAN = vanName("center van");

/** One checklist row, found by the question it asks rather than by its place on the page. */
function answerRow(page: Page, label: string) {
  return page.getByRole("group", { name: label, exact: true });
}

async function answer(page: Page, label: string, choice: string) {
  await answerRow(page, label).getByRole("button", { name: choice, exact: true }).click();
}

/**
 * The convertible van arrives as planned with two of its three walking seats unusable — PRD
 * §18.2 step 6, answered on the checklist exactly as ramp staff would answer it.
 */
async function reportTwoSeatsOut(page: Page) {
  await answer(page, rampIpad.liftRow, rampIpad.answer.YES);
  await answer(page, rampIpad.latchRow, rampIpad.answer.YES);
  await answer(page, "Wheelchair position 1", rampIpad.positionAnswer.FREE);
  await answer(page, "Walking seat 1", rampIpad.positionAnswer.FREE);
  await answer(page, "Walking seat 2", rampIpad.positionAnswer.OUT);
  await answer(page, "Walking seat 3", rampIpad.positionAnswer.OUT);
}

test.describe("a ramp check that finds the wrong equipment re-plans the van", () => {
  test("the iPad takes the check, and the plan and the board show what it did", async ({ page }) => {
    /* ── 1. the ramp, on the day the board shows ── */
    await page.goto("/ramp-ipad");
    await expect(page.getByRole("heading", { name: rampIpad.heading })).toBeVisible();
    await expectDemoBarPinned(page);

    // The van at the ramp is the scenario's own, with the scenario's own children on it.
    const main = page.locator("main");
    await expect(main).toContainText("convertible van");
    for (const name of [CHAIR_CHILD, ...MOVED]) {
      await expect(main).toContainText(name);
    }

    // Nothing is answered yet, so the panel asks for the rest of the check rather than
    // announcing that three children have no van. That is the honest state of every morning.
    const panel = page.locator("#ramp-replan");
    await expect(panel).toContainText(rampIpad.notCheckedDetail);
    await expect(panel).not.toContainText(rampReplan.movedHeading);
    await expect(page.getByRole("link", { name: rampReplan.openPlan })).toHaveCount(0);

    /* ── 2. answer the §4.4 checklist ── */
    await reportTwoSeatsOut(page);

    // The run no longer fits the van it was planned for, and the solver says what to do: the
    // chair stays in the van that holds her, the two walking riders go to the van with seats.
    await expect(panel).toContainText(rampReplan.changedDetail);
    await expect(panel).toContainText(
      fill(rampReplan.stays, { child: CHAIR_CHILD }),
    );
    for (const child of MOVED) {
      await expect(panel).toContainText(fill(rampReplan.moved, { child, vehicle: CENTER_VAN }));
    }
    // A proposal, and the panel says so: nothing is locked and no family has been told.
    await expect(panel).toContainText(rampReplan.decides);
    await shot(page, "ramp-replan-ipad");

    /* ── 3. the link carries the result to the plan ── */
    const toPlan = page.getByRole("link", { name: rampReplan.openPlan });
    await expect(toPlan).toBeVisible();
    // Both ways on are offered at once; the board's is followed in step 4.
    const boardHref = await page
      .getByRole("link", { name: rampReplan.openBoard })
      .getAttribute("href");
    expect(boardHref ?? "").toContain("/today?arrival=");
    await toPlan.click();

    await expect(page.getByRole("heading", { name: rampReplan.bannerHeading })).toBeVisible();
    const arrival = page.locator("[data-arrival]");
    await expect(arrival).toContainText("convertible van was checked at the ramp");

    // The two children the iPad moved are in the center van's lane on this screen, and the
    // chair is still in the convertible van's.
    const laneWith = (van: string) =>
      page.locator("[data-lane]").filter({ hasText: van }).first();
    for (const child of MOVED) {
      await expect(laneWith(CENTER_VAN)).toContainText(child);
    }
    await expect(laneWith(CONVERTIBLE)).toContainText(CHAIR_CHILD);
    await expectNoInternalCodes(page);
    await expectVioletOnlyOnDemoChrome(page);
    await shot(page, "ramp-replan-plan");

    /* ── 4. back to the ramp, and on to the board ── */
    // The banner's own way back. The iPad keeps its answers in client state and nothing here
    // writes them down (no database behind these screens), so the check is answered again —
    // which is also worth walking: the same answers produce the same link, every time.
    await page.getByRole("link", { name: rampReplan.backToRamp }).click();
    await expect(page.getByRole("heading", { name: rampIpad.heading })).toBeVisible();
    await reportTwoSeatsOut(page);

    const toBoard = page.getByRole("link", { name: rampReplan.openBoard });
    await expect(toBoard).toHaveAttribute("href", boardHref ?? "");
    await toBoard.click();

    await expect(page.getByRole("heading", { name: rampReplan.bannerHeading })).toBeVisible();
    // The ride that moved says so, as a note under the van rather than as the ride's own state.
    const movedNote = fill(rampReplan.rowMoved, { vehicle: CENTER_VAN });
    await expect(
      page.locator("tr").filter({ hasText: MOVED[0] }).filter({ hasText: movedNote }).first(),
    ).toContainText(movedNote);
    // And the ride nobody had to move says the one thing that did change about it.
    await expect(
      page
        .locator("tr")
        .filter({ hasText: CHAIR_CHILD })
        .filter({ hasText: rampReplan.rowChecked })
        .first(),
    ).toContainText(rampReplan.rowChecked);
    await expectNoInternalCodes(page);
    await shot(page, "ramp-replan-board");

    /* ── 5. the board without it, so a proposal is readable against the plain day ── */
    await page.getByRole("link", { name: rampReplan.clear }).click();
    await expect(page.getByRole("heading", { name: rampReplan.bannerHeading })).toHaveCount(0);
    await expect(page.locator("body")).not.toContainText(movedNote);
  });

  test("a chair measured bigger than the file leaves her with no van, and says what is missing", async ({
    page,
  }) => {
    await page.goto("/ramp-ipad");

    // The van is fine. The chair is not the chair the approved profile describes — a new
    // headrest and a tray — which is the whole of "equipment found unknown at arrival".
    await answer(page, rampIpad.liftRow, rampIpad.answer.YES);
    await answer(page, rampIpad.latchRow, rampIpad.answer.YES);
    for (const row of ["Wheelchair position 1", "Walking seat 1", "Walking seat 2", "Walking seat 3"]) {
      await answer(page, row, rampIpad.positionAnswer.FREE);
    }

    const panel = page.locator("#ramp-replan");
    await expect(panel).toContainText(rampReplan.nothingChanged);

    await page.getByRole("button", { name: rampIpad.measureChair }).click();
    await expect(page.locator("main")).toContainText("Measured 142 × 74 cm");

    /*
     * The sticky bar is the same verdict as the panel, measured on the real screen.
     *
     * It used to ask the solver its own question, about the chair the file describes rather than
     * the one the ramp just measured, so it read "Fits: 1 wheelchair, 3 walking seats" over a
     * panel holding Zoe B. — and the boarding lock followed the bar, which left "Confirm
     * boarding & securement" live for a run the solver had refused (Veri's review of 53423de).
     */
    const verdict = page.locator("#ramp-verdict");
    await expect(verdict).toContainText(
      fill(rampIpad.doesntFit, { phrase: rampIpad.deficitFootprint }),
    );
    await expect(verdict).not.toContainText("Fits");
    // Nobody boards a run the solver refused: every confirm button on the screen is off.
    const confirm = page.getByRole("button", { name: rampIpad.confirmBoarding });
    const confirms = await confirm.count();
    expect(confirms, "the riders each have a confirm button").toBeGreaterThan(0);
    for (let i = 0; i < confirms; i += 1) {
      await expect(confirm.nth(i)).toBeDisabled();
    }

    // No van in the scenario has a wheelchair place that takes a chair that size, so she is
    // held with the reason rather than quietly dropped — and a coordinator decides.
    await expect(panel).toContainText(rampReplan.heldHeading);
    await expect(panel).toContainText(CHAIR_CHILD);
    await expect(panel).toContainText(rampReplan.decides);
    await expectNoInternalCodes(page);
    await shot(page, "ramp-replan-measured-chair");

    // The plan opens on the same hold, with the same sentence.
    const held = await panel.locator("li").filter({ hasText: CHAIR_CHILD }).first().innerText();
    await page.getByRole("link", { name: rampReplan.openPlan }).click();
    await expect(page.locator("body")).toContainText(held.split("\n")[0].trim());
  });
});

/**
 * The same check on a phone, which is where the sticky bar stopped being a bar and became a
 * screen (Veri's review of 53423de, 2026-10-17).
 *
 * 390 × 844 is an iPhone in portrait, and at that size the verdict bar — a line per option the
 * solver ranked — grew to about 1054 px with "Show details" open: taller than the window it is
 * pinned to, so nothing behind it could be reached, including the two links that carry the check
 * to the screens that decide about it. Tapping "Open this on Plan routes" timed out.
 *
 * Both halves are measured here rather than eyeballed: the bar's own box against the window, and
 * the link's box against the bar's, with the collapsed bar and with the details open. And then
 * the link is actually followed, because "not covered" and "works" are different claims.
 */
test.describe("at 390 × 844, the phone the ramp would really hold", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("the verdict bar keeps to its share of the window, and the onward link works", async ({
    page,
  }) => {
    await page.goto("/ramp-ipad");
    await expect(page.getByRole("heading", { name: rampIpad.heading })).toBeVisible();
    await reportTwoSeatsOut(page);

    const verdict = page.locator("#ramp-verdict");
    const toPlan = page.getByRole("link", { name: rampReplan.openPlan });
    await expect(verdict).toBeVisible();
    await expect(toPlan).toBeVisible();

    /** The cap is `--layout-ramp-verdict-max-height`, read off the page rather than retyped. */
    const cap = await page.evaluate(() => {
      const value = getComputedStyle(document.documentElement)
        .getPropertyValue("--layout-ramp-verdict-max-height")
        .trim();
      const vh = Number.parseFloat(value);
      return { value, pixels: (vh / 100) * window.innerHeight };
    });
    expect(cap.value, "the bar's ceiling is a token in viewport units").toMatch(/vh$/);

    for (const details of [false, true]) {
      if (details) {
        await page.getByRole("button", { name: rampIpad.showDetails }).click();
        await expect(page.getByRole("button", { name: rampIpad.hideDetails })).toBeVisible();
      }
      const bar = await boxOf(verdict);
      expect(
        bar.height,
        `the bar is ${bar.height}px of an 844px window with details ${details ? "open" : "shut"}`,
      ).toBeLessThanOrEqual(cap.pixels + 1);

      // Scrolled to where a person tapping the link would be, the bar is not over it.
      await toPlan.scrollIntoViewIfNeeded();
      const link = await boxOf(toPlan);
      const pinned = await boxOf(verdict);
      expect(
        overlaps(link, pinned),
        `the verdict bar covers the onward link: ${JSON.stringify(link)} vs ${JSON.stringify(pinned)}`,
      ).toBe(false);
      // And the browser agrees about what is on top at the point a finger would land.
      const onTop = await toPlan.evaluate((el) => {
        const box = el.getBoundingClientRect();
        const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
        return hit !== null && (el === hit || el.contains(hit));
      });
      expect(onTop, "the onward link is the thing a tap at its centre would hit").toBe(true);
    }

    console.log("screenshot:", await shot(page, "ramp-replan-390"));

    // The claim this is all for: the link is followed, with the details still open.
    await toPlan.click();
    await expect(page.getByRole("heading", { name: rampReplan.bannerHeading })).toBeVisible();
    await expect(page.locator("[data-arrival]")).toContainText(
      "convertible van was checked at the ramp",
    );
    await expectNoInternalCodes(page);
  });
});
