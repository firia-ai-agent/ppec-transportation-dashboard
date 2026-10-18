/**
 * The three screens, in a real browser, at the two widths the review used.
 *
 * Everything here is a question the unit tests cannot answer, because the answer is a box on a
 * screen: is the DEMO bar still visible after a scroll, is the icon rail clipping its icons,
 * does the sticky verdict banner sit on top of a checklist row, is the map attribution inside
 * the pane at 1024. Each one is measured, not eyeballed, and the screenshots land in
 * artifacts/ so a design review has the picture next to the assertion.
 *
 * No database and no credentials: the server runs with the test-only synthetic session (see
 * playwright.config.ts and src/domain/access/map-view.ts), which grants a role and nothing else
 * and is refused outright on any deployment.
 */
import { expect, test, type Locator } from "@playwright/test";
import { canOpenPage } from "../src/auth/access";
import type { StaffRole } from "../src/auth/core";
// `fleetMap` and `liveMap` left with the live-map block below: this file no longer names them.
import { fill, nav, planRoutes, rampIpad } from "../src/ui/copy";
import { navItemsFor } from "../src/ui/nav-items";
import {
  boxOf,
  contains,
  expectDemoBarPinned,
  expectNoInternalCodes,
  expectOneSimulatedChip,
  expectVioletOnlyOnDemoChrome,
  overlaps,
  shot,
} from "./helpers";

/** The review's two widths: the icon rail lives at 1024, the labelled rail at 1280. */
const WIDTHS = [1024, 1280] as const;

const VIEWPORT = { height: 900 };

/**
 * ONE RUN IS ONE ROLE (`E2E_DEMO_ROLE`, playwright.config.ts), so this file asks the role it
 * was started as rather than assuming the director.
 *
 * Three of the four screens below are not every role's: the board and Plan routes are the
 * console's, which the front desk's row does not open at all (they are sent home, §9.3), and
 * the live map's demo internals — the injected-fault panel and the scenario clock — are the
 * director's alone (`MAP_DATA_BY_ROLE`, src/domain/access/map-view.ts). So each claim is made
 * about the role's *own* view: a screen their row does not open is skipped and said to be
 * skipped, and a panel their row does not carry is asserted absent rather than expected.
 */
const ROLE = (process.env.E2E_DEMO_ROLE ?? "DIRECTOR") as StaffRole;
const CALLER = { kind: "STAFF", role: ROLE } as const;
const MENU = navItemsFor(ROLE);
/*
 * `SEES_DEMO_INTERNALS` went with the live-map block below: the injected-fault panel and the
 * per-screen scenario clock it gated are both deleted from the build, so a constant about who
 * can see them is a constant about nothing. The role-by-role story for the live map is
 * e2e/live-map.spec.ts and src/modules/live-map/roles.test.ts now.
 */

