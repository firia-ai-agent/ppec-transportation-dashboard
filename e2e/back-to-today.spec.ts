/**
 * BACK TO TODAY, clicked — the three rail-less screens, in a real browser.
 *
 * Plan routes, the live map and the ramp iPad are full-screen routes outside the console layout
 * (src/app/(app)), so none of them draws the nav rail: before this link the only way back to
 * the board was the browser's Back button, which on a tablet is not where anybody looks
 * (Firia, 2026-10-17). src/ui/back-to-today.test.ts holds the component — its words, and the
 * roles it is and is not offered to, with no browser involved. This is the half that cannot be
 * asserted from source: that the link is laid out, on screen, and actually navigates.
 *
 * As DIRECTOR, which is what `E2E_DEMO_ROLE` defaults to in playwright.config.ts: a role whose
 * own row opens `/today`, so the link is offered on all three. The front desk's side of that —
 * no link, because the board is not their page — is `back-to-today.test.ts`, which can ask the
 * question for every role at once instead of signing in four times.
 *
 * No database and no credentials: the server runs with the test-only synthetic session, which
 * grants a role and nothing else and is refused outright on any deployment.
 */
import { expect, test } from "@playwright/test";
import { liveMap, nav, planRoutes, rampIpad } from "../src/ui/copy";
import { expectDemoBarPinned } from "./helpers";

/** The three screens, each with the heading that proves the page under the link really loaded. */
const SCREENS = [
  { path: "/plan-routes", heading: planRoutes.heading },
  { path: "/live-map", heading: liveMap.heading },
  { path: "/ramp-ipad", heading: rampIpad.heading },
] as const;

const BACK = nav.backTo.replace("{page}", nav.today);

test("every rail-less screen has one way back to the board, and it goes there", async ({
  page,
}) => {
  for (const screen of SCREENS) {
    await page.goto(screen.path);
    // The screen itself, not a redirect to sign-in or a no-access card.
    await expect(
      page.getByRole("heading", { level: 1, name: screen.heading }),
      `${screen.path} did not render its own heading`,
    ).toBeVisible();
    // §7 / NFR-09: the DEMO bar is above the link on every one of them, from the root layout.
    await expectDemoBarPinned(page);

    const back = page.getByRole("link", { name: BACK });
    // One link, not one per section: the three screens render one shared component.
    await expect(back, `${screen.path} offers no way back`).toHaveCount(1);
    await expect(back).toBeVisible();
    await expect(back).toHaveAttribute("href", "/today");

    await back.click();
    await expect(page, `${screen.path} did not land on the board`).toHaveURL(/\/today$/);
    // The board itself answered — the words of its own heading are the day's, so what is
    // asserted is that a level-1 heading is there at all (src/ui/copy.ts `board.heading*`).
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  }
});
