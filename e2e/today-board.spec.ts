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
import { board as boardCopy, drawer, fill, sentence } from "../src/ui/copy";
import { legStates } from "../src/ui/states";
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

/** The child the scenario gives no authorized receiving adult, and one on a van that is moving. */
const NO_RECEIVER_CHILD = "Noah O.";
const RIDING_CHILD = "Zoe B.";

/** The 28 children of the standard scenario, each with a morning row and an afternoon row. */
const RIDES = 56;

/** One row's opener: a child and which of their two rides this row is. */
const opener = (child: string, ride: string = boardCopy.amSpoken) =>
  fill(boardCopy.openRow, { child, ride }) as string;

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

      // One row per child and ride: the whole census, both halves of every day (AT-07).
      const openers = page.getByRole("button", { name: /^Open / });
      await expect(openers).toHaveCount(RIDES);
      await expect(page.getByRole("button", { name: opener(RIDING_CHILD) })).toBeVisible();
      await expect(
        page.getByRole("button", { name: opener(RIDING_CHILD, boardCopy.pmSpoken) }),
      ).toBeVisible();

      // D-5: the violet is the DEMO bar and the Simulated chip, and nothing else on the board.
      await expectVioletOnlyOnDemoChrome(page);

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
      // This child's *morning* row: their afternoon is a row of its own, in another group.
      const row = page
        .getByRole("row")
        .filter({ has: page.getByRole("button", { name: opener(RIDING_CHILD) }) });

      // §3: icon + label, always. The label is the §3 string, verbatim.
      await expect(row.getByText(legStates.EN_ROUTE_PICKUP.label).first()).toBeVisible();
      // §4.1: the window the family holds, and how far today has moved it.
      await expect(row.getByText(/\d{1,2}:\d{2}–\d{1,2}:\d{2} [AP]M/).first()).toBeVisible();
      // Every chip on the row carries a label beside its icon, so the row reads in greyscale.
      // `:visible` because below 1280 three cells leave the row for the drawer (§4.1).
      for (const chip of await row.locator("[data-tone]:visible").all()) {
        expect((await chip.innerText()).trim(), "a state chip with an icon and no label").not.toBe("");
        await expect(chip.locator("svg")).toHaveCount(1);
      }
      // AT-10: a vehicle reaching a place is never a child changing hands.
      await expect(page.getByText(/handed off to/i)).toHaveCount(0);
    });

    /**
     * The "Next step" column, which is the taste rule this board was re-cut for: a step is a
     * thing to do, written as a verb and the name of the child it is done for — never a role.
     */
    test("every row says what to do next, as a verb and a child's name", async ({ page }) => {
      await page.goto("/today");
      const step = sentence(
        fill(boardCopy.nextSteps.RECORD_RECEIVER, { child: NO_RECEIVER_CHILD }),
      );

      if (width >= 1280) {
        await expect(page.getByText(step, { exact: true })).toBeVisible();
        // The adult who receives a child is named on the row, not described.
        await expect(
          page.getByText(fill(boardCopy.receiverNamed, { adult: "Alma R." })).first(),
        ).toBeVisible();
        await expect(page.getByText(boardCopy.noReceiver).first()).toBeVisible();
        // The role names the column used to carry are gone from the board.
        for (const role of ["Coordinator", "Front desk"]) {
          await expect(page.getByRole("cell", { name: role, exact: true })).toHaveCount(0);
        }
      } else {
        // §4.1 folds this column into the drawer below 1280, so that is where it has to be.
        await page.getByRole("button", { name: opener(NO_RECEIVER_CHILD, boardCopy.pmSpoken) }).click();
        // Exact: the footer's disabled reason is the same instruction with "first" on the end.
        await expect(page.getByRole("dialog").getByText(step, { exact: true })).toBeVisible();
      }
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
      // Both of the child's rides, read as one day — which is what the drawer is for.
      for (const heading of [drawer.amRide, drawer.pmRide]) {
        await expect(panel.getByText(heading, { exact: true })).toBeVisible();
      }

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
      const confirm = panel.getByRole("button", {
        name: fill(drawer.confirmHandoff, { child: NO_RECEIVER_CHILD }),
      });
      await expect(confirm).toBeDisabled();
      await expect(
        panel.getByText(fill(drawer.handoffBlockedNoReceiver, { child: NO_RECEIVER_CHILD })),
      ).toBeVisible();
      await expect(
        panel.getByText(fill(drawer.receiverMissing, { child: NO_RECEIVER_CHILD })),
      ).toBeVisible();
      // §1 "name the person": no sentence in here stands in for a name with "this child".
      await expect(panel.getByText(/this child/i)).toHaveCount(0);

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
      await expectVioletOnlyOnDemoChrome(page);
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

      /*
       * One row, not one child: the ride that needs a person is the afternoon one, because
       * that is the ride nobody on file may receive this child off (AT-13). The morning ride
       * is on the road and needs nothing, so it is not in here.
       */
      await expect(
        page.getByRole("button", { name: opener(NO_RECEIVER_CHILD, boardCopy.pmSpoken) }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: opener(NO_RECEIVER_CHILD, boardCopy.amSpoken) }),
      ).toHaveCount(0);
      await expect(page.getByRole("button", { name: opener(RIDING_CHILD) })).toHaveCount(0);
      await expect(
        page.getByText(fill(boardCopy.showing, { shown: 1, total: RIDES })),
      ).toBeVisible();

      console.log("screenshot:", await shot(page, `today-needs-action-${width}`));
    });

    /** An empty board says which kind of empty it is, and ends in the way out of it. */
    test("a filter that hides everything says so, and says how to undo it", async ({ page }) => {
      await page.goto("/today?q=no+child+is+called+this");
      await expect(
        page.getByText(fill(boardCopy.emptySearch, { query: "no child is called this" })),
      ).toBeVisible();
      // Not the "no rides today" line: there are 56 rides today, they just do not match.
      await expect(page.getByText(/No rides scheduled/)).toHaveCount(0);
      await expect(page.locator("table")).toHaveCount(0);

      await page.getByRole("link", { name: boardCopy.clearSearch }).click();
      await expect(page.getByRole("button", { name: /^Open / })).toHaveCount(RIDES);
    });

    test("the header's search box filters the board it was always meant to", async ({ page }) => {
      await page.goto("/today");
      await page.getByRole("searchbox").fill("Zoe");
      await page.getByRole("searchbox").press("Enter");
      await page.waitForURL(/\/today\?q=Zoe/);

      // A child's name brings back their whole day: both rides, still one row each.
      await expect(page.getByRole("button", { name: /^Open / })).toHaveCount(2);
      await expect(page.getByRole("button", { name: opener(RIDING_CHILD) })).toBeVisible();
      await expect(page.getByRole("button", { name: opener(NO_RECEIVER_CHILD) })).toHaveCount(0);
      await page.getByRole("link", { name: boardCopy.clearSearch }).click();
      await expect(page.getByRole("button", { name: opener(NO_RECEIVER_CHILD) })).toBeVisible();
    });
  });
}
