/**
 * FAMILY TEXTS AND ITS "FOR YOU" TAB, in a real browser, at both review widths.
 *
 * Written to /workspace/ppec-redesign/MOCKUP-TEST-CONTRACT.md: **the mockup decides what is on
 * screen and where**, and every assertion below names the file it is read from —
 * `family-texts.html`, `approvals.html` or `png/approvals-390.png` — or, where a ruling overrides
 * the mockup, the ruling with its time in ET. Behaviour cites `docs/DATA-MODEL.md` or the ruling
 * it comes from. An uncited assertion here is a gate failure, not a style note.
 *
 * What a renderer test cannot answer. `app/(app)/family-texts/texts-screen.test.ts` holds the
 * markup and the gates that are about *what is on the screen*; this file is about what the screen
 * does at a width — where the panes are, what a tap does, and whether anything runs off the side.
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
import { expect, test, type Locator, type Page } from "@playwright/test";
import { approval, assistantUnavailable, familyTexts } from "../src/ui/copy";
import {
  expectDemoBarPinned,
  expectNoInternalCodes,
  expectOneSimulatedChip,
  expectVioletOnlyOnDemoChrome,
  shot,
} from "./helpers";

const SCREEN = "/family-texts";
const FOR_YOU = "/family-texts?tab=for-you";

/** The widest a phone frame may measure. Vera's audit measures overflow at exactly this number. */
const PHONE = 390;

/** The five threads the day has (family-texts.html `.list`, approvals.html `.list`: five rows). */
const THREADS = 5;

async function scrollWidth(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth);
}

/** The computed value of one CSS property, for the shape assertions the mockup fixes. */
async function css(locator: Locator, property: string): Promise<string> {
  return locator.evaluate(
    (el, prop) => window.getComputedStyle(el).getPropertyValue(prop),
    property,
  );
}

/**
 * Which of the two mutually exclusive states this server is in. Exactly one must hold.
 *
 * Asked on the "For you" tab only, because that is the tab both of them live on: the alert is the
 * queue's own, and a thread on another tab simply has no proposal in it.
 */
/**
 * THE PROPOSAL CARD, by its accessible name.
 *
 * Vera's card (Firia, 2026-10-18 7:51 AM ET) is the parent's name, the message as a bubble and
 * the three buttons — it has no title of its own to look for, and "Change drop-off" is not a
 * string the screen renders any more. `approval.cardLabel` is "Proposed reply to {adult}", so
 * the family is the part that varies and the rest of it is the locator.
 */
function cardRegion(page: Page) {
  return page.getByRole("region", { name: new RegExp(`^${approval.cardLabel.replace("{adult}", ".+")}$`) });
}

async function stateOf(page: Page): Promise<"card" | "alert"> {
  const card = await cardRegion(page).count();
  const alert = await page.getByRole("heading", { name: assistantUnavailable.heading }).count();
  expect([card > 0, alert > 0], "exactly one of the card and the alert").toContainEqual(true);
  expect(card > 0 && alert > 0, "never both").toBe(false);
  return card > 0 ? "card" : "alert";
}

/** Is a proposal card on this page at all? `false` is the no-model state (gate 5). */
async function hasCard(page: Page): Promise<boolean> {
  return (await cardRegion(page).count()) > 0;
}

