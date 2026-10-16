/**
 * The Today board and the child drawer, in a real browser (SURF-01 / SURF-02).
 *
 * The unit tests already know which words the board puts on screen. What only a browser can
 * answer is the rest of the design's acceptance list (DESIGN-DIRECTION §10): does a group
 * header stay above its rows when the board is scrolled, does the drawer keep the list in
 * context instead of covering it, does the keyboard walk the board without a mouse, and is the
 * reason a disabled action is disabled actually *visible* rather than merely in the markup.
 * Each one is measured, and the screenshots land in artifacts/ so a design review has the
 * picture next to the assertion.
 *
 * No database and no credentials: the server runs with the test-only synthetic session (see
 * playwright.config.ts and src/domain/access/map-view.ts), which grants a role and nothing else
 * and is refused outright on any deployment. The board it renders is the committed demo day.
 */
import { expect, test } from "@playwright/test";
import { board as boardCopy, drawer, fill } from "../src/ui/copy";
import { legStates } from "../src/ui/states";
import { boxOf, expectDemoBarPinned, expectNoInternalCodes, overlaps, shot } from "./helpers";

/** The review's two widths: the icon rail lives at 1024, the labelled rail at 1280. */
const WIDTHS = [1024, 1280] as const;
const VIEWPORT = { height: 900 };

/** The child the scenario gives no authorized receiving adult, and one on a van that is moving. */
const NO_RECEIVER_CHILD = "Noah O.";
const RIDING_CHILD = "Zoe B.";

const opener = (child: string) =>
  fill(boardCopy.openRow, { child }) as string;

