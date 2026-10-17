/**
 * BACK TO TODAY, clicked — the three rail-less screens, in a real browser.
 *
 * Plan routes, the live map and the ramp iPad are full-screen routes outside the console layout
 * (src/app/(app)), so none of them draws the nav rail: before this link the only way back to
 * the board was the browser's Back button, which on a tablet is not where anybody looks
 * (Firia, 2026-10-17). src/ui/back-to-today.test.ts holds the component — its words, and the
 * roles it is and is not offered to, with no browser involved. This is the half that cannot be
 * asserted from source: that the link is laid out, on screen, above the screen's own title, and
 * actually navigates — or, for a role the board is not open to, that there is nothing there.
 *
 * **Both sides, and which one runs is the role the server was started as.** `E2E_DEMO_ROLE` is
 * read once per process (src/domain/access/map-view.ts), so one run is one role and the spec
 * asks the access table which half of itself to assert:
 *
 *  - `DIRECTOR` (playwright.config.ts's default) and `COORDINATOR` open `/today`, so every
 *    rail-less screen they can open offers the link and it lands on the board;
 *  - `FRONT_DESK` does not — the board is the two console roles' page and the front desk's own
 *    surface is the ramp iPad the link would sit on — so the screens they *can* open offer no
 *    link at all, rather than a link to a 403.
 *
 * The front desk's half is run with `E2E_DEMO_ROLE=FRONT_DESK pnpm e2e e2e/back-to-today.spec.ts`
 * (README "Browser check"), which starts a server as that role. Its cheap twin, every role at
 * once with no sign-in and no server, is back-to-today.test.ts.
 *
 * No database and no credentials: the server runs with the test-only synthetic session, which
 * grants a role and nothing else and is refused outright on any deployment.
 */
import { expect, test } from "@playwright/test";
import type { StaffRole } from "../src/auth/core";
import { rolesWhoCanOpen } from "../src/auth/access";
import { liveMap, nav, planRoutes, rampIpad } from "../src/ui/copy";
import { expectDemoBarPinned } from "./helpers";

/** The role playwright.config.ts started the server as. Its default is the director. */
const ROLE = (process.env.E2E_DEMO_ROLE ?? "DIRECTOR") as StaffRole;

/**
 * Whether this role is offered the link at all — the access table's own answer, which is also
 * the function the component filters with (`canOpenPage`), so there is no second opinion here
 * about who may open the board.
 */
const OFFERED = rolesWhoCanOpen("/today").includes(ROLE);

/** The three screens with no rail, each with the heading that proves the page really loaded. */
const ALL_SCREENS = [
  { path: "/plan-routes", heading: planRoutes.heading },
  { path: "/live-map", heading: liveMap.heading },
  { path: "/ramp-ipad", heading: rampIpad.heading },
] as const;

/**
 * The ones *this* role can open. A screen whose own row refuses them renders the no-access page
 * instead, and what a link does on a page they never reach is not a question worth asking: the
 * front desk's rows open the live map and the ramp iPad, not Plan routes.
 */
const SCREENS = ALL_SCREENS.filter((screen) => rolesWhoCanOpen(screen.path).includes(ROLE));

const BACK = nav.backTo.replace("{page}", nav.today);

test.describe(`the way back as ${ROLE}`, () => {
  test.beforeAll(() => {
    // A run that could assert nothing would pass in silence. Every role has at least one of the
    // three, because the live map and the ramp iPad are open to all staff.
    expect(SCREENS.length, `${ROLE} can open none of the rail-less screens`).toBeGreaterThan(0);
  });

  test("every rail-less screen has one way back to the board, and it goes there", async ({
    page,
  }) => {
    test.skip(!OFFERED, `${ROLE} is not offered the board, so there is no link to click`);

    for (const screen of SCREENS) {
      await page.goto(screen.path);
      // The screen itself, not a redirect to sign-in or a no-access card.
      const heading = page.getByRole("heading", { level: 1, name: screen.heading });
      await expect(heading, `${screen.path} did not render its own heading`).toBeVisible();
      // §7 / NFR-09: the DEMO bar is above the link on every one of them, from the root layout.
      await expectDemoBarPinned(page);

      const back = page.getByRole("link", { name: BACK });
      // One link, not one per section: the three screens render one shared component.
      await expect(back, `${screen.path} offers no way back`).toHaveCount(1);
      await expect(back).toBeVisible();
      await expect(back).toHaveAttribute("href", "/today");

      /*
       * Vera's note, 2026-10-17 1:37 PM ET: a plain text link above the page title, not a
       * button. Both halves are measurable here and nowhere else — the box is above the
       * heading's box, and the element is an anchor with no button semantics.
       */
      const linkBox = await back.boundingBox();
      const headingBox = await heading.boundingBox();
      expect(linkBox, `${screen.path}: the link has no box`).not.toBeNull();
      expect(headingBox, `${screen.path}: the heading has no box`).not.toBeNull();
      expect(
        linkBox!.y + linkBox!.height,
        `${screen.path}: the link is not above the page title`,
      ).toBeLessThanOrEqual(headingBox!.y + 1);
      expect(await back.evaluate((el) => el.tagName), `${screen.path}: not an anchor`).toBe("A");
      await expect(page.getByRole("button", { name: BACK })).toHaveCount(0);

      await back.click();
      await expect(page, `${screen.path} did not land on the board`).toHaveURL(/\/today$/);
      // The board itself answered — the words of its own heading are the day's, so what is
      // asserted is that a level-1 heading is there at all (src/ui/copy.ts `board.heading*`).
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    }
  });

  /**
   * The front desk's side: nothing at all, rather than a link to a 403.
   *
   * The ramp iPad is the front desk's own surface, so this is the screen they are standing on
   * when the question comes up — and the board is not their page (`/today`, roles DIRECTOR and
   * COORDINATOR in src/auth/access.ts). Hiding is not denying: /today checks the table again on
   * the server for every request, which is guard-matrix.test.ts's question, not this one.
   */
  test("a role the board is not open to is offered no way back", async ({ page }) => {
    test.skip(OFFERED, `${ROLE} may open the board, so the link is supposed to be there`);

    for (const screen of SCREENS) {
      await page.goto(screen.path);
      await expect(
        page.getByRole("heading", { level: 1, name: screen.heading }),
        `${screen.path} did not render its own heading`,
      ).toBeVisible();
      await expectDemoBarPinned(page);

      // Not by name only: no link to the board at all, under any words.
      await expect(
        page.getByRole("link", { name: BACK }),
        `${screen.path} offers ${ROLE} the link`,
      ).toHaveCount(0);
      await expect(
        page.locator('a[href="/today"]'),
        `${screen.path} links ${ROLE} to the board`,
      ).toHaveCount(0);
      // And the words are not on the screen as plain text either.
      await expect(page.getByText(BACK, { exact: true })).toHaveCount(0);
    }
  });
});
