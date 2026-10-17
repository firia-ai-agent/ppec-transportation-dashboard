/**
 * ONE MENU, MEASURED: the three screens that had none, at a desk width and at a phone width.
 *
 * The founder's walk of production, 2026-10-17 2:40 PM ET: "When I click plan route it changes
 * the page entirely and the only way back is the browser back button. Live map, same problem.
 * Ramp iPad takes you to another page." Those three are routes outside src/app/(app), which is
 * where the console shell was mounted, so they rendered with no header and no nav at all.
 *
 * Unit tests can prove each of them is now inside a layout that mounts the shell
 * (src/ui/one-menu.test.ts states that as a property). What they cannot prove is the half the
 * founder was reporting: that the menu is *on the screen*, that it holds the same destinations
 * it holds on the board, and that clicking one of them gets you there without the Back button.
 * So every claim here is read off a real browser, and the phone width is in because the drawer
 * used to open as a 44 px strip — present in the DOM, unusable with a thumb.
 *
 * One run is one role: `E2E_DEMO_ROLE` is read by the server process (playwright.config.ts),
 * so this file adapts to the role it was started as and the three roles are three runs. What it
 * walks is that role's own menu, from the same `navItemsFor` the rail filters with, so the front
 * desk — who has no console page and lands on one of these screens — is walked too, without a
 * second list of destinations written down here.
 *
 * No database and no credentials: the test-only synthetic session grants a role and nothing
 * else, and is refused outright on any deployment.
 */
import { expect, test, type Page } from "@playwright/test";
import type { StaffRole } from "../src/auth/core";
import { identity, nav } from "../src/ui/copy";
import { navItemsFor, type NavItem } from "../src/ui/nav-items";
import { boxOf, expectDemoBarPinned, expectNoInternalCodes, shot } from "./helpers";

/** The role playwright.config.ts started the server as. Its default is the director. */
const ROLE = (process.env.E2E_DEMO_ROLE ?? "DIRECTOR") as StaffRole;

/** This role's menu, from the access table: the list both rails are filtered to. */
const MENU = navItemsFor(ROLE);

/**
 * The reference screen — the one this role's menu is compared against. For the two console
 * roles that is Today, the board the founder clicked away from; for the front desk, who may not
 * open a console page, it is the first destination their own row opens.
 */
const REFERENCE = MENU[0];

/** The three screens that had no menu, less any this role's row does not open. */
const SCREENS = ["/plan-routes", "/live-map", "/ramp-ipad"].filter((href) =>
  MENU.some((item) => item.href === href),
);

/** §9: ≥44 px console targets. */
const TARGET = 44;

/** Somewhere else to go from here: the first item in the menu that is not this screen. */
function elsewhere(current: string): NavItem {
  const item = MENU.find((i) => i.href !== current);
  expect(item, `${ROLE} has only one destination, so there is nothing to click to`).toBeDefined();
  return item as NavItem;
}

const slug = (href: string) => href.replace("/", "");

/** The labels the rail is showing, in order, as a screen reader would read them. */
async function railLabels(page: Page): Promise<string[]> {
  return page
    .getByRole("navigation", { name: nav.landmarkLabel })
    .getByRole("link")
    .evaluateAll((els) => els.map((el) => el.getAttribute("aria-label") ?? ""));
}

