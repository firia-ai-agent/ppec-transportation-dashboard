/**
 * The demo day's one control, in a real browser — the founder's click, repeated.
 *
 * "The start demo data button still doesn't work" (founder on prod, 2026-10-17 14:40 ET). The
 * button was rendered inert, with the reason in a tooltip, and a unit test cannot tell the
 * difference between a control that works and one that merely looks right in the markup. So this
 * is the whole path with a real mouse: the readout before the press, the readout after it, the
 * board moving with the same clock, the confirm the second press opens, and the way back taken.
 *
 * Since the founder's final ruling (2026-10-17 14:44 ET, DECISION-LEDGER row 72) the press is two
 * acts in one: the demo's **data** back to the start of the day — `POST /api/demo/reset` — and
 * then the clock. So each test below fixes **what the endpoint answers** with `page.route` and
 * asserts what the screen then does, which is the half only a browser can show:
 *
 *  - the reset ran → the day runs, and the second press is a confirm;
 *  - the reset refused by design, as it does on every preview deployment (the database there is
 *    production's, served read-only — DECISION-LEDGER #43) → the clock runs anyway and one line
 *    says the reset is the live site's;
 *  - the reset failed → nothing starts, and the line says so.
 *
 * And one case no unit test can reach at all: the **reload**. The clock is a module store, so a
 * refresh used to come back to "Demo not started" and the next press was an unguarded first
 * press, taking the demo with it. The start is remembered in the tab's `sessionStorage` now, and
 * the last test below refreshes a real page to read what comes back.
 *
 * Who the endpoint lets in is not stubbed anywhere: src/auth/idswap.test.ts and
 * src/auth/guard-matrix.test.ts call the real handler, role by role, against a real database,
 * and e2e/demo-control-roles.spec.ts reads the control off the screen for the role this run is
 * signed in as. This file is about the press.
 *
 * No database and no credentials: the server runs with the test-only synthetic session
 * (playwright.config.ts, src/domain/access/map-view.ts), which is also why the reset itself is
 * answered here rather than run — there is no database behind this server to put back.
 */
import { expect, test, type Locator, type Page } from "@playwright/test";
import { API } from "../src/auth/access";
import { board as boardCopy, demoReset, fill, scenarioClock } from "../src/ui/copy";
import { DEMO_RESET_REFUSAL } from "../src/modules/demo/refusal";
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

/*
 * Every button below is located with `exact: true`, and it matters: `getByRole`'s `name` is a
 * case-insensitive **substring** by default, and "Restart demo day" contains "Start demo day" —
 * so the loose locator finds the restart button and "the Start is gone" can never fail.
 */

/** A time of day and nothing else: "7:42 AM". */
const CLOCK_TIME = /^\d{1,2}:\d{2} [AP]M$/;

/** The words an element is showing, trimmed — what a founder reads off the screen. */
const text = async (locator: Locator): Promise<string> => (await locator.innerText()).trim();

/** "7:42 AM" as minutes since midnight, so two readouts can be put in order. */
function minutesOf(readout: string): number {
  const m = /^(\d{1,2}):(\d{2}) ([AP])M$/.exec(readout);
  expect(m, `a clock time, not ${JSON.stringify(readout)}`).not.toBeNull();
  const [, h, min, half] = m as RegExpExecArray;
  return ((Number(h) % 12) + (half === "P" ? 12 : 0)) * 60 + Number(min);
}

/**
 * What the demo-reset endpoint answers for this test. Every case is a real POST from the real
 * button: the request is made, and this is the reply it gets.
 */
async function answerTheReset(
  page: Page,
  reply: { status: number; body: Record<string, unknown> },
): Promise<() => number> {
  let calls = 0;
  await page.route(API.demoReset, async (route) => {
    calls += 1;
    await route.fulfill({
      status: reply.status,
      contentType: "application/json",
      body: JSON.stringify(reply.body),
    });
  });
  return () => calls;
}

const readoutOf = (page: Page) => page.locator('[data-scenario-clock="readout"]');
const noteOf = (page: Page) => page.locator('[data-scenario-clock="note"]');
const errorOf = (page: Page) => page.locator('[data-scenario-clock="error"]');

