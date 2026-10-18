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
import { canSeeMapData } from "../src/domain/access/map-view";
import { fill, fleetMap, liveMap, nav, planBoard, rampIpad } from "../src/ui/copy";
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
/** The demo's own panels on the live map: one role sees them (the fault list and the clock). */
const SEES_DEMO_INTERNALS =
  canSeeMapData(ROLE, "injectedFaults") && canSeeMapData(ROLE, "clockControls");

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

    test("the live map draws tiles and V1-V3, and keeps its chrome in the pane", async ({
      page,
    }) => {
      await page.goto("/live-map");
      await expect(page.getByRole("heading", { level: 1, name: liveMap.heading })).toBeVisible();
      await expectDemoBarPinned(page);

      const map = page.getByRole("region", { name: liveMap.mapLabel });
      await expect(map).toBeVisible();

      /*
       * Pause the clock first, so the map can reach idle and the screenshot is a still fleet.
       * The clock's controls are the director's (`clockControls`, src/domain/access/map-view.ts)
       * and they ride in the DEMO bar, so for the other roles there is nothing to press — and
       * what is asserted instead is that there is nothing to press: the map still has to draw.
       */
      const pause = page.getByRole("button", { name: liveMap.pause, exact: true });
      if (SEES_DEMO_INTERNALS) await pause.click();
      else await expect(pause, `${ROLE} is being offered the scenario clock`).toHaveCount(0);

      /*
       * The blank-map check. A pane that drew nothing looks exactly like a pane that drew a
       * whole city from the DOM's side, so this reads what MapLibre says it has on screen: the
       * basemap feature count and the vehicle ids it has markers for, both published by
       * FleetMap on the map's own `idle` event (src/components/map/FleetMap.tsx).
       */
      await expect(map).toHaveAttribute("data-vehicles-drawn", "V1,V2,V3", { timeout: 60_000 });
      const basemapFeatures = Number(await map.getAttribute("data-basemap-features"));
      expect(basemapFeatures, "no basemap features rendered: the tiles did not draw").toBeGreaterThan(
        200,
      );

      // The canvas is real and the size of the pane, not a 0 px stub.
      const canvas = map.locator("canvas.maplibregl-canvas");
      const canvasBox = await boxOf(canvas);
      expect(canvasBox.width).toBeGreaterThan(400);
      expect(canvasBox.height).toBeGreaterThan(400);

      // The failure path is not on screen: the style loaded and the worker answered.
      await expect(page.getByText(fleetMap.tilesFailed, { exact: false })).toHaveCount(0);

      // §9: ≥44 px console targets, including the controls MapLibre ships.
      const zoomButtons = map.locator(".maplibregl-ctrl-group button");
      await expect(zoomButtons).toHaveCount(2);
      for (const button of await zoomButtons.all()) {
        const box = await boxOf(button);
        expect(box.width).toBeGreaterThanOrEqual(44);
        expect(box.height).toBeGreaterThanOrEqual(44);
      }

      // ADR-008 / §5.1: attribution visible, inside the pane, at both widths.
      const attribution = map.locator(".maplibregl-ctrl-attrib");
      await expect(attribution).toBeVisible();
      const attributionBox = await boxOf(attribution);
      expect(
        contains(canvasBox, attributionBox),
        `attribution is outside the map pane: ${JSON.stringify(attributionBox)} vs ${JSON.stringify(canvasBox)}`,
      ).toBe(true);

      /*
       * Nothing the pane floats over the map may reach the vehicle list beside it. The list is
       * the §9 non-map way to read the fleet, so a control sitting on the V1 card takes away
       * the alternative as well as the card.
       */
      const v1Card = page.getByRole("button", { name: /^V1 · / });
      const v1Box = await boxOf(v1Card);
      const chrome: Array<[string, Locator]> = [
        ["Fit all vehicles", page.getByRole("button", { name: fleetMap.fitAll })],
        ["the zoom controls", map.locator(".maplibregl-ctrl-group")],
        ["the attribution", attribution],
      ];
      for (const [name, locator] of chrome) {
        const box = await boxOf(locator);
        expect(overlaps(box, v1Box), `${name} overlaps the V1 card`).toBe(false);
      }

      // §6.2: the running speed is filled and says so, rather than wearing a focus-ring outline.
      // One role holds the clock, so one role has a speed to read (see the pause above).
      const chosenSpeed = page.getByRole("button", { name: /^×10$/ });
      if (SEES_DEMO_INTERNALS) await expect(chosenSpeed).toHaveAttribute("aria-pressed", "true");
      else await expect(chosenSpeed).toHaveCount(0);

      // The ramp iPad is one click away rather than URL-only, and the link calls it what its
      // own heading and the rail call it.
      await expect(
        page.getByRole("link", { name: fill(liveMap.openScreen, { page: rampIpad.heading }) }),
      ).toBeVisible();

      await expectNoInternalCodes(page);
      // Let the last tiles settle, then take the picture.
      await page.waitForLoadState("networkidle");
      console.log("screenshot:", await shot(page, `live-map-${width}`));
    });

    /**
     * The ramp iPad at both review widths: the van arrival (redesign spec §2), which replaced the
     * §4.4 checklist — the layout picker, the per-place Free / Out / Not sure answers, the LATCH
     * row and the slot matrix are gone, so what this test reads is the card a front desk actually
     * taps: four steppers, a lift switch and one Confirm, each at the ramp's own 56 px target.
     */
    test("the ramp iPad renders its steppers at a ramp-sized target", async ({ page }) => {
      await page.goto("/ramp-ipad");
      await expect(page.getByRole("heading", { level: 1, name: rampIpad.heading })).toBeVisible();
      await expectDemoBarPinned(page);
      await expectVioletOnlyOnDemoChrome(page);
      console.log("screenshot:", await shot(page, `ramp-ipad-${width}`));

      // Every counter is one of the four the whole app counts in (src/config/equipment.ts).
      await expect(page.locator("[data-stepper]")).toHaveCount(5);
      for (const button of await page.locator("[data-stepper] button").all()) {
        const box = await boxOf(button);
        expect(box.height, "a ramp control is at least 56 px").toBeGreaterThanOrEqual(56);
      }
      // The provider's shorthand for a layout is not on this screen at all any more.
      await expect(page.getByText(/\d+WC\/\d+A/)).toHaveCount(0);

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
        page.getByRole("heading", { level: 1, name: planBoard.heading }),
      ).toBeVisible();
      await expectDemoBarPinned(page);
      await expectVioletOnlyOnDemoChrome(page);

      // An <aside> is a complementary landmark, named by the board's own two words for it.
      const map = page.getByRole("complementary", { name: planBoard.mapLabel });
      const column = page.locator("[data-van]").first();
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
