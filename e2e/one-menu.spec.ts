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
 * So every claim here is read off a real browser, and the phone width is in because that is
 * where the menu changed shape: Firia's final ruling of 2026-10-17 3:08 PM ET replaced the
 * hamburger and its drawer with a bottom tab bar that is always on screen.
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
import {
  boxOf,
  expectDemoBarPinned,
  expectHeaderIsOneRow,
  expectNoInternalCodes,
  expectOneSimulatedChip,
  overlaps,
  shot,
} from "./helpers";

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
        await expectOneSimulatedChip(page);
        // And the header under them is one row (Vera, 2:44 PM ET).
        await expectHeaderIsOneRow(page);
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

    /**
     * The phone menu, as Firia's final ruling has it (2026-10-17 3:08 PM ET): a bottom tab bar,
     * always on screen, no hamburger and no side panel. Every claim in that ruling is one
     * assertion below, measured on the laid-out bar rather than read off the markup — the
     * previous version of this menu was in the DOM and unusable with a thumb, which is exactly
     * the failure a markup assertion cannot see.
     */
    test("the tab bar is on screen without being opened, and every tab fits a thumb", async ({
      page,
    }) => {
      const viewport = page.viewportSize() ?? { width: 390, height: 844 };

      for (const href of SCREENS) {
        await page.goto(href);
        await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

        // Nothing to open: no hamburger, and no drawer left in the DOM behind it.
        await expect(page.getByRole("button", { name: /menu/i })).toHaveCount(0);
        await expect(page.locator("[data-nav-drawer]")).toHaveCount(0);

        const bar = page.locator("[data-tab-bar]");
        await expect(bar, `no tab bar on ${href}`).toBeVisible();
        const barBox = await boxOf(bar);
        expect(barBox.width, "the bar spans the phone").toBeGreaterThanOrEqual(viewport.width - 1);
        expect(
          Math.round(barBox.y + barBox.height),
          "the bar sits on the bottom edge of the window",
        ).toBe(viewport.height);

        // The same destinations the rail offers this role, each one tappable and on one line.
        const tabs = bar.getByRole("link");
        await expect(tabs).toHaveCount(MENU.length);
        expect(await tabs.evaluateAll((els) => els.map((el) => el.textContent?.trim() ?? ""))).toEqual(
          MENU.map((item) => item.label),
        );
        for (const tab of await tabs.all()) {
          const box = await boxOf(tab);
          const label = (await tab.textContent())?.trim();
          expect(box.height, `"${label}" is only ${box.height}px tall`).toBeGreaterThanOrEqual(TARGET);
          // Icon over label, both present: the icon is the glance and the label is the word.
          await expect(tab.locator("svg")).toHaveCount(1);
          const lines = await tab.locator("span").evaluate((el) => el.getClientRects().length);
          expect(lines, `"${label}" is wrapped over ${lines} lines`).toBe(1);
        }

        // Where you are, marked by more than colour: the attribute, and a brand bar on top.
        const current = bar.getByRole("link", { name: MENU.find((i) => i.href === href)?.label });
        await expect(current).toHaveAttribute("aria-current", "page");
        const rule = await current.evaluate((el) => {
          const s = getComputedStyle(el);
          return { width: s.borderTopWidth, weight: s.fontWeight };
        });
        expect(Number.parseFloat(rule.width), "the current tab has no bar on it").toBeGreaterThanOrEqual(3);
        expect(Number(rule.weight)).toBeGreaterThanOrEqual(600);

        // The one bar and the one Simulated chip, at phone width too (Vera, 2:44 PM ET).
        await expectDemoBarPinned(page);
        await expectOneSimulatedChip(page);
        // One row on a phone as well, which is where it is tightest.
        await expectHeaderIsOneRow(page);

        /*
         * Nothing hides behind the bar. Scrolled to the bottom of the page, every box with
         * words in it ends above the bar's top edge — which is what the shell's padding is for,
         * and the thing a `position: fixed` menu gets wrong by default.
         */
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await page.waitForTimeout(300);
        const barNow = await boxOf(bar);
        const covered = await page.evaluate((top) => {
          const content = document.querySelector("#content");
          if (!content) return ["#content is missing"];
          return Array.from(content.querySelectorAll("*"))
            .filter((el) => (el.textContent ?? "").trim().length > 0 && el.children.length === 0)
            .filter((el) => {
              const r = el.getBoundingClientRect();
              return r.height > 0 && r.bottom > top + 1;
            })
            .slice(0, 5)
            .map((el) => `${el.tagName.toLowerCase()}: ${(el.textContent ?? "").trim().slice(0, 40)}`);
        }, barNow.y);
        expect(covered, "the tab bar is sitting on top of the page's own content").toEqual([]);
        await page.evaluate(() => window.scrollTo(0, 0));

        await expectNoInternalCodes(page);
        console.log("screenshot:", await shot(page, `one-menu-${ROLE.toLowerCase()}-${slug(href)}-390`));

        // The account is still reachable on a phone: the name in the header, Sign out inside it.
        const account = page.locator("header details").first();
        await expect(account, "no account menu in the header at 390").toBeVisible();
        await account.locator("summary").click();
        const signOut = page.getByRole("button", { name: identity.signOut });
        await expect(signOut).toBeVisible();
        // The name is in the panel it opens, which is where a 390 px row leaves room for it.
        await expect(
          page.getByText(identity.signedInAs.split("{")[0].trim(), { exact: false }),
        ).toBeVisible();
        expect((await boxOf(signOut)).height).toBeGreaterThanOrEqual(TARGET);
        // ...and it does not open on top of the menu it shares the screen with.
        expect(overlaps(await boxOf(signOut), barNow)).toBe(false);
        await account.locator("summary").click();

        // And the way out works with a tap, not with the browser's Back button.
        const target = elsewhere(href);
        await bar.getByRole("link", { name: target.label }).click();
        await page.waitForURL(`**${target.href}`);
        expect(new URL(page.url()).pathname, `tapping ${target.label} from ${href}`).toBe(target.href);
        await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
        await expect(page.locator("[data-tab-bar]")).toBeVisible();
      }
    });
  });
});