test.describe(`the menu on every screen, as ${ROLE}`, () => {
  test.describe("at 1280px", () => {
    test.use({ viewport: { width: 1280, height: 900 } });

    test("every screen carries the same menu, and it leads off the screen", async ({ page }) => {
      // The list to compare against, read off the screen this role starts on.
      await page.goto(REFERENCE.href);
      const expected = await railLabels(page);
      expect(expected).toEqual(MENU.map((item) => item.label));

      for (const href of SCREENS) {
        await page.goto(href);
        await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

        const rail = page.getByRole("navigation", { name: nav.landmarkLabel });
        await expect(rail, `no menu on ${href}`).toBeVisible();
        // Exactly the destinations the board offers this role — not a subset, not one more.
        expect(await railLabels(page), `the menu on ${href}`).toEqual(expected);

        // The screen you are on is marked, so the menu says where you are as well as where to go.
        await expect(
          rail.getByRole("link", { name: MENU.find((i) => i.href === href)?.label }),
        ).toHaveAttribute("aria-current", "page");

        // The one bar and the one Simulated chip, from the root layout: not two of either.
        await expectDemoBarPinned(page);
        await expectNoInternalCodes(page);
        console.log("screenshot:", await shot(page, `one-menu-${ROLE.toLowerCase()}-${slug(href)}-1280`));

        // And the thing the founder could not do: leave, without the browser's Back button.
        const target = elsewhere(href);
        await rail.getByRole("link", { name: target.label }).click();
        await page.waitForURL(`**${target.href}`);
        expect(new URL(page.url()).pathname, `clicking ${target.label} from ${href}`).toBe(target.href);
        await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
        // The menu is on the screen it landed on too, which is what makes it a way around.
        await expect(page.getByRole("navigation", { name: nav.landmarkLabel })).toBeVisible();
      }
    });
  });

  test.describe("at 390px", () => {
    test.use({ viewport: { width: 390, height: 844 } });

    test("the drawer opens the width of the phone, with every row a thumb can hit", async ({
      page,
    }) => {
      const width = page.viewportSize()?.width ?? 0;

      for (const href of SCREENS) {
        await page.goto(href);
        await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

        // The menu *button*. It was missing on these three screens for the same reason the menu
        // was: no shell, no header, no hamburger.
        const hamburger = page.getByRole("button", { name: nav.openMenu });
        await expect(hamburger, `no menu button on ${href}`).toBeVisible();
        const toggleBox = await boxOf(hamburger);
        expect(toggleBox.width, "the menu button is under a thumb's width").toBeGreaterThanOrEqual(TARGET);
        expect(toggleBox.height).toBeGreaterThanOrEqual(TARGET);

        // The sheet itself (`data-nav-drawer`, src/ui/MobileNav.tsx), and the nav landmark in it.
        const sheet = page.locator("[data-nav-drawer]");
        const drawer = sheet.getByRole("navigation", { name: nav.menuLabel });
        await expect(sheet).toBeHidden();
        await hamburger.click();
        await expect(drawer).toBeVisible();

        /*
         * The bug, measured. The drawer was positioned against the hamburger's own wrapper, so
         * it opened 44 px wide: every label broken one word per line, "Sign out" a sliver. It is
         * anchored to the header now, so it spans the window.
         */
        const drawerBox = await boxOf(sheet);
        expect(drawerBox.width, `the drawer is ${drawerBox.width}px of a ${width}px window`).toBeGreaterThanOrEqual(
          width - 2,
        );
        expect(drawerBox.x, "the drawer is not flush with the left edge").toBeLessThanOrEqual(1);
        // Below the header, not over it: the way out must not cover the screen's own name.
        const header = page.locator("header").first();
        expect(drawerBox.y).toBeGreaterThanOrEqual((await boxOf(header)).height - 2);

        // The same destinations as the rail offers this role, each one tappable and on one line.
        const links = drawer.getByRole("link");
        await expect(links).toHaveCount(MENU.length);
        expect(await links.evaluateAll((els) => els.map((el) => el.textContent?.trim() ?? ""))).toEqual(
          MENU.map((item) => item.label),
        );
        for (const link of await links.all()) {
          const box = await boxOf(link);
          const label = (await link.textContent())?.trim();
          expect(box.height, `"${label}" is only ${box.height}px tall`).toBeGreaterThanOrEqual(TARGET);
          /*
           * One line, read from the browser's own line boxes: a text node broken over two lines
           * has two client rects. This is the "labels wrap word by word" half of the report, and
           * the only way to measure it is on a laid-out span.
           */
          const lines = await link.locator("span").evaluate((el) => el.getClientRects().length);
          expect(lines, `"${label}" is wrapped over ${lines} lines`).toBe(1);
        }

        // Sign out rides in the drawer below 768 (§2: one identity location per width).
        const signOut = sheet.getByRole("button", { name: identity.signOut });
        await expect(signOut).toBeVisible();
        const signOutBox = await boxOf(signOut);
        expect(signOutBox.height, "Sign out is crushed").toBeGreaterThanOrEqual(TARGET);
        expect(signOutBox.width, "Sign out is a sliver").toBeGreaterThan(width / 2);

        await expectNoInternalCodes(page);
        console.log("screenshot:", await shot(page, `one-menu-${ROLE.toLowerCase()}-${slug(href)}-390`));

        // And the way out works with a tap, not with the browser's Back button.
        const target = elsewhere(href);
        await drawer.getByRole("link", { name: target.label }).click();
        await page.waitForURL(`**${target.href}`);
        expect(new URL(page.url()).pathname, `tapping ${target.label} from ${href}`).toBe(target.href);
        await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
        await expect(page.getByRole("button", { name: nav.openMenu })).toBeVisible();
      }
    });
  });
});