for (const width of WIDTHS) {
  test.describe(`at ${width}px`, () => {
    test.use({ viewport: { width, ...VIEWPORT } });

    test("the board groups the day, needs action first, and keeps its headers in view", async ({
      page,
    }) => {
      await page.goto("/today");
      await expect(page.getByRole("heading", { level: 1, name: boardCopy.heading })).toBeVisible();
      await expectDemoBarPinned(page);

      // §4.1: needs action is the first group, and every group header carries its count.
      const headers = page.locator("th[scope='colgroup']");
      const texts = await headers.allInnerTexts();
      expect(texts.length).toBeGreaterThan(1);
      expect(texts[0]).toContain(boardCopy.groups.NEEDS_ACTION);
      for (const text of texts) expect(text).toMatch(/\(\d+\)$/);

      // Every child the scenario puts on the board has a row, and the census is the board.
      const openers = page.getByRole("button", { name: /^Open / });
      await expect(openers).toHaveCount(28);

      /*
       * The group header is sticky (§4.1). Scrolled to the bottom of a 28-row board, the last
       * group's header is still on screen rather than scrolled off with its first row — which
       * is the whole reason a dense board groups at all.
       */
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(300);
      await expect(headers.last()).toBeInViewport();
      await page.evaluate(() => window.scrollTo(0, 0));

      await expectNoInternalCodes(page);
      console.log("screenshot:", await shot(page, `today-board-${width}`));
    });

    test("a row says what is happening in words, not in colour alone", async ({ page }) => {
      await page.goto("/today");
      const row = page.getByRole("row").filter({ hasText: RIDING_CHILD });

      // §3: icon + label, always. The label is the §3 string, verbatim.
      await expect(row.getByText(legStates.EN_ROUTE_PICKUP.label).first()).toBeVisible();
      // §4.1: the window the family holds, and how far today has moved it.
      await expect(row.getByText(/\d{1,2}:\d{2}–\d{1,2}:\d{2} [AP]M/).first()).toBeVisible();
      // AT-10: a vehicle reaching a place is never a child changing hands.
      await expect(page.getByText(/handed off/i)).toHaveCount(0);
    });

    test("the keyboard walks the board and opens a child, with focus visible throughout", async ({
      page,
    }) => {
      await page.goto("/today");
      const first = page.getByRole("button", { name: /^Open / }).first();
      await first.focus();
      const firstName = await first.getAttribute("aria-label");

      // §4.1: J and K move between children.
      await page.keyboard.press("j");
      const afterJ = await page.evaluate(() =>
        document.activeElement?.getAttribute("aria-label"),
      );
      expect(afterJ).not.toBe(firstName);
      await page.keyboard.press("k");
      const afterK = await page.evaluate(() =>
        document.activeElement?.getAttribute("aria-label"),
      );
      expect(afterK).toBe(firstName);

      // …and Enter opens the child, which is also what the button does with a mouse.
      await page.keyboard.press("Enter");
      await expect(page.getByRole("dialog")).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog")).toHaveCount(0);
    });

    test("the drawer keeps the board in context and explains its disabled action", async ({
      page,
    }) => {
      await page.goto("/today");
      await page.getByRole("button", { name: opener(NO_RECEIVER_CHILD) }).click();

      const panel = page.getByRole("dialog");
      await expect(panel).toBeVisible();
      await expect(panel.getByRole("heading", { name: NO_RECEIVER_CHILD })).toBeVisible();

      // §4.2: the sections, in the order the design fixes them.
      for (const heading of [
        drawer.ridesHeading,
        drawer.needsHeading,
        drawer.capabilityHeading,
        drawer.receiverHeading,
      ]) {
        await expect(panel.getByRole("heading", { name: heading })).toBeVisible();
      }

      /*
       * §4.2: one primary action, disabled, and the reason beside it in text rather than in a
       * tooltip only — so it is readable without a pointer and by a screen reader. This child
       * has nobody on file who may receive them, which is the thing to fix first.
       */
      const confirm = panel.getByRole("button", { name: drawer.confirmHandoff });
      await expect(confirm).toBeDisabled();
      await expect(panel.getByText(drawer.handoffBlockedNoReceiver)).toBeVisible();
      await expect(panel.getByText(drawer.receiverMissing)).toBeVisible();

      // §9: a transport need is never a diagnosis, and the caption says so on screen.
      await expect(panel.getByText(drawer.needsCaption)).toBeVisible();

      /*
       * §4.2 "overlay, keeps list context": the drawer must not sit on the column that names
       * the children, or opening one child hides every other.
       */
      if (width >= 768) {
        const panelBox = await boxOf(panel);
        const other = page.getByRole("button", { name: opener(RIDING_CHILD) });
        expect(
          overlaps(await boxOf(other), panelBox),
          "the drawer covers the row that opens another child",
        ).toBe(false);
      }

      // §7: the DEMO bar owns the top of every screen, drawer open included.
      const bar = page.getByRole("status", { name: "DEMO" });
      await expect(bar).toBeVisible();
      expect(overlaps(await boxOf(bar), await boxOf(panel))).toBe(false);

      await expectNoInternalCodes(page);
      console.log("screenshot:", await shot(page, `today-drawer-${width}`));

      await panel.getByRole("button", { name: drawer.close }).click();
      await expect(page.getByRole("dialog")).toHaveCount(0);
    });

    test("the needs-action filter narrows the board and says how much of it is left", async ({
      page,
    }) => {
      await page.goto("/today");
      const toggle = page.getByRole("switch");
      await expect(toggle).toHaveAttribute("aria-checked", "false");
      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-checked", "true");

      await expect(page.getByRole("button", { name: opener(NO_RECEIVER_CHILD) })).toBeVisible();
      await expect(page.getByRole("button", { name: opener(RIDING_CHILD) })).toHaveCount(0);
      await expect(
        page.getByText(fill(boardCopy.showing, { shown: 1, total: 28 })),
      ).toBeVisible();

      console.log("screenshot:", await shot(page, `today-needs-action-${width}`));
    });

    test("the header's search box filters the board it was always meant to", async ({ page }) => {
      await page.goto("/today");
      await page.getByRole("searchbox").fill("Zoe");
      await page.getByRole("searchbox").press("Enter");
      await page.waitForURL(/\/today\?q=Zoe/);

      await expect(page.getByRole("button", { name: opener(RIDING_CHILD) })).toBeVisible();
      await expect(page.getByRole("button", { name: opener(NO_RECEIVER_CHILD) })).toHaveCount(0);
      await page.getByRole("link", { name: boardCopy.clearSearch }).click();
      await expect(page.getByRole("button", { name: opener(NO_RECEIVER_CHILD) })).toBeVisible();
    });
  });
}
