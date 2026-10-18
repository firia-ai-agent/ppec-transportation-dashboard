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
import { demoDay, nav, stub } from "../src/ui/copy";
import { navItemsFor } from "../src/ui/nav-items";
import { expectDemoBarPinned, expectNoInternalCodes, frameHeaders, shot } from "./helpers";

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
     *
     * The *menu's* links, which is `[data-nav-item]` and not every anchor in the landmark: the
     * rail's foot carries one more, the account block, which opens /whoami (REDESIGN-SPEC §9.2,
     * audit §2 item 3). It is a link in the nav and it is not a destination on the menu, so
     * counting it made every role's menu one item longer than their row in the table says.
     */
    const links = rail.locator("[data-nav-item]");
    await expect(links).toHaveCount(EXPECTED.length);
    expect(await links.evaluateAll((els) => els.map((el) => el.getAttribute("aria-label")))).toEqual(
      EXPECTED.map((item) => item.label),
    );

    /*
     * The director is the role in the screenshot, so say out loud what they should be getting.
     * REDESIGN-SPEC §0's menu, in §0's order, and it is **five items at every width** (Firia,
     * 2026-10-17 8:36 PM ET, over the 6:19 PM one): Exceptions & Approvals and Health & ROI came
     * off the menu — neither is a destination of the day — and Setup was never on it. All three
     * are still routes and still answer a typed URL; `inMenu` in src/ui/nav-items.ts carries the
     * flag and the reason.
     */
    if (ROLE === "DIRECTOR") {
      expect(EXPECTED.map((item) => item.href)).toEqual([
        "/today",
        "/plan-routes",
        "/live-map",
        "/ramp-ipad",
        "/family-texts",
      ]);
    }

    /*
     * Vera's review (2026-10-17): no "preview" in any menu label or address. Read off the
     * rendered rail rather than off `navItems`, because the label a founder reads is the DOM's,
     * and the href they copy out of the address bar is the DOM's too.
     */
    const rendered = await links.evaluateAll((els) =>
      els.map((el) => ({ label: el.getAttribute("aria-label") ?? "", href: el.getAttribute("href") ?? "" })),
    );
    for (const item of rendered) {
      expect(item.label, `rail label "${item.label}"`).not.toMatch(/preview/i);
      expect(item.href, `rail address "${item.href}"`).not.toMatch(/preview/i);
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
  /**
   * A page whose data is not built is **its title, and nothing else** (Firia, 2026-10-17 8:36 PM
   * ET; audit §4 item 9). The line that used to say what it would hold is deleted with every
   * other sentence under a page heading, and the title is the frame's page header bar — so what
   * is held here is that the screen still names itself and still does not apologise.
   */
  test("a page whose data is not built is its title, and no prose", async ({ page }) => {
    test.skip(ROLE === "FRONT_DESK", "the front desk's row does not open a console page");
    await page.goto("/health");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(nav.health);
    const text = await page.locator("main").innerText();
    // No apology, and no sentence about the page at all.
    expect(text).not.toMatch(/built yet/i);
    expect(text.trim()).toBe("");
  });

  /**
   * The demo's one control is the DEMO bar's, and there is no white app header left to hold any
   * of it (REDESIGN-SPEC §0; audit §2 item 1). It used to be a "Demo day · Not started" readout
   * in that header with an inert "Start demo day" beside it; the readout, the control and the
   * header itself are all deleted, so what is measured here is where the control *is* — inside
   * the violet bar — and that the page header bar carries nothing of the demo.
   */
  test("the demo's one control is in the DEMO bar, and there is no app header", async ({ page }) => {
    await page.goto(ROLE === "FRONT_DESK" ? "/live-map" : "/today");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

    expect(await frameHeaders(page)).toEqual([]);
    // Nothing about the demo in the page header bar either: no readout, no Start, no Restart.
    const bar = page.getByRole("heading", { level: 1 }).locator("..");
    expect(await bar.innerText()).not.toMatch(/demo day/i);

    const restart = page.locator("[data-demo-restart]");
    if (ROLE === "DIRECTOR") {
      await expect(restart).toBeVisible();
      await expect(restart).toHaveText(demoDay.restart);
      // In the bar: the element that carries the "DEMO" status is its sibling.
      expect(
        await restart.evaluate((el) => {
          const bar = document.querySelector('[role="status"][aria-label="DEMO"]')?.parentElement;
          return bar?.contains(el) ?? false;
        }),
      ).toBe(true);
    } else {
      // The reset answers one role, so one role is offered it (src/ui/DemoBanner.tsx).
      await expect(restart).toHaveCount(0);
      expect(await page.locator("body").innerText()).not.toMatch(/Restart demo day|Start demo day/);
    }
  });
});
