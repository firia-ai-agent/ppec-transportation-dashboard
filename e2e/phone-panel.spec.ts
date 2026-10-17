/**
 * The click-through PRD §18.2 step 7 is demonstrated by, in a real browser: a child on the
 * board → their drawer → the text their family got.
 *
 * Why a browser check and not another render test: the point of this screen is that a founder
 * can *reach* it and read it. The drawer is a client overlay opened by a keyboard or a pointer,
 * the link is a navigation, and the thread it lands on is a server render of a different route —
 * none of which a `renderToStaticMarkup` assertion can walk end to end.
 *
 * No database and no credentials: the server runs with the test-only synthetic session
 * (playwright.config.ts, src/domain/access/map-view.ts), which grants a role and nothing else and
 * is refused outright on any deployment. With no database the panel falls back to the demo day's
 * own projection and says so on screen — which is the state this check asserts, and the reason
 * the fallback exists.
 */
import { expect, test } from "@playwright/test";
import { demoDay } from "../src/domain/board/day";
import { demoLateDropoffs } from "../src/modules/demo/late-dropoff";
import { board as boardCopy, drawer, fill, phonePanel } from "../src/ui/copy";
import {
  expectDemoBarPinned,
  expectNoInternalCodes,
  expectVioletOnlyOnDemoChrome,
  shot,
} from "./helpers";

const day = demoDay();
const texts = demoLateDropoffs(day);
/** The family the afternoon stall reaches last — the one the demo walks to. */
const noah = texts[texts.length - 1];

test.use({ viewport: { width: 1280, height: 900 } });

test("from a child on the board to the text their family got", async ({ page }) => {
  await page.goto("/today");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

  // The child's own row opens the drawer (SURF-02). The afternoon row, because the afternoon is
  // the ride the text is about — the same opener the board's own check uses.
  await page
    .getByRole("button", {
      name: fill(boardCopy.openRow, { child: noah.childLabel, ride: boardCopy.pmSpoken }),
    })
    .click();
  const panel = page.getByRole("dialog", { name: new RegExp(noah.childLabel) });
  await expect(panel).toBeVisible();

  // …and the drawer offers the family's thread, named for whose text it opens.
  const link = panel.getByRole("link", {
    name: fill(drawer.openTexts, { child: noah.childLabel }),
  });
  await expect(link).toBeVisible();
  console.log("screenshot:", await shot(page, "today-drawer-texts"));

  await link.click();
  await expect(page.getByRole("heading", { level: 1, name: phonePanel.heading })).toBeVisible();

  // The thread: the adult who holds the phone, the child the texts are about, and the body.
  await expect(page.getByRole("heading", { level: 2 })).toContainText(noah.guardianName);
  await expect(page.getByText(noah.body, { exact: false })).toBeVisible();
  // The §8 10-minute window and how late the van is, in the words a family reads.
  await expect(page.getByText(noah.windowText, { exact: false })).toBeVisible();
  await expect(page.getByText(`about ${noah.delayMinutes} minutes late`, { exact: false })).toBeVisible();
  // No child's name in the body a family receives (Veri #12) — the chrome around it names them.
  const bubble = await page.getByText(noah.body, { exact: false }).innerText();
  expect(bubble).not.toContain(noah.childFirstName);

  // §6.3: the phone says it is simulated, and §7 / §7.1's bar and chip are the layout's own.
  await expect(page.getByText(phonePanel.simulatedPhone)).toBeVisible();
  await expectDemoBarPinned(page);
  await expectVioletOnlyOnDemoChrome(page);
  await expectNoInternalCodes(page);

  // With no database behind this check, the panel is honest about where the bubbles came from.
  await expect(page.getByText(phonePanel.fromScenario)).toBeVisible();
  console.log("screenshot:", await shot(page, "phone-panel"));
});

/**
 * The assistant half (PRD §18.2 steps 9–10). The browser check runs with no model key — the
 * synthetic session has no secrets of any kind — so what it walks is the **degraded** path, and
 * the thing worth asserting is exactly that: the panel says a keyword reader answered, says that
 * nothing changed and nothing was sent, and never dresses the fallback up as a model answer.
 *
 * The model path and the approval that follows it are held by `agent-turn.test.ts`, which drives
 * the same seam with a scripted provider; walking them in a browser needs the key on the
 * deployment, which is an environment change and not a code one.
 */
test("a staff-typed parent text reaches the assistant, and the answer says who gave it", async ({ page }) => {
  await page.goto(`/phone-preview?child=${noah.childKey}`);

  const composer = page.getByRole("textbox", {
    name: fill(phonePanel.composerHeading, { adult: noah.guardianName }),
  });
  await expect(composer).toHaveValue(fill(phonePanel.composerExample, { child: noah.childFirstName }));

  await page.getByRole("button", { name: fill(phonePanel.composerSend, { adult: noah.guardianName }) }).click();

  await expect(page.getByRole("heading", { name: phonePanel.turnHeading })).toBeVisible();
  await expect(page.getByText(phonePanel.answeredByKeyword)).toBeVisible();
  await expect(page.getByText(phonePanel.nothingHappened)).toBeVisible();
  await expectNoInternalCodes(page);
  console.log("screenshot:", await shot(page, "phone-panel-agent"));
});

test("every family the day texted has its own thread, and no other", async ({ page }) => {
  await page.goto("/phone-preview");
  for (const text of texts) {
    const tab = page.getByRole("link", {
      name: fill(phonePanel.tab, { adult: text.guardianName, child: text.childFirstName }),
    });
    await expect(tab).toBeVisible();
    await tab.click();
    await expect(page.getByRole("heading", { level: 2 })).toContainText(text.guardianName);
    await expect(page.getByText(text.body, { exact: false })).toBeVisible();
  }
  // The family already home when the van stopped is not in the panel at all (AT-03).
  await expect(page.getByText("Theo", { exact: false })).toHaveCount(0);
});