test("Start demo day resets the demo and starts the day, and the board follows", async ({ page }) => {
  const resetCalls = await answerTheReset(page, { status: 200, body: { ok: true } });
  await page.goto("/today");

  const readout = readoutOf(page);
  const start = page.getByRole("button", { name: scenarioClock.start, exact: true });

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
  // No confirm on the first press: there is nothing of anybody's to lose yet.
  await expect(page.getByRole("dialog")).toHaveCount(0);

  // The row the board will move on: this child's morning ride, with their van reporting.
  const row = page
    .getByRole("row")
    .filter({ has: page.getByRole("button", { name: opener(RIDING_CHILD) }) });
  const rowBefore = await text(row);

  await start.click();

  // The data went back first: one POST to the reset endpoint, which is what starts the demo day.
  await expect.poll(resetCalls).toBe(1);

  // …and then the clock: the readout is a scenario time, and it is the feedback for the press.
  await expect(readout).toHaveText(CLOCK_TIME);
  const started = await text(readout);
  expect(started).not.toBe(scenarioClock.notStarted);

  // Nothing went wrong, so there is no line next to the button saying anything did.
  await expect(noteOf(page)).toHaveCount(0);
  await expect(errorOf(page)).toHaveCount(0);

  // The same button is now the way back, with no second control added beside it.
  const restart = page.getByRole("button", { name: scenarioClock.restart, exact: true });
  await expect(restart).toBeVisible();
  await expect(page.getByRole("button", { name: scenarioClock.start, exact: true })).toHaveCount(0);

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
});

