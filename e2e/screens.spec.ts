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
import { mkdirSync } from "node:fs";
import path from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { demoBanner, fleetMap, mapPreview, nav, rampPreview } from "../src/ui/copy";
import { navItems } from "../src/ui/nav-items";

const ARTIFACTS = path.resolve(__dirname, "..", "artifacts");

/** The review's two widths: the icon rail lives at 1024, the labelled rail at 1280. */
const WIDTHS = [1024, 1280] as const;

const VIEWPORT = { height: 900 };

/** `[x1, y1, x2, y2]` of a laid-out element, or null when it is not in the layout at all. */
type Box = { x: number; y: number; width: number; height: number };

async function boxOf(locator: Locator): Promise<Box> {
  const box = await locator.boundingBox();
  expect(box, `${locator} has no box`).not.toBeNull();
  return box as Box;
}

/** Do two boxes share any pixel? The question every "is it covered?" check reduces to. */
function overlaps(a: Box, b: Box): boolean {
  return (
    a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
  );
}

function contains(outer: Box, inner: Box): boolean {
  return (
    inner.x >= outer.x - 1 &&
    inner.y >= outer.y - 1 &&
    inner.x + inner.width <= outer.x + outer.width + 1 &&
    inner.y + inner.height <= outer.y + outer.height + 1
  );
}

async function shot(page: Page, name: string): Promise<string> {
  mkdirSync(ARTIFACTS, { recursive: true });
  const file = path.join(ARTIFACTS, `${name}.png`);
  await page.screenshot({ path: file, fullPage: false });
  return file;
}

/**
 * The same internal codes src/ui/no-codes.test.ts bars in the source, run over the text the
 * browser actually rendered. This is the net that needs no judgement about which string
 * literal is copy and which is an identifier.
 */
const CODE_PATTERNS = [
  /\b(?:SURF|ADR|LOC|AT|NFR|FQ|ASM|EV)-\d+/g,
  /\b(?:PRD|COPY-GUIDE|DESIGN-DIRECTION|MOCKS)\b\s*(?:§|l\.)?/g,
  /\broute\d+(?:-[a-z]+)*\b/g,
];

async function expectNoInternalCodes(page: Page): Promise<void> {
  const text = await page.locator("body").innerText();
  const found = CODE_PATTERNS.flatMap((re) => [...text.matchAll(re)].map((m) => m[0].trim()));
  expect(found, `internal codes on ${page.url()}`).toEqual([]);
}

/** Every page: the one DEMO bar, and it is on screen at the bottom of the page too (NFR-09). */
async function expectDemoBarPinned(page: Page): Promise<void> {
  const bar = page.getByRole("status", { name: demoBanner.ariaLabel });
  await expect(bar).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(300);
  await expect(bar).toBeInViewport();
  const box = await boxOf(bar);
  expect(box.y, "the DEMO bar is still at the top of the window after a scroll").toBeLessThan(40);
  await page.evaluate(() => window.scrollTo(0, 0));
}

for (const width of WIDTHS) {
  test.describe(`at ${width}px`, () => {
    test.use({ viewport: { width, ...VIEWPORT } });

    test("the board carries the DEMO bar and a rail that is not clipped", async ({ page }) => {
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
      for (const item of navItems) {
        const link = rail.getByRole("link", { name: item.label });
        await expect(link).toHaveAttribute("title", item.label);
        const icon = link.locator("svg");
        const iconBox = await boxOf(icon);
        expect(
          contains(railBox, iconBox),
          `${item.label}'s icon is clipped by the rail: ${JSON.stringify(iconBox)} vs ${JSON.stringify(railBox)}`,
        ).toBe(true);
      }

      await expectNoInternalCodes(page);
      console.log("screenshot:", await shot(page, `today-${width}`));
    });

    test("the map preview draws tiles and V1-V3, and keeps its chrome in the pane", async ({
      page,
    }) => {
      await page.goto("/map-preview");
      await expect(page.getByRole("heading", { level: 1, name: mapPreview.heading })).toBeVisible();
      await expectDemoBarPinned(page);

      const map = page.getByRole("region", { name: mapPreview.mapLabel });
      await expect(map).toBeVisible();

      // Pause the clock first, so the map can reach idle and the screenshot is a still fleet.
      await page.getByRole("button", { name: mapPreview.pause, exact: true }).click();

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
      const chosenSpeed = page.getByRole("button", { name: /^×10$/ });
      await expect(chosenSpeed).toHaveAttribute("aria-pressed", "true");

      // The ramp check is one click away rather than URL-only.
      await expect(page.getByRole("link", { name: mapPreview.openRampCheck })).toBeVisible();

      await expectNoInternalCodes(page);
      // Let the last tiles settle, then take the picture.
      await page.waitForLoadState("networkidle");
      console.log("screenshot:", await shot(page, `map-preview-${width}`));
    });

    test("the ramp check renders, and its sticky banner covers no row", async ({ page }) => {
      await page.goto("/ramp-preview");
      await expect(page.getByRole("heading", { level: 1, name: rampPreview.heading })).toBeVisible();
      await expectDemoBarPinned(page);
      console.log("screenshot:", await shot(page, `ramp-preview-${width}`));

      // §9 / COPY-GUIDE: the selected answer is filled and announced, not outlined.
      const notSure = page.getByRole("button", { name: rampPreview.answer.UNSURE }).first();
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
        [rampPreview.liftRow, page.getByText(rampPreview.liftRow, { exact: true })],
        ["Walking seat 2", page.getByText("Walking seat 2", { exact: true }).first()],
        [rampPreview.ridersHeading, page.getByRole("heading", { name: rampPreview.ridersHeading })],
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
      console.log("screenshot:", await shot(page, `ramp-preview-${width}-bottom`));
    });
  });
}
