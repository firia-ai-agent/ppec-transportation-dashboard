/**
 * The demo day's Start, in a real browser — the founder's click, repeated.
 *
 * "The start demo data button still doesn't work" (founder on prod, 2026-10-17 14:40 ET). The
 * button was rendered inert, with the reason in a tooltip, and a unit test cannot tell the
 * difference between a control that works and one that merely looks right in the markup. So this
 * is the whole path with a real mouse: the readout before the press, the readout after it, the
 * board moving with the same clock, the button that offers the way back, and the way back taken.
 *
 * It also holds the two things the report was really about. The button looks clickable (the
 * pointer, measured), and nothing explains itself on hover — there is nothing left to explain,
 * and a phone has no hover.
 *
 * No database and no credentials: the server runs with the test-only synthetic session
 * (playwright.config.ts, src/domain/access/map-view.ts), and starting the clock asks the server
 * for nothing at all — which is why the same press works on a preview, where the demo reset
 * endpoint refuses because the database there is read-only.
 */
import { expect, test, type Locator } from "@playwright/test";
import { board as boardCopy, fill, scenarioClock } from "../src/ui/copy";
import {
  expectDemoBarPinned,
  expectNoInternalCodes,
  expectVioletOnlyOnDemoChrome,
  shot,
} from "./helpers";

/** A child whose van is reporting a position, so their row ages as the day walks. */
const RIDING_CHILD = "Zoe B.";

/** One row's opener: a child and which of their two rides this row is. */
const opener = (child: string, ride: string = boardCopy.amSpoken) =>
  fill(boardCopy.openRow, { child, ride }) as string;

/** A time of day and nothing else: "7:42 AM". */
const CLOCK_TIME = /^\d{1,2}:\d{2} [AP]M$/;

/** The words an element is showing, trimmed — what a founder reads off the screen. */
const text = async (locator: Locator): Promise<string> => (await locator.innerText()).trim();

test("Start demo day starts the day, the board follows, and the reset puts both back", async ({
  page,
}) => {
  await page.goto("/today");

  const readout = page.locator('[data-scenario-clock="readout"]');
  const start = page.getByRole("button", { name: scenarioClock.start });

  // Before the press: the readout says the demo has not started, and the button says what it
  // would start (COPY-GUIDE §52).
  await expect(readout).toHaveText(scenarioClock.notStarted);
  await expect(start).toBeVisible();
  await expect(start).toBeEnabled();
  await expect(start).not.toHaveAttribute("aria-disabled");
  // The founder's actual complaint, measured: it looks like a control, and nothing it says is
  // hidden behind a hover.
  expect(await start.evaluate((el) => getComputedStyle(el).cursor)).toBe("pointer");
  await expect(page.locator('[role="tooltip"]')).toHaveCount(0);

  // The row the board will move on: this child's morning ride, with their van reporting.
  const row = page
    .getByRole("row")
    .filter({ has: page.getByRole("button", { name: opener(RIDING_CHILD) }) });
  const rowBefore = await text(row);

  await start.click();

  // The press itself is the feedback: the readout is a scenario time, immediately.
  await expect(readout).toHaveText(CLOCK_TIME);
  const started = await text(readout);
  expect(started).not.toBe(scenarioClock.notStarted);

  // …and the same button is now the way back, with no second control added beside it.
  const reset = page.getByRole("button", { name: scenarioClock.reset });
  await expect(reset).toBeVisible();
  await expect(page.getByRole("button", { name: scenarioClock.start })).toHaveCount(0);

  // It keeps running: a later time on the readout, with nothing else touched.
  await expect
    .poll(async () => await text(readout), { timeout: 30_000, intervals: [500] })
    .not.toBe(started);
  await expect(readout).toHaveText(CLOCK_TIME);

  // The board is reading the same clock, so the day on screen has moved with it.
  await expect
    .poll(async () => await text(row), { timeout: 30_000, intervals: [500] })
    .not.toBe(rowBefore);

  // Still the demo, still honest about it: one DEMO bar, one Simulated chip, no new violet.
  await expectDemoBarPinned(page);
  await expectVioletOnlyOnDemoChrome(page);
  await expectNoInternalCodes(page);
  console.log("screenshot:", await shot(page, "scenario-clock-running"));

  await reset.click();

  // Back to where the page was rendered: the readout, the button and the board.
  await expect(readout).toHaveText(scenarioClock.notStarted);
  await expect(page.getByRole("button", { name: scenarioClock.start })).toBeVisible();
  expect(await text(row)).toBe(rowBefore);
});