test.describe("1440: three panes on For you, the card inside the thread", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("the list and the thread are side by side, with one compose bar", async ({ page }) => {
    await page.goto(SCREEN);

    /*
     * ONE title, and it is the frame's: since #74 the 64 px page header bar carries every
     * screen's h1 (src/ui/PageHeader.tsx, png/shell-flow-1440.png), so the screen's own body
     * adds none and there is exactly one on the page. Nothing explains it underneath either
     * (Firia, 8:36 PM ET).
     */
    await expect(page.getByRole("heading", { level: 1, name: familyTexts.heading })).toBeVisible();
    expect(await page.getByRole("heading", { level: 1 }).count()).toBe(1);
    await expect(page.getByText(familyTexts.intro)).toHaveCount(0);

    /*
     * approvals.html `.tabs`: three tabs, in this order — For you, Sent, All — and the two that
     * count something carry their count (the contract's "The tabs are For you | Sent | All").
     */
    const tabs = page.getByRole("navigation", { name: familyTexts.conversationsLabel }).getByRole("link");
    await expect(tabs).toHaveCount(3);
    for (const [i, label] of [familyTexts.tabForYou, familyTexts.tabSent, familyTexts.tabAll].entries()) {
      await expect(tabs.nth(i)).toContainText(label);
    }

    // No "Assistant on" chip: family-texts.html draws none (Vera, bdfaa8e).
    await expect(page.getByText("Assistant on", { exact: true })).toHaveCount(0);

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

    // family-texts.html `.cmp`: one compose bar, and its Send is the only one on the screen. The
    // control is the 36 px teal disc, so its name is read rather than drawn.
    await expect(page.getByRole("button", { name: familyTexts.composeAction, exact: true })).toHaveCount(1);

    // With a model reachable the thread carries the card, and it sits inside the thread rather
    // than in a pane of its own; with none, there is no card anywhere (gate 5).
    await expect(list).toBeVisible();
    if (await hasCard(page)) {
      const card = cardRegion(page);
      await expect(card).toBeVisible();
      const cardBox = await card.boundingBox();
      expect(cardBox!.x).toBeGreaterThanOrEqual(threadBox!.x - 1);
    }

    /*
     * The contract's global checks, on this screen: nothing runs off the side, the DEMO bar is
     * pinned, there is exactly one "Simulated" and it is inside that bar, and violet appears
     * nowhere else.
     */
    expect(await scrollWidth(page)).toBeLessThanOrEqual(1440);
    await expectDemoBarPinned(page);
    await expectOneSimulatedChip(page);
    await expectVioletOnlyOnDemoChrome(page);
    await expectNoInternalCodes(page);
    console.log("screenshot:", await shot(page, "family-texts-1440"));
  });

  test("the list has the day's five threads, each row the mockup's own parts", async ({ page }) => {
    await page.goto(SCREEN);
    const rows = page.getByRole("list", { name: familyTexts.conversationsLabel }).getByRole("link");

    /*
     * family-texts.html `.list`: five conversations. They are the demo day's own texts — two late
     * notices and the families whose child the day recorded as received — and not five invented
     * ones (Firia, 10:51 PM ET: "the mockup's 5 threads, from demo fixture data").
     */
    await expect(rows).toHaveCount(THREADS);

    // family-texts.html `.cv`: the disc of initials, the adult's name, the child, a time and the
    // one-line preview. Read off the first row, which is the newest.
    const first = rows.first();
    const text = (await first.textContent()) ?? "";
    expect(text, "an initials disc, two letters").toMatch(/[A-Z]{2}/);
    /*
     * A 12-hour time, and no 24-hour one (COPY-GUIDE §3). No word boundaries in either pattern:
     * a row's text runs straight into its neighbour's parts ("…· Noah4:14 PM…"), so a boundary
     * would be asserting about the gaps between spans rather than about the clock.
     */
    expect(text, "a 12-hour time (COPY-GUIDE §3)").toMatch(/(?:1[0-2]|[1-9]):[0-5]\d\s?(?:AM|PM)/);
    expect(text, "and never the 24-hour form the plan stores").not.toMatch(/(?:1[3-9]|2[0-3]):[0-5]\d/);
    // approvals.html `.th .chip`: one state pill per row, and only the five this screen has.
    const pills = Object.values(familyTexts.rowState);
    const onRow = pills.filter((word) => text.includes(word));
    expect(onRow, `exactly one state pill on the row (${text})`).toHaveLength(1);

    /*
     * No pill wraps and none is taller than one line (contract: "Pills are 22px high with one
     * line and no wrap"). Asserted on the row's own chip rather than on a stylesheet.
     */
    const chip = first.locator("[data-pill='true']").first();
    if ((await chip.count()) > 0) {
      expect(await css(chip, "white-space")).toBe("nowrap");
      const box = await chip.boundingBox();
      expect(box!.height).toBeLessThanOrEqual(24);
    }
  });

  test("the thread header, the bubbles and the Auto · Delivered line", async ({ page }) => {
    await page.goto(SCREEN);

    // family-texts.html `.th-h`: the adult, the child and the van, and approvals.html's green
    // Verified chip beside them.
    await expect(page.getByText(familyTexts.verified, { exact: true }).first()).toBeVisible();

    /*
     * family-texts.html `.b.in` / `.b.out`: the parent's bubbles grey on the LEFT, the centre's
     * teal on the RIGHT, 18 px corners. Measured rather than read off a class name.
     */
    const bubbles = page.locator("[data-bubble]");
    const count = await bubbles.count();
    expect(count, "the thread has bubbles").toBeGreaterThan(0);
    const frame = await page.locator("[data-messages]").boundingBox();
    for (let i = 0; i < count; i += 1) {
      const bubble = bubbles.nth(i);
      const side = await bubble.getAttribute("data-bubble");
      const box = await bubble.boundingBox();
      const middle = frame!.x + frame!.width / 2;
      if (side === "IN") {
        expect(box!.x, `parent bubble ${i} is on the left`).toBeLessThan(middle);
      } else {
        expect(box!.x + box!.width, `staff bubble ${i} is on the right`).toBeGreaterThan(middle);
      }
      expect(await css(bubble, "border-top-left-radius")).toBe("18px");
    }

    // family-texts.html `.ts`: a centred stamp above each run, saying the day and the time.
    await expect(page.getByText(familyTexts.stampToday).first()).toBeVisible();

    // family-texts.html `.meta`: "Auto · Delivered", on a templated follow-up and nothing else.
    await expect(page.getByText(familyTexts.autoDelivered).first()).toBeVisible();

    // No [DEMO] tag and no STOP/HELP footer in a bubble (Firia, 10:51 PM ET: they are the send
    // pipeline's, and belong on a family's phone).
    await expect(page.getByText("[DEMO]")).toHaveCount(0);
    await expect(page.getByText(/Reply HELP for help/)).toHaveCount(0);
  });

  test("the For you tab is three panes: list, thread with the card, van and pick-up", async ({ page }) => {
    await page.goto(FOR_YOU);
    await expect(page.getByRole("heading", { level: 1, name: familyTexts.heading })).toBeVisible();
    expect(await page.getByRole("heading", { level: 1 }).count(), "one title, the frame's").toBe(1);
    // approvals.html `.tabs`: For you is current, and it is a tab of this screen, not a page.
    await expect(page.getByRole("link", { name: new RegExp(familyTexts.tabForYou) })).toHaveAttribute(
      "aria-current",
      "page",
    );

    const state = await stateOf(page);
    if (state === "card") {
      const card = cardRegion(page);
      await expect(card.first()).toBeVisible();

      /*
       * THREE PANES, left to right (Firia, 2026-10-17 10:51 PM ET; approvals.html `.work`):
       * the list, the thread with the card inline, and the van / pick-up pane.
       */
      const rows = page.getByRole("list", { name: familyTexts.conversationsLabel });
      const context = page.getByRole("complementary", { name: familyTexts.rideContext });
      await expect(context).toBeVisible();
      const listBox = await rows.boundingBox();
      const cardBox = await card.first().boundingBox();
      const ctxBox = await context.boundingBox();
      expect(listBox!.x + listBox!.width, "the list is left of the card").toBeLessThanOrEqual(cardBox!.x + 1);
      expect(cardBox!.x + cardBox!.width, "the card is left of the pane").toBeLessThanOrEqual(ctxBox!.x + 1);

      // approvals.html `.ctx`: the child, the van and its driver, the counts after the change,
      // and who may collect them.
      await expect(context.getByText(familyTexts.allowedPickup)).toBeVisible();
      await expect(context.getByText(/Van \d/).first()).toBeVisible();
      // NO ETA on this screen (Firia, 8:36 PM and 10:51 PM ET): the mockup's "On time" pill is a
      // state chip instead, and no arrival time is drawn anywhere in the pane.
      await expect(context.getByText(/\b(?:1[0-2]|[1-9]):[0-5]\d\s?(?:AM|PM)\b/)).toHaveCount(0);
      await expect(context.getByText("On time")).toHaveCount(0);

      /*
       * approvals.html `.acts`: ONE row of three buttons, teal first, and no time input and no
       * helper line on the resting card (Firia, 10:51 PM ET).
       */
      const approve = page.getByRole("button", { name: approval.approveAndSend }).first();
      // Edit is a link (a navigation), the other two are the decision's buttons.
      const edit = page.getByRole("link", { name: approval.edit }).first();
      const dontSend = page.getByRole("button", { name: approval.dontSend }).first();
      await expect(approve).toBeVisible();
      await expect(edit).toBeVisible();
      await expect(dontSend).toBeVisible();
      const [a, e, d] = await Promise.all([approve.boundingBox(), edit.boundingBox(), dontSend.boundingBox()]);
      expect(Math.abs(a!.y - e!.y), "Approve and Edit share a row").toBeLessThanOrEqual(2);
      expect(Math.abs(a!.y - d!.y), "Don't send shares it too").toBeLessThanOrEqual(2);
      expect(a!.x, "teal Approve & send is first").toBeLessThan(e!.x);
      expect(await card.first().locator("input[type='time']").count(), "no time input").toBe(0);

      /*
       * The thread opens at its newest message, so the card's own controls are on screen rather
       * than under the fold — which is what every messaging screen does and what the mockup
       * draws (approvals.html: the card sits against the compose bar).
       */
      const scroll = await page.locator("[data-messages]").evaluate((el) => ({
        top: el.scrollTop,
        height: el.scrollHeight,
        client: el.clientHeight,
      }));
      expect(scroll.height, "the thread scrolls").toBeGreaterThan(scroll.client);
      expect(scroll.top, "and opens at its end").toBeGreaterThan(scroll.height - scroll.client - 4);
      const actions = await dontSend.boundingBox();
      expect(actions!.y + actions!.height, "the controls are on screen").toBeLessThanOrEqual(900);

      // approvals.html `.draft`: the exact words, and they name the child (Firia, 10:51 PM ET).
      await expect(card.first().getByText(/gets off at/)).toBeVisible();
      // Nothing is sent until a person says so, and the card says that before anything is pressed.
      await expect(page.getByText(approval.nothingUntilApproved).first()).toBeVisible();
    } else {
      // Gate 5: no card at all, and the alert in its place.
      await expect(cardRegion(page)).toHaveCount(0);
      await expect(page.getByText(assistantUnavailable.rule)).toBeVisible();
    }
    expect(await scrollWidth(page)).toBeLessThanOrEqual(1440);
    await expectNoInternalCodes(page);
    console.log("screenshot:", await shot(page, `for-you-1440-${state}`));
  });

  /**
   * VERA'S CARD, and nothing else on it (Firia relaying Vera, 2026-10-18 7:51 AM ET).
   *
   * Three things: the parent's name, the message as a bubble, and the three buttons — worded as
   * mockups/approvals.html `.acts` words them, and drawn as the inline `.prop` of
   * mockups/family-texts.html (png/family-texts-1440.png) draws them. What this asserts is as
   * much about what is gone: **no Time row**, and no clock time anywhere on the card.
   */
  test("the card is the parent's name, the message as a bubble, and three buttons", async ({ page }) => {
    await page.goto(FOR_YOU);
    test.skip(!(await hasCard(page)), "needs the card state (a reachable model)");
    const card = cardRegion(page).first();

    /*
     * The parent's name, as the card's own heading — the family these words would go to. Read
     * back out of the card's accessible name, which is the same name with `approval.cardLabel`
     * around it, so the two cannot disagree about which family this is.
     */
    const adult = ((await card.getAttribute("aria-label")) ?? "")
      .replace(approval.cardLabel.replace("{adult}", ""), "")
      .trim();
    expect(adult, "the card names a family").not.toBe("");
    await expect(card.getByRole("heading", { name: adult })).toBeVisible();

    // The message, in a bubble: one, and the same words the thread would show once it is sent.
    await expect(card.getByText(/gets off at/)).toBeVisible();

    // The three controls, and no fourth: two decision buttons and Edit, which is a link.
    for (const name of [approval.approveAndSend, approval.dontSend]) {
      await expect(card.getByRole("button", { name })).toHaveCount(1);
    }
    await expect(card.getByRole("link", { name: approval.edit })).toHaveCount(1);
    expect(await card.getByRole("button").count(), "two buttons, and no more").toBe(2);

    /*
     * NO TIME ROW, and no clock time at all. The ride's hour is not on the card: the body of
     * `dropoff.changed` places the stop and not the hour, and the before→after table that used
     * to carry "Time 4:30 PM → 5:30 PM" is gone with it.
     */
    await expect(card.getByText(/\b(?:1[0-2]|[1-9]):[0-5]\d\s?(?:AM|PM)\b/)).toHaveCount(0);
    expect(await card.locator("input[type='time']").count(), "no time input at rest").toBe(0);
    console.log("screenshot:", await shot(page, "for-you-card-1440"));
  });

  test("Edit is a navigation, and it opens the reply's words without sending", async ({ page }) => {
    await page.goto(FOR_YOU);
    test.skip(!(await hasCard(page)), "needs the card state (a reachable model)");

    /*
     * Firia's gate 2, and the ruling of 10:51 PM ET that the resting card has no field: Edit
     * navigates to the Edit state, where the reply's words are in a text box (Edit = the message
     * text, user ruling 2026-10-18). It writes nothing and sends nothing — the card comes back with
     * Approve still to press, and the words never appear in the URL.
     */
    await page.getByRole("link", { name: approval.edit }).first().click();
    await expect(page).toHaveURL(/edit=/);
    const card = cardRegion(page).first();
    await expect(card.getByRole("textbox", { name: approval.editLabel })).toBeVisible();
    await expect(page.getByRole("button", { name: approval.approveAndSend }).first()).toBeVisible();
    await expect(page.getByText(approval.nothingUntilApproved).first()).toBeVisible();
  });
});

