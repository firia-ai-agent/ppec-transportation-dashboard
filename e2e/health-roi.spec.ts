/**
 * Health & ROI in a real browser (SURF-06 / SURF-07).
 *
 * The unit tests already know which sentence each number picks. What only a browser can answer
 * is the click-through this screen exists for: does a number actually open the rides it was
 * counted from, and does a ride open the same child panel the board opens — because a ROI number
 * nobody can drill into is a number nobody can check (AT-15).
 *
 * Measured rather than eyeballed, with the screenshots landing in artifacts/ so a design review
 * has the picture beside the assertion: one SYNTHETIC watermark and not two, four numbers and no
 * fifth, no chart, and an adapter panel where every row says "Mocked" in words and nothing wears
 * the green "ok" tone.
 *
 * No database and no credentials: the server runs with the test-only synthetic session (see
 * playwright.config.ts and src/domain/access/map-view.ts), which grants a role and nothing else
 * and is refused outright on any deployment.
 */
import { expect, test, type Page } from "@playwright/test";
import { buildBoard } from "../src/domain/board/board";
import { adapterHealth } from "../src/domain/health/adapters";
import { dayCounts, metricByKey } from "../src/domain/health/metrics";
import {
  adapterDoing,
  adapterName,
  metricLabel,
  metricLine,
  metricValue,
  ridesHeading,
} from "../src/app/(app)/health/lines";
import { board as boardCopy, drawer, fill, health, nav, serviceDate } from "../src/ui/copy";
import {
  boxOf,
  expectDemoBarPinned,
  expectNoInternalCodes,
  expectVioletOnlyOnDemoChrome,
  overlaps,
  shot,
} from "./helpers";

/** The review's two widths: the icon rail lives at 1024, the labelled rail at 1280. */
const WIDTHS = [1024, 1280] as const;
const VIEWPORT = { height: 900 };

/**
 * The same counts the server computes, imported rather than written out: the point of the check
 * is that the screen shows what the domain counted, and a number typed in here would only prove
 * that two files agree about a literal.
 */
const BOARD = buildBoard();
const COUNTS = dayCounts(BOARD);
const ADAPTERS = adapterHealth(BOARD, { APP_DATA_CLASS: "SYNTHETIC", DEMO_MODE: "1" });

/** The number whose drill-down is one ride: the child the scenario leaves nobody to receive. */
const OPEN_RIDE = metricByKey(COUNTS, "NEEDS_A_PERSON");

/** The panel the four numbers live in, so a count of controls cannot pick up the nav rail. */
const numbersPanel = (page: Page) =>
  page
    .locator("section")
    .filter({ has: page.getByRole("heading", { level: 2, name: health.roiHeading }) });

const tileFor = (page: Page, label: string) =>
  numbersPanel(page).getByRole("button").filter({ hasText: label }).first();

