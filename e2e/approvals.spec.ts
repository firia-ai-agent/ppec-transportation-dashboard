/**
 * SURF-05, in a real browser: the rail → Exceptions & approvals → the screen a person decides on
 * (PRD §14 l.1055, §18.2 steps 9–10).
 *
 * Why a browser check. Until this item, `/exceptions` was a placeholder, and the §11.2 human tier
 * had nowhere for the human to stand: the agent wrote `ops.approval_request` rows and nobody could
 * say yes to one. What a founder needs to be able to do is *reach* the decision — click it in the
 * rail, read the exact text a family would get, and see that nothing has been sent. The first half
 * of that is a navigation and a server render of a new route, which no `renderToStaticMarkup`
 * assertion walks.
 *
 * No database and no credentials: the server runs with the test-only synthetic session
 * (playwright.config.ts, src/domain/access/map-view.ts), which grants a role and holds no
 * membership at any site. So this check walks the screen's **empty** state, deliberately — with no
 * membership there is no site, and with no site there are no proposals, which is exactly the answer
 * a tenant boundary built on membership has to give. The cards themselves are held by
 * `approval-card.test.ts` (the words Vera settled) and `modules/approvals/decide.test.ts` (the
 * guards and the three writes, against a real database).
 *
 * The role refusal is not walked here and deliberately: `E2E_DEMO_ROLE` is the server's, set once
 * when Playwright starts it, so a second role means a second server. `guard-matrix.test.ts` asks
 * the stronger version of the question anyway — it opens this page as every role and asserts the
 * front desk gets a 403 *and* that the body it gets back carries none of the screen's own words.
 */
import { expect, test } from "@playwright/test";
import { approval as approvalCopy, nav } from "../src/ui/copy";
import { expectDemoBarPinned, expectNoInternalCodes, expectVioletOnlyOnDemoChrome, shot } from "./helpers";

test.use({ viewport: { width: 1280, height: 900 } });

test("the rail reaches the approvals screen, and it says nothing is waiting", async ({ page }) => {
  await page.goto("/today");

  // The rail's own link, by the label the access table carries for the row (§2, PRD §14).
  const link = page.getByRole("navigation").getByRole("link", { name: nav.exceptions });
  await expect(link).toBeVisible();
  await link.click();

  await expect(page).toHaveURL(/\/exceptions$/);
  // The rail's label and the page's heading are one string, so arriving confirms arriving.
  await expect(page.getByRole("heading", { level: 1, name: nav.exceptions })).toBeVisible();
  // The one sentence that has to be on this screen whether or not anything is waiting.
  await expect(page.getByText(approvalCopy.intro)).toBeVisible();

  /*
   * The empty state, and the words matter: "Nothing is waiting for a decision" is a fact about the
   * day. A screen that said the feature was unbuilt, or rendered an empty list with no sentence at
   * all, would both read as "nothing needs action" when the truth is "we cannot see your site".
   */
  await expect(page.getByText(approvalCopy.none)).toBeVisible();

  await expectDemoBarPinned(page);
  await expectVioletOnlyOnDemoChrome(page);
  await expectNoInternalCodes(page);
  console.log("screenshot:", await shot(page, "exceptions-approvals"));
});