test("Restart demo day asks first, Cancel does nothing, and Restart runs it again", async ({ page }) => {
  const resetCalls = await answerTheReset(page, { status: 200, body: { ok: true } });
  await page.goto("/today");

  const readout = readoutOf(page);
  await page.getByRole("button", { name: scenarioClock.start, exact: true }).click();
  await expect(readout).toHaveText(CLOCK_TIME);
  await expect.poll(resetCalls).toBe(1);

  // Let the day move on, so "back to the start" is a visible difference.
  const beforeRestart = await text(readout);
  await expect
    .poll(async () => await text(readout), { timeout: 30_000, intervals: [500] })
    .not.toBe(beforeRestart);
  const late = await text(readout);

  // The second press asks, in the founder's words, and it is a modal dialog.
  await page.getByRole("button", { name: scenarioClock.restart, exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute("aria-modal", "true");
  await expect(dialog.getByRole("heading", { name: scenarioClock.confirmTitle })).toBeVisible();
  await expect(dialog.getByText(scenarioClock.confirmBody, { exact: true })).toBeVisible();

  const cancel = dialog.getByRole("button", { name: scenarioClock.confirmCancel, exact: true });
  const confirm = dialog.getByRole("button", { name: scenarioClock.confirmRestart, exact: true });
  await expect(cancel).toBeVisible();
  await expect(confirm).toBeVisible();
  // Cancel has the focus, so the quiet keypress — Enter, Space — is the harmless one (§9).
  await expect(cancel).toBeFocused();
  // The dangerous one is red: §8's critical ink, white text on it (tokens.ts, 8.31:1).
  expect(await confirm.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe("rgb(153, 27, 27)");
  console.log("screenshot:", await shot(page, "scenario-clock-confirm"));

  // Cancel does nothing: the dialog closes, the day is where it was, and no POST was made.
  await cancel.click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(resetCalls()).toBe(1);
  await expect(readout).toHaveText(CLOCK_TIME);
  await expect(page.getByRole("button", { name: scenarioClock.restart, exact: true })).toBeVisible();

  // Taken, it is the first press again: the data goes back, and so does the clock.
  await page.getByRole("button", { name: scenarioClock.restart, exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: scenarioClock.confirmRestart, exact: true }).click();
  await expect.poll(resetCalls).toBe(2);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(readout).toHaveText(CLOCK_TIME);
  // Back at the start of the day, which is earlier than where it had got to.
  expect(minutesOf(await text(readout))).toBeLessThan(minutesOf(late));
});

test("on a preview the reset refuses by design: the clock starts and one line says so", async ({ page }) => {
  // What a preview deployment answers, because its database is production's served read-only
  // (DECISION-LEDGER #43, `demoControlsGate`). Expected, not broken.
  const resetCalls = await answerTheReset(page, {
    status: 403,
    body: { ok: false, error: demoReset.previewRefusal, refusal: DEMO_RESET_REFUSAL.readOnlyDb },
  });
  await page.goto("/today");

  await page.getByRole("button", { name: scenarioClock.start, exact: true }).click();

  await expect.poll(resetCalls).toBe(1);
  // The clock started anyway, and the line beside the button says what did and did not happen.
  await expect(readoutOf(page)).toHaveText(CLOCK_TIME);
  await expect(noteOf(page)).toHaveText(scenarioClock.previewOnly);
  await expect(errorOf(page)).toHaveCount(0);
  await expect(page.getByRole("button", { name: scenarioClock.restart, exact: true })).toBeVisible();
  // One line, and it names no deployment, flag or status code (COPY-GUIDE §1, §2).
  await expectNoInternalCodes(page);
  console.log("screenshot:", await shot(page, "scenario-clock-preview-refusal"));
});

test("a real failure starts nothing, and says so in one sentence", async ({ page }) => {
  const resetCalls = await answerTheReset(page, { status: 500, body: { ok: false, error: "nope" } });
  await page.goto("/today");

  const readout = readoutOf(page);
  await page.getByRole("button", { name: scenarioClock.start, exact: true }).click();

  await expect.poll(resetCalls).toBe(1);
  await expect(errorOf(page)).toHaveText(scenarioClock.failed);
  // The clock did not start, and the button still offers the first press.
  await expect(readout).toHaveText(scenarioClock.notStarted);
  await expect(page.getByRole("button", { name: scenarioClock.start, exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: scenarioClock.restart, exact: true })).toHaveCount(0);
  // The server's own words are not on the screen, and neither is the status.
  await expect(page.locator("body")).not.toContainText("nope");
  await expect(page.locator("body")).not.toContainText("500");
  console.log("screenshot:", await shot(page, "scenario-clock-failure"));
});

test("a reload keeps the day running, and the press after it still asks first", async ({ page }) => {
  const resetCalls = await answerTheReset(page, { status: 200, body: { ok: true } });
  await page.goto("/today");

  const readout = readoutOf(page);
  await page.getByRole("button", { name: scenarioClock.start, exact: true }).click();
  await expect.poll(resetCalls).toBe(1);
  await expect(readout).toHaveText(CLOCK_TIME);
  const started = await text(readout);

  // Let the day get somewhere, so "it came back where it had got to" is a visible difference.
  await expect
    .poll(async () => await text(readout), { timeout: 30_000, intervals: [500] })
    .not.toBe(started);

  // The founder refreshes the page — or opens the console again on the same tab.
  await page.reload();

  // The day is still running, and it resumed where it had got to rather than at the start.
  await expect(readout).toHaveText(CLOCK_TIME);
  const resumed = await text(readout);
  expect(minutesOf(resumed)).toBeGreaterThan(minutesOf(started));
  // The reload reset nothing by itself: the only POST is still the press before it.
  expect(resetCalls()).toBe(1);
  // …and it keeps walking from there, on one clock.
  await expect
    .poll(async () => await text(readout), { timeout: 30_000, intervals: [500] })
    .not.toBe(resumed);

  // The gap this closes: the button is the restart, not the unguarded first press.
  const restart = page.getByRole("button", { name: scenarioClock.restart, exact: true });
  await expect(restart).toBeVisible();
  await expect(page.getByRole("button", { name: scenarioClock.start, exact: true })).toHaveCount(0);

  // So the press after a reload asks, in the founder's words, with Cancel holding the focus.
  await restart.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("heading", { name: scenarioClock.confirmTitle })).toBeVisible();
  await expect(dialog.getByText(scenarioClock.confirmBody, { exact: true })).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: scenarioClock.confirmCancel, exact: true }),
  ).toBeFocused();
  // Nothing has gone back yet: the question is asked before the demo data is touched.
  expect(resetCalls()).toBe(1);
  console.log("screenshot:", await shot(page, "scenario-clock-confirm-after-reload"));

  // Answered, it is the whole press again — the data back, then the clock.
  await dialog.getByRole("button", { name: scenarioClock.confirmRestart, exact: true }).click();
  await expect.poll(resetCalls).toBe(2);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(readout).toHaveText(CLOCK_TIME);
  // Still the demo, and still honest about it after a refresh.
  await expectDemoBarPinned(page);
  await expectNoInternalCodes(page);
});
