/**
 * THE ADDRESSES THAT MOVED, in a real browser.
 *
 * Vera's review (2026-10-17): no "preview" in any menu label or address. The screens are at
 * `/plan-routes`, `/live-map` and `/ramp-ipad` now. `/plan-preview`, `/map-preview` and
 * `/ramp-preview` have been read out loud in a demo, pasted into pull requests and bookmarked,
 * so they still answer — as permanent redirects behind the same rows of the access table.
 *
 * Two more joined them on Firia's 8:36 PM ET ruling, and for a different reason: `/exceptions`
 * and `/approvals` came off the menu because neither is a destination of the day — Exceptions &
 * Approvals is the "For you" tab inside Family texts (§9.2) — so the addresses redirect to where
 * the work actually is rather than 404ing a founder who has one in a tab. The list is
 * `MOVED_PAGES`, read from the access table so this file cannot fall behind it.
 *
 * Two questions a unit test cannot answer, because both are about a response:
 *  - is the status really 308 and does the `location` header point at the screen (a unit test
 *    can only see that `permanentRedirect` was called);
 *  - does a browser following it land on the screen, heading and all.
 *
 * One run is one role (`E2E_DEMO_ROLE`, playwright.config.ts), and the two new rows are not
 * every role's: a front desk who types `/approvals` never learns where it went — the guard
 * answers first, with a 307 to their own home and the §9.3 notice on it (src/auth/page-guard.ts).
 * So each address is asked the way round this role's row in the table says.
 *
 * No database and no credentials: the server runs with the test-only synthetic session
 * (playwright.config.ts, src/domain/access/map-view.ts), which grants a role and nothing else
 * and is refused outright on any deployment.
 */
import { expect, test } from "@playwright/test";
import { MOVED_PAGES, homePathFor, pageLabel, pageOutcome, pathOfHref } from "../src/auth/access";
import type { StaffRole } from "../src/auth/core";
import { expectNoInternalCodes } from "./helpers";

const MOVED = Object.entries(MOVED_PAGES);

const ROLE = (process.env.E2E_DEMO_ROLE ?? "DIRECTOR") as StaffRole;
const CALLER = { kind: "STAFF", role: ROLE } as const;
const HOME = homePathFor(CALLER);

/** `/family-texts?tab=for-you` in a `RegExp` is a `?` that means "the t is optional". */
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

test("there are five of them, and none of the new addresses says \"preview\"", () => {
  expect(MOVED).toHaveLength(5);
  expect(MOVED.map(([from]) => from)).toEqual([
    "/plan-preview",
    "/map-preview",
    "/ramp-preview",
    "/exceptions",
    "/approvals",
  ]);
  for (const [, to] of MOVED) expect(to).not.toMatch(/preview/i);
});

for (const [from, to] of MOVED) {
  /** Does this role's own row open the address at all? If not, the guard answers before it. */
  const canOpen = pageOutcome(CALLER, from) === "ALLOW";

  test(`${from} answers 308 and points at ${to}, as ${ROLE}`, async ({ page }) => {
    const response = await page.request.get(from, { maxRedirects: 0 });
    if (!canOpen) {
      /*
       * A role whose row does not open it is sent to their own home and told why — and is not
       * told where the address went, which is the other half: a 307 that leaked the destination
       * would be the hidden-link mistake with a Location header on it.
       */
      expect(response.status(), `${from} as ${ROLE}`).toBe(307);
      const location = response.headers()["location"] ?? "";
      expect(location).toContain(HOME);
      expect(location, `${from} leaked its destination to ${ROLE}`).not.toContain(pathOfHref(to));
      return;
    }
    // 308, not 307: the old address is not coming back, so a browser and a crawler may both
    // remember the new one.
    expect(response.status(), `${from} is not a permanent redirect`).toBe(308);
    expect(response.headers()["location"]).toContain(to);
  });

  test(`${from} lands a browser on a screen this role opens, as ${ROLE}`, async ({ page }) => {
    await page.goto(from);
    // Where a person ends: the new address for a role whose row opens it, their own home for
    // a role whose row does not — never a 404 and never a dead end.
    const landing = canOpen ? to : HOME;
    if (canOpen) {
      // The whole address, tab and all — `escapeRegExp` because `?tab=for-you` in a pattern is
      // a `?` that makes the character before it optional, which matched nothing at all.
      await expect(page).toHaveURL(new RegExp(`${escapeRegExp(landing)}$`));
    } else {
      // Their own home, carrying the §9.3 notice in its query, so the path is what is read.
      await page.waitForURL(`**${HOME}**`);
      expect(new URL(page.url()).pathname, `typing ${from} as ${ROLE}`).toBe(HOME);
    }
    /*
     * The screen's own <h1>, which is the frame's page header bar and reads that screen's label
     * from the access table — the same string the rail uses for it (src/ui/page-title.ts).
     * `pathOfHref` because one destination is a *tab*: `/family-texts?tab=for-you` is a row at
     * `/family-texts`.
     */
    await expect(page.getByRole("heading", { level: 1 })).toContainText(
      pageLabel(pathOfHref(landing)),
    );
    await expectNoInternalCodes(page);
  });
}
