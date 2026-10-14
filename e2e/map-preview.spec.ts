/**
 * /map-preview in a real browser.
 *
 * MapLibre needs a real canvas and a style fetch, so this is the one question the unit tests
 * in src/components/map/style.test.ts cannot answer: does the pane actually draw? The run
 * ends with a screenshot in artifacts/ so a design review has something to look at.
 *
 * No database and no credentials: the server is started with the test-only synthetic session
 * (see playwright.config.ts and src/domain/access/map-view.ts), which grants a role and
 * nothing else and is refused outright on any deployment.
 */
import { mkdirSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { demoBanner, fleetMap, mapPreview } from "../src/ui/copy";

const ARTIFACTS = path.resolve(__dirname, "..", "artifacts");
const SCREENSHOT = path.join(ARTIFACTS, "map-preview.png");

test("the map preview renders the fleet map and saves a screenshot", async ({ page }) => {
  const failures: string[] = [];
  page.on("pageerror", (e) => failures.push(e.message));

  await page.goto("/map-preview");

  // Past the sign-in guard: the page's own heading, not a redirect to /login.
  await expect(page).toHaveURL(/\/map-preview$/);
  await expect(page.getByRole("heading", { level: 1, name: mapPreview.heading })).toBeVisible();
  // NFR-09 / §7: the DEMO bar is on every route and says which world this is.
  await expect(page.getByRole("status", { name: demoBanner.ariaLabel })).toBeVisible();

  // The pane itself. `aria-label` is the §9 accessible name of the map region.
  const map = page.getByRole("region", { name: mapPreview.mapLabel });
  await expect(map).toBeVisible();

  // MapLibre only inserts its canvas once the style has been fetched and the map built, so a
  // visible canvas of real size is the proof that the map drew rather than failed.
  const canvas = map.locator("canvas.maplibregl-canvas");
  await expect(canvas).toBeVisible();
  const size = await canvas.boundingBox();
  expect(size?.width ?? 0).toBeGreaterThan(400);
  expect(size?.height ?? 0).toBeGreaterThan(200);


  // ADR-008 / §5.1: attribution is always visible and never removed.
  await expect(map.locator(".maplibregl-ctrl-attrib")).toBeAttached();

  // The tile notice is the failure path; neither it nor its longer form may be on screen.
  await expect(page.getByText(fleetMap.tilesFailed, { exact: false })).toHaveCount(0);

  // §9: the map is never the only way to read the fleet. The list beside it is, and the
  // DIRECTOR role this check signs in as sees the vehicles and the demo controls.
  const vehicles = page.getByRole("list", { name: fleetMap.vehiclesHeading });
  await expect(vehicles).toBeVisible();
  expect(await vehicles.getByRole("listitem").count()).toBeGreaterThan(0);
  await expect(page.getByRole("button", { name: fleetMap.fitAll })).toBeVisible();
  await expect(page.getByRole("heading", { name: mapPreview.decisionsHeading })).toBeVisible();
  await expect(page.getByRole("heading", { name: mapPreview.faultsHeading })).toBeVisible();

  // Pause the scenario clock, so the screenshot is a still fleet rather than a blur.
  await page.getByRole("button", { name: mapPreview.pause, exact: true }).click();
  // Then let the basemap finish: tiles, glyphs and sprites are all separate requests.
  await page.waitForLoadState("networkidle");

  /*
   * A canvas of the right size is not a map. When the tile worker fails to load, MapLibre keeps
   * the canvas and draws nothing into it — no basemap, no routes, no trucks — and the DOM looks
   * identical from the outside. So before the screenshot is taken, this reads what MapLibre
   * itself says is on screen: the pane publishes it on the map's own `idle` event, which is
   * also the event that means the tiles have stopped arriving (src/components/map/FleetMap.tsx).
   */
  await expect(map).toHaveAttribute("data-vehicles-drawn", "V1,V2,V3", { timeout: 60_000 });
  expect(
    Number(await map.getAttribute("data-basemap-features")),
    "no basemap features rendered: the tiles did not draw",
  ).toBeGreaterThan(200);

  mkdirSync(ARTIFACTS, { recursive: true });
  await page.screenshot({ path: SCREENSHOT, fullPage: false });

  expect(failures, `page errors: ${failures.join("; ")}`).toEqual([]);
});
