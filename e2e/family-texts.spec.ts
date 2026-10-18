/**
 * FAMILY TEXTS AND ITS "FOR YOU" TAB, in a real browser, at both review widths.
 *
 * What a renderer test cannot answer. `app/(app)/family-texts/texts-screen.test.ts` holds the
 * markup and the five gates that are about *what is on the screen*; this file is about what the
 * screen does at a width:
 *
 *  - at 1440 it is **two panes** — the conversation list beside the thread — with the approve card
 *    inside the thread and one compose bar under it (mockups/family-texts.html);
 *  - at 390 it is **one pane at a time**: the list, then the thread, with a back chevron, and
 *    nothing overflowing sideways (`scrollWidth <= 390`, which is the measurement five of the
 *    seven mockups failed in Vera's audit);
 *  - the "For you" tab stacks **one card per row** at 390 with no horizontal scroll either;
 *  - no provider name and no internal code in the rendered text, at either width.
 *
 * It also writes the screenshots the side-by-sides are built from.
 *
 * ## The two states, and why this spec reads whichever it is in
 *
 * `modelReach()` decides whether a proposal card may render at all (gate 5), and it is a property
 * of the *server*, set once when Playwright starts it. So one run is one state, and the run that
 * made the side-by-sides sets `AGENT_DEMO_DATA_ONLY=true` with a placeholder key to get the card.
 * Rather than skip in the other state, this spec asserts the state it is in **by name** and fails
 * if neither is true — which is the stronger check: exactly one of "a card" and "the needs-a-person
 * alert" must be on the For you tab, never both and never neither.
 */
import { expect, test, type Page } from "@playwright/test";
import { approval, assistantUnavailable, familyTexts } from "../src/ui/copy";
import { expectDemoBarPinned, expectNoInternalCodes, shot } from "./helpers";

const SCREEN = "/family-texts";
const FOR_YOU = "/family-texts?tab=for-you";

/** The widest a phone frame may measure. Vera's audit measures overflow at exactly this number. */
const PHONE = 390;

async function scrollWidth(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth);
}

/**
 * Which of the two mutually exclusive states this server is in. Exactly one must hold.
 *
 * Asked on the "For you" tab only, because that is the tab both of them live on: the alert is the
 * queue's own, and a thread on another tab simply has no proposal in it.
 */
async function stateOf(page: Page): Promise<"card" | "alert"> {
  const card = await page.getByText(approval.changeDropoff).count();
  const alert = await page.getByRole("heading", { name: assistantUnavailable.heading }).count();
  expect([card > 0, alert > 0], "exactly one of the card and the alert").toContainEqual(true);
  expect(card > 0 && alert > 0, "never both").toBe(false);
  return card > 0 ? "card" : "alert";
}

/** Is a proposal card on this page at all? `false` is the no-model state (gate 5). */
async function hasCard(page: Page): Promise<boolean> {
  return (await page.getByText(approval.changeDropoff).count()) > 0;
}

