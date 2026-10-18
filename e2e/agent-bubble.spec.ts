/**
 * THE AGENT CHAT BUBBLE, IN A BROWSER — the founder's ask of 2026-10-18: "a floating chat bubble
 * at the bottom right, inside the app frame, that opens the agent chat from any screen."
 *
 * VERA'S BINDING MOCKUP, and every assertion below cites a part of it:
 *   /workspace/ppec-redesign/mockups/agent-bubble.html   (`#open` shows the panel; `?page=map`
 *                                                         puts the Live map behind it)
 *   /workspace/ppec-redesign/png/agent-bubble-closed-1440.png
 *   /workspace/ppec-redesign/png/agent-bubble-open-1440.png
 *   /workspace/ppec-redesign/png/agent-bubble-closed-390.png
 *   /workspace/ppec-redesign/png/agent-bubble-open-390.png
 * and, for the compact proposal card inside the panel,
 *   /workspace/ppec-redesign/mockups/family-texts.html   (`.prop`: the question as the title,
 *                                                         then one row of actions)
 *
 * WHAT ONLY A BROWSER CAN SAY. src/ui/agent-bubble.test.ts proves the rules are written — the
 * disc is mounted once, in the shell every route's layout renders; the stylesheet puts it 16 px
 * off the corner and 16 px above the tab bar; the panel is 400 px under the DEMO bar. What it
 * cannot prove is the thing the founder would actually notice: that the disc **does not sit on
 * top of anything**. A `position: fixed` control over a scrolling page is exactly the bug the
 * tab bar had before it was given its clearance, so the boxes are measured here — against the
 * tab bar, and against every control the Live map floats at the bottom of its own pane.
 *
 * One run is one role (`E2E_DEMO_ROLE`, playwright.config.ts). The bubble is drawn only for the
 * roles that may decide (`APPROVAL_ROLES`), so a front-desk run asserts its absence instead,
 * which is the same rule read from the other side.
 */
import { expect, test, type Page } from "@playwright/test";
import { APPROVAL_ROLES, FAMILY_TEXTS_FOR_YOU } from "../src/auth/access";
import type { StaffRole } from "../src/auth/core";
import { agentBubble } from "../src/ui/copy";
import { layout } from "../src/ui/tokens";
import { boxOf, expectNoInternalCodes, overlaps, shot, type Box } from "./helpers";

const ROLE = (process.env.E2E_DEMO_ROLE ?? "DIRECTOR") as StaffRole;
const CAN_DECIDE = APPROVAL_ROLES.includes(ROLE);

/** The two widths the frame is ruled on, and the two the mockup was shot at. */
const PHONE = { width: 390, height: 844 };
const DESK = { width: 1440, height: 900 };

/**
 * The three screens the founder clicks between. Today is the board; Plan routes and Live map are
 * two of the three routes that live outside src/app/(app) and mount the shell through a layout
 * of their own — so if one mount were ever four, these are where it would show.
 */
const SCREENS = ["/today", "/plan-routes", "/live-map"] as const;

const px = (v: string) => Number(v.replace("px", ""));

const bubble = (page: Page) => page.getByRole("button", { name: new RegExp(`^${agentBubble.open}`) });
const panel = (page: Page) => page.getByRole("dialog", { name: agentBubble.title });

/** The gap between two boxes on the vertical axis, negative when they overlap. */
function verticalGap(above: Box, below: Box): number {
  return below.y - (above.y + above.height);
}

test.describe("the closed disc", () => {
  test.skip(!CAN_DECIDE, "the bubble is only drawn for the roles that may decide");

  for (const screen of SCREENS) {
    test(`is 56 px, teal and 16 px off the corner on ${screen} at 1440`, async ({ page }) => {
      await page.setViewportSize(DESK);
      await page.goto(screen);
      const box = await boxOf(bubble(page));

      // agent-bubble.html `.fab`: 56 px square, `right:16px; bottom:16px`.
      expect(Math.round(box.width)).toBe(px(layout.agentBubbleSize));
      expect(Math.round(box.height)).toBe(px(layout.agentBubbleSize));
      expect(Math.round(DESK.width - (box.x + box.width))).toBe(px(layout.agentBubbleGap));
      expect(Math.round(DESK.height - (box.y + box.height))).toBe(px(layout.agentBubbleGap));

      // Teal, and the disc carries no words — the name is for the ear (png/agent-bubble-closed-1440.png).
      await expect(bubble(page)).toHaveText("");
      await expectNoInternalCodes(page);
    });

    test(`sits above the tab bar on ${screen} at 390`, async ({ page }) => {
      await page.setViewportSize(PHONE);
      await page.goto(screen);
      const disc = await boxOf(bubble(page));
      const bar = await boxOf(page.locator("[data-tab-bar]"));

      // `.fab{bottom:80px}` below 767 — the mockup's own comment: "64px tab bar + 16px".
      expect(overlaps(disc, bar), "the disc is on top of the tab bar").toBe(false);
      expect(Math.round(verticalGap(disc, bar))).toBe(px(layout.agentBubbleGap));
      expect(Math.round(disc.width)).toBe(px(layout.agentBubbleSize));
    });
  }

  test("does not cover any of the Live map's own controls, at either width", async ({ page }) => {
    /*
     * The zoom group and the credits are MapLibre's, added at `bottom-right` of the map pane
     * (src/modules/live-map/LiveMapPane.tsx), and the zoom buttons are widened to the §9 44 px
     * target (live-map.module.css). The clearance is the content column's bottom padding —
     * `--layout-agent-bubble-clear-wide` 88 px at 1440, and 80 px on top of the tab bar's 64 at
     * 390 — which shortens the pane and lifts everything pinned to its floor.
     */
    for (const size of [DESK, PHONE]) {
      await page.setViewportSize(size);
      await page.goto("/live-map");
      const disc = await boxOf(bubble(page));
      for (const control of ["maplibregl-ctrl-group", "maplibregl-ctrl-attrib"]) {
        const locator = page.locator(`.${control}`).first();
        if ((await locator.count()) === 0) continue;
        const box = await boxOf(locator);
        expect(
          overlaps(disc, box),
          `the disc covers .${control} at ${size.width}`,
        ).toBe(false);
      }
      await shot(page, `agent-bubble-closed-${size.width}`);
    }
  });
});

