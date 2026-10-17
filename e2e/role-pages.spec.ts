/**
 * THE MENU IS THE TRUTH ABOUT THIS ROLE'S SCREENS — and a typed URL is not a dead end.
 *
 * Two rulings, measured in a real browser at both widths:
 *
 *  - Firia, 2026-10-17 2:48 PM ET: "the menu lists only screens that work." So every item this
 *    role is offered is opened, and the screen it lands on must not be the "{page} isn't built
 *    yet" placeholder. This is the half a unit test cannot do — `nav-items.test.ts` reads the
 *    page's source, and this reads what the browser drew after the server rendered it.
 *  - §9.3, and the founder's walk of production: the refusal page "This page isn't part of your
 *    role" had no way back. A page that is not on this role's menu now sends them to their own
 *    home with the toast "Not on your menu", the menu on screen around it — while the API for
 *    the same caller still answers **403**, because hiding a link is a courtesy and the guard
 *    is the guard (ADR-004, the ID-swap rule: hiding ≠ denying).
 *
 * One run is one role (`E2E_DEMO_ROLE`, playwright.config.ts), so this file asks the role it
 * was started as and skips what that role cannot be asked.
 */
import { expect, test, type Page } from "@playwright/test";
import { API, canOpenPage, homePathFor } from "../src/auth/access";
import type { StaffRole } from "../src/auth/core";
import { nav, toast, unbuilt } from "../src/ui/copy";
import { navItems, navItemsFor } from "../src/ui/nav-items";
import {
  boxOf,
  expectDemoBarPinned,
  expectHeaderIsOneRow,
  expectNoInternalCodes,
  expectOneSimulatedChip,
  overlaps,
  shot,
} from "./helpers";

const ROLE = (process.env.E2E_DEMO_ROLE ?? "DIRECTOR") as StaffRole;

/** This role's menu, and where the access table sends them when they need somewhere to be. */
const MENU = navItemsFor(ROLE);
const HOME = homePathFor({ kind: "STAFF", role: ROLE });

/**
 * A destination this role's row does not open at all — the typed-URL case, if they have one.
 *
 * Not "everything off the menu": a director's menu does not carry /health, but their row opens
 * it and typing the URL still renders it, which is the point of taking it off the *menu* rather
 * than out of the app. This is the access table's own answer, so the only role with anything
 * here is the front desk.
 */
const REFUSED = navItems
  .filter((item) => !canOpenPage({ kind: "STAFF", role: ROLE }, item.href))
  .map((item) => item.href);

/**
 * The three pages that are off the menu, in the words they put on the screen: each one's
 * heading ("Health & ROI isn't built yet") and the sentence under it. Written as the whole
 * heading rather than the "isn't built yet" fragment on purpose — a built screen may honestly
 * say that about one *part* of itself (Plan routes says it of the route map), and this test is
 * about a menu item opening a page that is nothing but a placeholder.
 */
const UNBUILT_SCREENS = [
  [unbuilt.heading.replace("{page}", nav.exceptions), unbuilt.exceptions],
  [unbuilt.heading.replace("{page}", nav.setup), unbuilt.setup],
  [unbuilt.heading.replace("{page}", nav.health), unbuilt.health],
].flat();

/** The menu, whichever shape this width draws it in. */
function menuOn(page: Page, width: number) {
  return width < 768
    ? page.locator("[data-tab-bar]")
    : page.getByRole("navigation", { name: nav.landmarkLabel });
}

for (const width of [1280, 390] as const) {
  test.describe(`as ${ROLE}, at ${width}px`, () => {
    test.use({ viewport: { width, height: width < 768 ? 844 : 900 } });

    test("every item on the menu opens a screen that is built", async ({ page }) => {
      expect(MENU.length, `${ROLE} has no menu at all`).toBeGreaterThan(0);
      for (const item of MENU) {
        await page.goto(item.href);
        await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

        /*
         * The chrome, on every destination and at both widths — which is the whole set of
         * screens this role has, Today included. One DEMO bar, one Simulated chip in it (Vera,
         * 2026-10-17 2:44 PM ET: not five), and one row of header under it.
         */
        await expectDemoBarPinned(page);
        await expectOneSimulatedChip(page);
        await expectHeaderIsOneRow(page);
        const text = await page.locator("body").innerText();
        for (const words of UNBUILT_SCREENS) {
          expect(text, `${item.label} opens a page that says it is not built`).not.toContain(words);
        }
        // Whatever it says, the <h1> is the screen's own name and not a placeholder's.
        expect(await page.getByRole("heading", { level: 1 }).first().innerText()).not.toContain(
          unbuilt.heading.replace("{page}", item.label),
        );
        await expect(menuOn(page, width)).toBeVisible();
      }
    });

    test("a page that is not on your menu sends you home and says why", async ({ page }) => {
      test.skip(REFUSED.length === 0, `every page is open to ${ROLE}, so there is nothing to type`);
      for (const href of REFUSED) {
        await page.goto(href);
        // Home, not a refusal: the URL is the role's own first page (src/auth/access.ts).
        await page.waitForURL(`**${HOME}**`);
        expect(new URL(page.url()).pathname, `typing ${href}`).toBe(HOME);
        await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

        // The one line that says why you are somewhere else (§9.5 toast.notOnMenu)...
        const notice = page.locator("[data-notice]");
        await expect(notice).toBeVisible();
        await expect(notice).toContainText(toast.notOnMenu);
        // ...beside the chrome rather than on top of it: it explains the header, so it must
        // not be covering the header (which is where a fixed one landed at 390 px).
        expect(overlaps(await boxOf(notice), await boxOf(page.locator("header").first()))).toBe(false);
        // And no 403 card: not its heading, not the code, not the word.
        const text = await page.locator("body").innerText();
        expect(text).not.toContain("isn't part of your role");
        expect(text).not.toMatch(/\b40\d\b/);

        // The menu is on screen around it, which is the thing the refusal page did not have.
        const menu = menuOn(page, width);
        await expect(menu).toBeVisible();
        await expect(menu.getByRole("link")).toHaveCount(MENU.length);
        await expectDemoBarPinned(page);
        await expectOneSimulatedChip(page);
        await expectHeaderIsOneRow(page);
        await expectNoInternalCodes(page);
        console.log(
          "screenshot:",
          await shot(page, `not-on-menu-${ROLE.toLowerCase()}-${href.replace("/", "")}-${width}`),
        );
      }
    });
  });
}

/**
 * The other half of the same rule, and the half that is not about words on a screen: the page
 * moved, the API did not. `POST /api/demo/reset` is the demo's one write and the access table
 * gives it to a director alone (ADR-014), so for the other two roles it is the 403 that proves
 * the toast is a courtesy rather than a loosening. There is no `/api/plan/...` route yet for
 * Plan routes — this is the session API this build has.
 */
test.describe(`the API, as ${ROLE}`, () => {
  test("still answers 403 for a role it is not open to, with no words from the page in it", async ({
    request,
  }) => {
    test.skip(ROLE === "DIRECTOR", "the demo reset is the director's own endpoint");
    const response = await request.post(API.demoReset, { failOnStatusCode: false });
    expect(response.status(), `${API.demoReset} as ${ROLE}`).toBe(403);
    const body = await response.text();
    expect(body).not.toMatch(/DIRECTOR|COORDINATOR|FRONT_DESK/);
    expect(body).not.toMatch(/\b40\d\b/);
  });
});
