/**
 * THE MENU, in a real browser: the rail a director actually gets, and whether each item opens.
 *
 * The question this file exists for cannot be answered by a unit test. `navItemsFor` returning
 * seven items is not the same claim as seven links being on the screen and each one landing on
 * the screen it names — the founder's screenshot of prod showed four, and the four were correct
 * for the deploy it came from. So the rail is read off the page, compared to the access table's
 * own answer for this role, and every link is clicked.
 *
 * No database and no credentials: the server runs with the test-only synthetic session
 * (playwright.config.ts, src/domain/access/map-view.ts), which grants a role and nothing else
 * and is refused outright on any deployment.
 */
import { expect, test } from "@playwright/test";
import type { StaffRole } from "../src/auth/core";
import { nav, scenarioClock, unbuilt } from "../src/ui/copy";
import { navItemsFor } from "../src/ui/nav-items";
import { expectDemoBarPinned, expectNoInternalCodes, shot } from "./helpers";

/** The role playwright.config.ts starts the server as. Its default is the director. */
const ROLE = (process.env.E2E_DEMO_ROLE ?? "DIRECTOR") as StaffRole;

/** What the access table says this role may open — the same function the rail filters with. */
const EXPECTED = navItemsFor(ROLE);

test.describe(`the rail as ${ROLE}`, () => {
  test("holds exactly the screens this role's rows open, in order", async ({ page }) => {
    await page.goto("/today");
    const rail = page.getByRole("navigation", { name: nav.landmarkLabel });
    await expect(rail).toBeVisible();

    /*
     * Both halves: the names that are there, and the count — a rail that is missing one item is
     * a founder who cannot reach a screen, and a rail with one extra is a link to a 403.
     */
    const links = rail.getByRole("link");
    await expect(links).toHaveCount(EXPECTED.length);
    expect(await links.evaluateAll((els) => els.map((el) => el.getAttribute("aria-label")))).toEqual(
      EXPECTED.map((item) => item.label),
    );

    // The director is the role in the screenshot, so say out loud what they should be getting.
    if (ROLE === "DIRECTOR") {
      expect(EXPECTED.map((item) => item.href)).toEqual([
        "/today",
        "/plan-preview",
        "/map-preview",
        "/exceptions",
        "/setup",
        "/health",
        "/ramp-preview",
      ]);
    }

    await expectDemoBarPinned(page);
    await expectNoInternalCodes(page);
    console.log("screenshot:", await shot(page, `nav-rail-${ROLE.toLowerCase()}`));
  });

  /*
   * One test per destination rather than one loop in one test: a failure then names the screen
   * that did not open, and the others still run.
   */
  for (const item of EXPECTED) {
    test(`opens ${item.label} from the rail`, async ({ page }) => {
      await page.goto("/today");
      const rail = page.getByRole("navigation", { name: nav.landmarkLabel });
      await rail.getByRole("link", { name: item.label }).click();
      await page.waitForURL(`**${item.href}`);

      const heading = page.getByRole("heading", { level: 1 });
      await expect(heading).toBeVisible();
      /*
       * The screen's own heading carries the words the rail link did — which is the single-source
       * rule (src/ui/nav-items.ts reads each label from that screen's entry in copy.ts) checked
       * where it matters, on the screen. Today is the exception: its heading may only say
       * "Today" on the day that is true of, and reads "Rides on <date>" otherwise
       * (`board.headingOtherDay`), so all that is asserted there is that it has one.
       */
      if (item.href !== "/today") await expect(heading).toContainText(item.label);

      await expectNoInternalCodes(page);
    });
  }
});

test.describe("the two copy fixes, on the screens that show them", () => {
  test("the health page says 'not built' once, with no chip repeating it", async ({ page }) => {
    await page.goto("/health");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      unbuilt.heading.replace("{page}", nav.health),
    );
    // The chip that used to sit beside the heading said the same thing in smaller type.
    await expect(page.getByText("Not built yet", { exact: false })).toHaveCount(0);
    const text = await page.locator("main").innerText();
    expect(text.match(/built yet/g), text).toHaveLength(1);
  });

  test("the Start beside 'Demo not started' says what it starts, and stays inert", async ({
    page,
  }) => {
    await page.goto("/today");
    await expect(page.getByText(scenarioClock.notStarted)).toBeVisible();
    const start = page.getByRole("button", { name: scenarioClock.start });
    await expect(start).toBeVisible();
    // Inert, not absent: it keeps its place in the tab order so the reason can be read (§9).
    await expect(start).toHaveAttribute("aria-disabled", "true");
    await start.focus();
    await expect(page.getByRole("tooltip")).toHaveText(scenarioClock.startUnavailable);
  });
});