test.describe("the panel", () => {
  test.skip(!CAN_DECIDE, "the bubble is only drawn for the roles that may decide");

  test("is a 400 px panel under the DEMO bar at 1440, with no overlay, and the disc hidden", async ({ page }) => {
    await page.setViewportSize(DESK);
    await page.goto("/today");
    await bubble(page).click();

    const box = await boxOf(panel(page));
    // `.pnl{top:32px;right:0;bottom:0;width:400px}` — under the DEMO bar, against the right edge.
    expect(Math.round(box.width)).toBe(px(layout.agentPanelWidth));
    expect(Math.round(box.x + box.width)).toBe(DESK.width);
    expect(Math.round(box.y)).toBe(px(layout.demoBannerHeight));
    expect(Math.round(box.y + box.height)).toBe(DESK.height);

    // `body.open .fab{display:none}` — and there is no scrim behind it (png/agent-bubble-open-1440.png).
    await expect(bubble(page)).toBeHidden();
    await expect(page.getByRole("heading", { name: agentBubble.title })).toBeVisible();
    await shot(page, "agent-bubble-open-1440");
  });

  test("is a full sheet over the tab bar at 390, with a 44 px close X", async ({ page }) => {
    await page.setViewportSize(PHONE);
    await page.goto("/today");
    await bubble(page).click();

    const box = await boxOf(panel(page));
    // `.pnl{width:auto;left:0;border-left:0}` below 767: the sheet is the width of the window
    // and runs to the floor, over the tab bar (png/agent-bubble-open-390.png).
    expect(Math.round(box.x)).toBe(0);
    expect(Math.round(box.width)).toBe(PHONE.width);
    expect(Math.round(box.y + box.height)).toBe(PHONE.height);

    const close = page.getByRole("button", { name: agentBubble.close });
    const closeBox = await boxOf(close);
    expect(Math.round(closeBox.width)).toBe(44);
    expect(Math.round(closeBox.height)).toBe(44);
    // Top right of the sheet, as the mockup draws it.
    expect(closeBox.x + closeBox.width).toBeGreaterThan(PHONE.width - 60);
    await shot(page, "agent-bubble-open-390");

    await close.click();
    await expect(panel(page)).toBeHidden();
    await expect(bubble(page)).toBeVisible();
  });

  test("carries the title, the compose bar and no clock times", async ({ page }) => {
    await page.setViewportSize(DESK);
    await page.goto("/today");
    await bubble(page).click();

    await expect(page.getByRole("heading", { name: agentBubble.title })).toBeVisible();
    // `.cmp`: "Ask the agent…" and a round send button, pinned to the foot of the panel.
    const field = page.getByRole("textbox", { name: agentBubble.ask });
    await expect(field).toBeVisible();
    const send = page.getByRole("button", { name: agentBubble.send });
    const panelBox = await boxOf(panel(page));
    const fieldBox = await boxOf(field);
    expect(fieldBox.y + fieldBox.height).toBeGreaterThan(panelBox.y + panelBox.height - 100);
    expect(Math.round((await boxOf(send)).height)).toBe(44);

    /*
     * The COMPACT card (mockups/family-texts.html `.prop`), not the full For you card
     * (mockups/approvals.html): no details table and no clock times anywhere in the panel.
     */
    await expect(panel(page).locator("table")).toHaveCount(0);
    await expect(panel(page).getByText(/\d{1,2}:\d{2}\s?(?:AM|PM)/)).toHaveCount(0);
    await expectNoInternalCodes(page);
  });

  test("stays open across a navigation between tabs", async ({ page }) => {
    await page.setViewportSize(DESK);
    await page.goto("/today");
    await bubble(page).click();
    await expect(panel(page)).toBeVisible();

    // The shell is the persistent layout, so changing tab replaces the page inside the panel's
    // sibling and never the panel (src/ui/ConsoleShell.tsx).
    for (const screen of ["/plan-routes", "/live-map"]) {
      await page.goto(screen);
      await expect(panel(page), `the panel closed itself on ${screen}`).toBeVisible();
    }
  });
});

test.describe("where the bubble is not", () => {
  test("is not on Family texts → For you", async ({ page }) => {
    test.skip(!CAN_DECIDE, "a role that may not decide cannot open For you at all");
    await page.setViewportSize(DESK);
    await page.goto(FAMILY_TEXTS_FOR_YOU);
    // The thread in the panel *is* this screen; a floating copy of it on top of itself is two
    // places to approve one thing.
    await expect(bubble(page)).toHaveCount(0);
    await expect(panel(page)).toHaveCount(0);
  });

  test("is not drawn at all for a role that may not decide", async ({ page }) => {
    test.skip(CAN_DECIDE, "this role may decide, so the bubble is theirs");
    for (const screen of ["/live-map", "/ramp-ipad"]) {
      await page.setViewportSize(PHONE);
      await page.goto(screen);
      await expect(bubble(page), `the bubble is on ${screen} for ${ROLE}`).toHaveCount(0);
    }
  });
});