test.describe("390: the list, then the thread", () => {
  test.use({ viewport: { width: PHONE, height: 844 } });

  test("shows the list, and a row opens the thread with a way back", async ({ page }) => {
    await page.goto(SCREEN);

    const rows = page.getByRole("list", { name: familyTexts.conversationsLabel });
    await expect(rows).toBeVisible();
    await expect(rows.getByRole("link")).toHaveCount(THREADS);
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

    /*
     * NOT BUILT, and recorded here rather than left unsaid. Firia, 10:51 PM ET: "at 390 hide the
     * page title on the thread view, keep a visually-hidden h1". Since #74 the title is **the
     * frame's** — one 64 px page header bar above every screen, with the h1 in it
     * (src/ui/PageHeader.tsx, read from the access table) — and this PR is told to take #74's
     * frame as #74 has it and add no frame work of its own. Hiding that bar on one view of one
     * screen is a change to PageHeader, so it belongs to the frame PR.
     *
     * What this asserts meanwhile is the half that is true and must stay true: exactly one h1 on
     * the page at this width, and it names the screen.
     */
    const title = page.getByRole("heading", { level: 1, name: familyTexts.heading });
    expect(await title.count(), "exactly one h1, and it is the frame's").toBe(1);

    // family-texts.html `.th-h .back`: a back chevron that returns to the list.
    const back = page.getByRole("link", { name: familyTexts.backToList });
    await expect(back).toBeVisible();

    // family-texts.html `.cmp`: the compose bar is pinned to the bottom of the thread.
    const send = page.getByRole("button", { name: familyTexts.composeAction, exact: true });
    await expect(send).toBeVisible();
    const sendBox = await send.boundingBox();
    expect(sendBox!.y, "the bar sits in the lower half of the phone").toBeGreaterThan(844 / 2);

    expect(await scrollWidth(page)).toBeLessThanOrEqual(PHONE);
    console.log("screenshot:", await shot(page, "family-texts-390-thread"));

    await back.click();
    await expect(rows).toBeVisible();
    await expectNoInternalCodes(page);
  });

  test("the For you tab stacks one card per row, with no horizontal scroll", async ({ page }) => {
    await page.goto(FOR_YOU);
    const state = await stateOf(page);
    // png/approvals-390.png: the panes stack into one column and nothing runs off the side.
    expect(await scrollWidth(page)).toBeLessThanOrEqual(PHONE);

    // png/approvals-390.png: every row is a full-width card, one per row.
    const rows = page.getByRole("list", { name: familyTexts.conversationsLabel }).getByRole("link");
    const rowCount = await rows.count();
    expect(rowCount).toBe(THREADS);
    for (let i = 0; i < rowCount; i += 1) {
      const box = await rows.nth(i).boundingBox();
      expect(box!.x + box!.width, `row ${i} fits the phone`).toBeLessThanOrEqual(PHONE + 1);
      expect(box!.width, `row ${i} spans the phone`).toBeGreaterThan(PHONE * 0.8);
    }

    if (state === "card") {
      const cards = cardRegion(page);
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

  test("the NEEDS_PERSON alert is first on For you, and counted on the tab", async ({ page }) => {
    await page.goto(FOR_YOU);
    const state = await stateOf(page);
    test.skip(state !== "alert", "needs the no-model state (the alert)");

    /*
     * Firia, 2026-10-17 8:36 PM ET, and docs/DATA-MODEL.md's signed row for the NEEDS_PERSON
     * staff alert: it is at the TOP of For you, for director and coordinator only, and it counts
     * toward what is waiting. The front desk never reaches this tab at all
     * (e2e/family-texts-front-desk.spec.ts, and the server half in
     * src/modules/approvals/front-desk-cannot-approve.test.ts).
     */
    const alert = page.getByRole("heading", { name: assistantUnavailable.heading });
    await expect(alert).toBeVisible();
    const alertBox = await alert.boundingBox();
    const rows = page.getByRole("list", { name: familyTexts.conversationsLabel });
    const rowsBox = await rows.boundingBox();
    expect(alertBox!.y, "the alert is above the day's rows").toBeLessThan(rowsBox!.y);

    // And no proposal card anywhere, because nothing read the family's text (gate 5).
    await expect(cardRegion(page)).toHaveCount(0);
    expect(await scrollWidth(page)).toBeLessThanOrEqual(PHONE);
  });
});