for (const width of WIDTHS) {
  test.describe(`at ${width}px`, () => {
    test.use({ viewport: { width, ...VIEWPORT } });

    test("the board carries the DEMO bar and a rail that is not clipped", async ({ page }) => {
      test.skip(!canOpenPage(CALLER, "/today"), `${ROLE} does not open the board`);
      await page.goto("/today");
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

      // NFR-09 / §7: the same bar as /login, on a signed-in page, and still there once the
      // board is scrolled — which is where it used to disappear.
      await expectDemoBarPinned(page);

      const rail = page.getByRole("navigation", { name: nav.landmarkLabel });
      await expect(rail).toBeVisible();
      const railBox = await boxOf(rail);
      // §2: 64 px icon rail below 1280, 232 px labelled rail at and above it.
      expect(railBox.width).toBe(width < 1280 ? 64 : 232);

      // §2 / §9: every item is reachable and named, and nothing hangs off the rail's edge.
      for (const item of MENU) {
        const link = rail.getByRole("link", { name: item.label });
        await expect(link).toHaveAttribute("title", item.label);
        const icon = link.locator("svg");
        const iconBox = await boxOf(icon);
        expect(
          contains(railBox, iconBox),
          `${item.label}'s icon is clipped by the rail: ${JSON.stringify(iconBox)} vs ${JSON.stringify(railBox)}`,
        ).toBe(true);
      }

      /*
       * D-5, on the screen the reservation was being spent on: the header's four adapter pills
       * used to carry the demo violet, beside a bar that says "DEMO" and a chip that says
       * "Simulated". The pills are gone altogether now (Vera, 2026-10-17 2:44 PM ET) — one
       * Simulated chip on a screen — so the violet is on the bar and that chip and nothing else.
       */
      await expectVioletOnlyOnDemoChrome(page);
      await expectOneSimulatedChip(page);

      await expectNoInternalCodes(page);
      console.log("screenshot:", await shot(page, `today-${width}`));
    });

    /*
     * THE LIVE MAP'S BLOCK IS DELETED FROM THIS FILE, NOT ADAPTED.
     *
     * It drove #53's debug screen: `liveMap.pause` (the per-screen scenario clock), the
     * "Fit all" button, the vehicle list's `/^V1 · /` cards, the in-page ×10 speed control,
     * the `Open Ramp iPad` link, and `data-vehicles-drawn="V1,V2,V3"`. Every one of those is
     * gone from the build — the founder's redesign replaces that screen whole — so every one of
     * those assertions is gone from the specs (MOCKUP-TEST-CONTRACT.md, "Specs to delete, not
     * adapt"), rather than being widened until it passes.
     *
     * What it was really checking is not lost; it moved, and grew. e2e/live-map.spec.ts now
     * covers the tiles actually drawing, the attribution, the ≥44 px targets, both widths, and
     * the things this file could not ask about at all: the four state chips, the absence of any
     * ETA, the van colours, the locked state and the front desk.
     */

    test("the ramp iPad renders, and its sticky banner covers no row", async ({ page }) => {
      await page.goto("/ramp-ipad");
      await expect(page.getByRole("heading", { level: 1, name: rampIpad.heading })).toBeVisible();
      await expectDemoBarPinned(page);
      await expectVioletOnlyOnDemoChrome(page);
      console.log("screenshot:", await shot(page, `ramp-ipad-${width}`));

      // §9 / COPY-GUIDE: the selected answer is filled and announced, not outlined.
      const notSure = page.getByRole("button", { name: rampIpad.answer.UNSURE }).first();
      await expect(notSure).toHaveAttribute("aria-pressed", "true");
      const chosenVehicle = page.getByRole("button", { name: /^V1 · / });
      await expect(chosenVehicle).toHaveAttribute("aria-pressed", "true");
      // The setup buttons say what the layout is, never the provider's shorthand.
      await expect(page.getByRole("button", { name: "1 wheelchair · 3 seats" })).toBeVisible();
      await expect(page.getByText(/\d+WC\/\d+A/)).toHaveCount(0);

      /*
       * The sticky verdict banner used to be pinned over the lift row, the second walking seat
       * and the top of the rider list, with no way to scroll them clear. The page now reserves
       * its height, so at the bottom of the page the banner sits below everything.
       */
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(500);
      const banner = page.locator("#ramp-verdict");
      await expect(banner).toBeVisible();
      const bannerBox = await boxOf(banner);

      const rows: Array<[string, Locator]> = [
        [rampIpad.liftRow, page.getByText(rampIpad.liftRow, { exact: true })],
        ["Walking seat 2", page.getByText("Walking seat 2", { exact: true }).first()],
        [rampIpad.ridersHeading, page.getByRole("heading", { name: rampIpad.ridersHeading })],
        // The last rider card is the one actually on screen at the bottom of the page, so it
        // is the row a banner that reserved nothing would still be sitting on.
        ["the last rider card", page.locator("#ramp-verdict").locator("xpath=preceding::div[contains(@style,'border-top')]").last()],
      ];
      for (const [name, locator] of rows) {
        const box = await boxOf(locator);
        expect(
          overlaps(box, bannerBox),
          `the verdict banner covers "${name}": ${JSON.stringify(box)} vs ${JSON.stringify(bannerBox)}`,
        ).toBe(false);
      }

      await expectNoInternalCodes(page);
      console.log("screenshot:", await shot(page, `ramp-ipad-${width}-bottom`));
    });

    /**
     * Plan routes, at both of the review's widths: the map is beside the lanes.
     *
     * The second column started at 1280, so at 1024 — the width where the nav is the 64 px icon
     * rail — the map pane was laid out after the lane column: three tall vans of scrolling
     * before the pane that is meant to be read next to the plan (Vera's review, 2026-10-17).
     * Measured rather than eyeballed, and either answer is allowed: beside the lanes, or pinned
     * directly under the header. What is not allowed is below every lane, which is what "is it
     * in the window at the top of the page" asks.
     */
    test("Plan routes keeps the map beside the lanes, not below them", async ({ page }) => {
      test.skip(!canOpenPage(CALLER, "/plan-routes"), `${ROLE} does not open Plan routes`);
      await page.goto("/plan-routes");
      await expect(
        page.getByRole("heading", { level: 1, name: planRoutes.heading }),
      ).toBeVisible();
      await expectDemoBarPinned(page);
      await expectVioletOnlyOnDemoChrome(page);

      // An <aside> is a complementary landmark, named by the "Map" heading inside it.
      const map = page.getByRole("complementary", { name: planRoutes.mapHeading });
      const column = page.locator("[data-lane]").first();
      await expect(map).toBeVisible();
      const mapBox = await boxOf(map);
      const laneBox = await boxOf(column);

      const beside = mapBox.x >= laneBox.x + laneBox.width - 1;
      const underTheHeader = mapBox.y + mapBox.height <= laneBox.y + 1;
      expect(
        beside || underTheHeader,
        `the map is under the lanes: ${JSON.stringify(mapBox)} vs the first lane ${JSON.stringify(laneBox)}`,
      ).toBe(true);
      // The strong form of the same thing: it is on screen without scrolling past a lane.
      await expect(map).toBeInViewport();
      // And it has room to be a map rather than a sliver.
      expect(mapBox.width).toBeGreaterThanOrEqual(280);

      await expectNoInternalCodes(page);
      console.log("screenshot:", await shot(page, `plan-routes-${width}`));
    });
  });
}
