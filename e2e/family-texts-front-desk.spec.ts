/**
 * **Firia's gate 8, in a browser**: the front desk is shown no way to approve anything.
 *
 * `E2E_DEMO_ROLE` is the *server's*, set once when Playwright starts it, so a second role means a
 * second run — this file is that run, and it only makes sense with `E2E_DEMO_ROLE=FRONT_DESK`.
 * It skips itself otherwise rather than asserting something false about a director's screen.
 *
 * The server-side half of the gate — the action refusing a front-desk caller, with the mutations
 * that prove the test is not passing for the wrong reason — is
 * `src/modules/approvals/front-desk-cannot-approve.test.ts`. This is the part a founder can see.
 */
import { expect, test } from "@playwright/test";
import { approval, familyTexts } from "../src/ui/copy";
import { shot } from "./helpers";

const role = process.env.E2E_DEMO_ROLE ?? "DIRECTOR";

test.describe("the front desk, on Family texts", () => {
  test.skip(role !== "FRONT_DESK", "needs a server started with E2E_DEMO_ROLE=FRONT_DESK");
  test.use({ viewport: { width: 1440, height: 900 } });

  test("gets no For you tab and no approve control, by URL or otherwise", async ({ page }) => {
    const answer = await page.goto("/family-texts?tab=for-you");
    // The page's own row keeps this role out of the screen entirely (403), or — if that row ever
    // widens — the tab and every control on it are still absent. Either is a pass; a rendered
    // Approve is not.
    const status = answer?.status() ?? 0;
    await expect(page.getByText(approval.approveAndSend)).toHaveCount(0);
    await expect(page.getByText(approval.dontSend)).toHaveCount(0);
    await expect(page.getByText(familyTexts.tabForYou)).toHaveCount(0);
    expect([200, 403]).toContain(status);
    console.log("screenshot:", await shot(page, "family-texts-1440-front-desk"));
  });
});