for (const width of WIDTHS) {
  test.describe(`at ${width}px`, () => {
    test.use({ viewport: { width, ...VIEWPORT } });

    test("shows four numbers from today's rides, one watermark and no chart", async ({ page }) => {
      await page.goto("/health");
      await expect(page.getByRole("heading", { level: 1, name: nav.health })).toBeVisible();
      await expectDemoBarPinned(page);

      // The day the numbers are about, named once, and said to be the demo day.
      await expect(page.getByText(serviceDate.groupLabel)).toBeVisible();
      await expect(page.getByText(serviceDate.phases[BOARD.day.phase])).toBeVisible();

      // Four numbers and no fifth, each a control carrying its own value, label and sentence.
      const tiles = numbersPanel(page).getByRole("button");
      await expect(tiles).toHaveCount(COUNTS.metrics.length);
      for (const metric of COUNTS.metrics) {
        const tile = tileFor(page, metricLabel(metric.key));
        await expect(tile).toContainText(metricValue(metric));
        await expect(tile).toContainText(metricLine(metric));
        await expect(tile).toContainText(health.showRides);
      }

      // SURF-07: one watermark, and the cohort with the confidence note under the numbers.
      await expect(page.getByText(health.watermark, { exact: true })).toHaveCount(1);
      await expect(
        page.getByText(fill(health.sampleNote, { children: COUNTS.children, rides: COUNTS.rides })),
      ).toBeVisible();

      /*
       * No decorative chart. The only drawing in the numbers panel is one chevron per tile —
       * the affordance that says the number opens — and there is no canvas anywhere, which is
       * what a chart on this screen would have to be drawn on.
       */
      await expect(numbersPanel(page).locator("svg")).toHaveCount(COUNTS.metrics.length);
      await expect(page.locator("canvas")).toHaveCount(0);

      // D-5: the violet still means "this is the demo" and nothing on a ROI panel borrows it.
      await expectVioletOnlyOnDemoChrome(page);
      await expectNoInternalCodes(page);
      console.log("screenshot:", await shot(page, `health-numbers-${width}`));
    });

    test("every number opens the rides behind it, and a ride opens the child's day", async ({
      page,
    }) => {
      await page.goto("/health");

      // Nothing is open until a number is pressed, so the screen opens on the numbers alone.
      await expect(page.locator('[aria-expanded="true"]')).toHaveCount(0);
      await expect(page.getByRole("button", { name: /^Open / })).toHaveCount(0);

      // Each of the four opens the rides it was counted from, and the heading counts them.
      for (const metric of COUNTS.metrics) {
        const tile = tileFor(page, metricLabel(metric.key));
        await tile.click();
        await expect(tile).toHaveAttribute("aria-expanded", "true");
        await expect(page.getByRole("heading", { name: ridesHeading(metric) })).toBeVisible();
        await expect(page.getByRole("button", { name: /^Open / })).toHaveCount(
          metric.legKeys.length,
        );
        // One number at a time, so the list on screen always belongs to the number above it.
        await expect(page.locator('[aria-expanded="true"]')).toHaveCount(1);
      }

      // The one ride that needs a person, and the child panel behind it. Opened only if the
      // loop above has not left it open: the tile is a toggle, so clicking it blindly would
      // close the list this half of the check is about.
      const tile = tileFor(page, metricLabel(OPEN_RIDE.key));
      if ((await tile.getAttribute("aria-expanded")) !== "true") await tile.click();
      await expect(tile).toHaveAttribute("aria-expanded", "true");
      const child = OPEN_RIDE.children[0];
      // Announced with the board's own opener string, which is the assertion: the same control
      // on two screens has to say the same thing.
      const opener = page.getByRole("button", {
        name: fill(boardCopy.openRow, { child, ride: boardCopy.pmSpoken }),
      });
      await expect(opener).toBeVisible();
      console.log("screenshot:", await shot(page, `health-rides-behind-${width}`));

      // Clicking the child opens the board's own drawer — the component, not a copy of it — so
      // a number on this screen lands on the child's whole day in one click.
      const openerBox = await boxOf(opener);
      await opener.click();
      const panel = page.getByRole("dialog", { name: fill(drawer.label, { child }) });
      await expect(panel).toBeVisible();
      // Both halves of that child's day are in it, though the number counted one of the two.
      await expect(panel.getByText(drawer.amRide, { exact: true })).toBeVisible();
      await expect(panel.getByText(drawer.pmRide, { exact: true })).toBeVisible();
      // §4.2 "overlay, keeps list context": the drawer must not sit on the row that opened it.
      expect(
        overlaps(openerBox, await boxOf(panel)),
        "the drawer covers the ride row that opened it",
      ).toBe(false);
      console.log("screenshot:", await shot(page, `health-ride-drawer-${width}`));

      // Escape closes it and leaves the list where it was.
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect(page.getByRole("heading", { name: ridesHeading(OPEN_RIDE) })).toBeVisible();
    });

    test("the adapter panel never reads as 'all fine'", async ({ page }) => {
      await page.goto("/health");
      await expect(
        page.getByRole("heading", { level: 2, name: health.adapterPanel.heading }),
      ).toBeVisible();

      // The sentence comes before the table, where a reader cannot skim past it.
      const intro = page.getByText(health.adapterPanel.allMockedIntro);
      await expect(intro).toBeVisible();
      await expect(page.getByText(health.adapterPanel.someLiveIntro)).toHaveCount(0);
      const introBox = await boxOf(intro);
      const firstRow = await boxOf(
        page.getByRole("row").filter({ hasText: adapterName("SMS") }).first(),
      );
      expect(introBox.y, "the panel's own warning is under the first row").toBeLessThan(firstRow.y);

      // One row per part of the system, each saying "Mocked" in words, what it is doing on
      // today's data, and the one thing a coordinator does when it stops.
      for (const row of ADAPTERS.rows) {
        const line = page.getByRole("row").filter({ hasText: adapterName(row.key) }).first();
        await expect(line).toContainText(health.adapterPanel.modes.MOCK);
        await expect(line).toContainText(adapterDoing(row));
        await expect(line).toContainText(health.adapterPanel.degraded[row.key]);
      }

      // Nothing on the screen wears the "ok" tone, and the word "Live" is nowhere on it.
      await expect(page.locator('[data-tone="ok"]')).toHaveCount(0);
      await expect(page.getByText(health.adapterPanel.modes.LIVE, { exact: true })).toHaveCount(0);
      // Scrolled to before the shot: the panel is below the numbers, and a screenshot of the
      // top of the page is not a picture of the thing this check is about.
      await intro.scrollIntoViewIfNeeded();
      console.log("screenshot:", await shot(page, `health-adapters-${width}`));
    });
  });
}