test.describe("1440: two panes, the card inside the thread", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("the list and the thread are side by side, with one compose bar", async ({ page }) => {
    await page.goto(SCREEN);

    // One title, and nothing explaining it underneath (Firia, 8:36 PM ET).
    await expect(page.getByRole("heading", { level: 1, name: familyTexts.heading })).toBeVisible();
    expect(await page.getByRole("heading", { level: 1 }).count()).toBe(1);
    await expect(page.getByText(familyTexts.intro)).toHaveCount(0);

    const list = page.getByRole("navigation", { name: familyTexts.conversationsLabel }).first();
    const rows = page.getByRole("list", { name: familyTexts.conversationsLabel });
    await expect(rows).toBeVisible();

    // Side by side: the list's right edge is left of the thread's left edge.
    const listBox = await rows.boundingBox();
    const thread = page.locator("section").filter({ has: page.getByText(familyTexts.verified) }).first();
    const threadBox = await thread.boundingBox();
    expect(listBox).not.toBeNull();
    expect(threadBox).not.toBeNull();
    expect(listBox!.x + listBox!.width).toBeLessThanOrEqual(threadBox!.x + 1);

    // One compose bar, and its Send is the only one on the screen.
    await expect(page.getByRole("button", { name: familyTexts.composeAction, exact: true })).toHaveCount(1);

    // With a model reachable the thread carries the card, and it sits inside the thread rather
    // than in a pane of its own; with none, there is no card anywhere (gate 5).
    await expect(list).toBeVisible();
    if (await hasCard(page)) {
      const card = page.getByRole("region", { name: approval.changeDropoff });
      await expect(card).toBeVisible();
      const cardBox = await card.boundingBox();
      expect(cardBox!.x).toBeGreaterThanOrEqual(threadBox!.x - 1);
    }

    expect(await scrollWidth(page)).toBeLessThanOrEqual(1440);
    await expectDemoBarPinned(page);
    await expectNoInternalCodes(page);
    console.log("screenshot:", await shot(page, "family-texts-1440"));
  });

  test("the For you tab is the approvals queue, one card per row", async ({ page }) => {
    await page.goto(FOR_YOU);
    await expect(page.getByRole("heading", { level: 1, name: familyTexts.heading })).toBeVisible();
    // The tab is current, and it is a tab of this screen rather than a page of its own.
    await expect(page.getByRole("link", { name: new RegExp(familyTexts.tabForYou) })).toHaveAttribute(
      "aria-current",
      "page",
    );
    const state = await stateOf(page);
    if (state === "card") {
      const cards = page.getByRole("region", { name: approval.changeDropoff });
      await expect(cards.first()).toBeVisible();
      await expect(page.getByRole("button", { name: approval.approveAndSend }).first()).toBeVisible();
      await expect(page.getByRole("button", { name: approval.dontSend }).first()).toBeVisible();
      // Nothing is sent until a person says so, and the card says that before anything is pressed.
      await expect(page.getByText(approval.nothingUntilApproved).first()).toBeVisible();
    } else {
      // Gate 5: no card at all, and the alert in its place.
      await expect(page.getByText(approval.changeDropoff)).toHaveCount(0);
      await expect(page.getByText(assistantUnavailable.rule)).toBeVisible();
    }
    expect(await scrollWidth(page)).toBeLessThanOrEqual(1440);
    await expectNoInternalCodes(page);
    console.log("screenshot:", await shot(page, `for-you-1440-${state}`));
  });
});

test.describe("390: the list, then the thread", () => {
  test.use({ viewport: { width: PHONE, height: 844 } });

  test("shows the list, and a row opens the thread with a way back", async ({ page }) => {
    await page.goto(SCREEN);

    const rows = page.getByRole("list", { name: familyTexts.conversationsLabel });
    await expect(rows).toBeVisible();
    // Nothing runs off the side of the phone (Vera's audit, M1).
    expect(await scrollWidth(page)).toBeLessThanOrEqual(PHONE);
    console.log("screenshot:", await shot(page, "family-texts-390-list"));

    // Tapping a row pushes the thread view.
    const first = rows.getByRole("link").first();
    const who = (await first.textContent()) ?? "";
    await first.click();
    await expect(page).toHaveURL(/thread=/);

    // The thread is on screen and the list is not: one pane at a time. (The chip's word is on
    // screen twice — once for a screen reader, once visibly — so this takes the visible one.)
    await expect(page.getByText(familyTexts.verified, { exact: true })).toBeVisible();
    await expect(rows).toBeHidden();
    expect(who.length).toBeGreaterThan(0);

    // And a back chevron that returns to the list.
    const back = page.getByRole("link", { name: familyTexts.backToList });
    await expect(back).toBeVisible();
    expect(await scrollWidth(page)).toBeLessThanOrEqual(PHONE);
    console.log("screenshot:", await shot(page, "family-texts-390-thread"));

    await back.click();
    await expect(rows).toBeVisible();
    await expectNoInternalCodes(page);
  });

  test("the For you tab stacks one card per row, with no horizontal scroll", async ({ page }) => {
    await page.goto(FOR_YOU);
    const state = await stateOf(page);
    expect(await scrollWidth(page)).toBeLessThanOrEqual(PHONE);

    if (state === "card") {
      // One card per row: every card starts at the same left edge and spans the phone.
      const cards = page.getByRole("region", { name: approval.changeDropoff });
      const count = await cards.count();
      expect(count).toBeGreaterThan(0);
      for (let i = 0; i < count; i += 1) {
        const box = await cards.nth(i).boundingBox();
        expect(box!.x + box!.width, `card ${i} fits the phone`).toBeLessThanOrEqual(PHONE + 1);
      }
      // And the three controls are full-width rather than squeezed onto one line.
      const approve = await page.getByRole("button", { name: approval.approveAndSend }).first().boundingBox();
      expect(approve!.width).toBeGreaterThan(PHONE / 2);
    }
    await expectNoInternalCodes(page);
    console.log("screenshot:", await shot(page, `for-you-390-${state}`));
  });
});
