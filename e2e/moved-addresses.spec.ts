/**
 * THE FOUR ADDRESSES THAT MOVED, in a real browser.
 *
 * Vera's review (2026-10-17): no "preview" in any menu label or address. The screens are at
 * `/plan-routes`, `/live-map`, `/ramp-ipad` and `/family-texts` now. `/plan-preview`,
 * `/map-preview`, `/ramp-preview` and `/phone-preview` have been read out loud in a demo, pasted
 * into pull requests and bookmarked, so they still answer — as permanent redirects behind the same
 * rows of the access table.
 *
 * Two questions a unit test cannot answer, because both are about a response:
 *  - is the status really 308 and does the `location` header point at the screen (a unit test
 *    can only see that `permanentRedirect` was called);
 *  - does a browser following it land on the screen, heading and all.
 *
 * No database and no credentials: the server runs with the test-only synthetic session
 * (playwright.config.ts, src/domain/access/map-view.ts), which grants a role and nothing else
 * and is refused outright on any deployment.
 */
import { expect, test } from "@playwright/test";
import { MOVED_PAGES, pageLabel } from "../src/auth/access";
import { expectNoInternalCodes } from "./helpers";

const MOVED = Object.entries(MOVED_PAGES);

test("there are four of them, and none of the new addresses says \"preview\"", () => {
  expect(MOVED).toHaveLength(4);
  for (const [, to] of MOVED) expect(to).not.toMatch(/preview/i);
});

for (const [from, to] of MOVED) {
  test(`${from} answers 308 and points at ${to}`, async ({ page }) => {
    const response = await page.request.get(from, { maxRedirects: 0 });
    // 308, not 307: the old address is not coming back, so a browser and a crawler may both
    // remember the new one.
    expect(response.status(), `${from} is not a permanent redirect`).toBe(308);
    expect(response.headers()["location"]).toContain(to);
  });

  test(`${from} lands a browser on ${to}, on the screen itself`, async ({ page }) => {
    await page.goto(from);
    await expect(page).toHaveURL(new RegExp(`${to}$`));
    // The screen's own <h1>, which is the string the rail uses for it (src/ui/nav-items.ts).
    await expect(page.getByRole("heading", { level: 1 })).toContainText(pageLabel(to));
    await expectNoInternalCodes(page);
  });
}
