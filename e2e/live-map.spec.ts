/**
 * /live-map in a real browser.
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
import { demoBanner, fleetMap, liveMap, sourceMode, vanTitle } from "../src/ui/copy";
import { FLEET } from "../src/fixtures/fleet";

const ARTIFACTS = path.resolve(__dirname, "..", "artifacts");
const SCREENSHOT = path.join(ARTIFACTS, "live-map.png");

test("the live map renders the fleet map and saves a screenshot", async ({ page }) => {
  const failures: string[] = [];
  page.on("pageerror", (e) => failures.push(e.message));

  await page.goto("/live-map");

  // Past the sign-in guard: the page's own heading, not a redirect to /login.
  await expect(page).toHaveURL(/\/live-map$/);
  await expect(page.getByRole("heading", { level: 1, name: liveMap.heading })).toBeVisible();
  // NFR-09 / §7: the DEMO bar is on every route and says which world this is.
  await expect(page.getByRole("status", { name: demoBanner.ariaLabel })).toBeVisible();

  // The pane itself. `aria-label` is the §9 accessible name of the map region.
  const map = page.getByRole("region", { name: liveMap.mapLabel });
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
  await expect(page.getByRole("heading", { name: liveMap.decisionsHeading })).toBeVisible();
  await expect(page.getByRole("heading", { name: liveMap.faultsHeading })).toBeVisible();

  // Pause the scenario clock, so the screenshot is a still fleet rather than a blur.
  await page.getByRole("button", { name: liveMap.pause, exact: true }).click();
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

/**
 * The two things the screen's *name* rests on, measured on the screen.
 *
 * It is called "Live map" now rather than "Map preview" (Vera's review, 2026-10-17: no
 * "preview" in any menu label or address). That name is only honest if the two things that say
 * where the data comes from are actually there, so this asserts both rather than trusting the
 * copy test:
 *
 *  1. **One Simulated chip, and it comes from the root layout.** §7.1 / NFR-09 puts the
 *     source-mode chip in the DEMO bar's trailing cell on every screen, and the root layout
 *     mounts it (src/ui/ScreenSource.tsx). A second chip inside the page would be the screen
 *     arguing with itself about its own provenance — so the chip is inside the bar, and `main`
 *     holds none.
 *  2. **The board's own van names.** A coordinator reads "The convertible van" on the Today
 *     board and has to find the same van here; the vehicle list is also the §9 non-map way to
 *     read the fleet. The names are built from src/fixtures/fleet.ts, the board's own fixture,
 *     through the one helper every screen names a van with (`vanTitle`), so a van renamed in one
 *     place and not the other fails here — and so does a card that goes back to printing the
 *     fixture key, which is what "V1 · Convertible van" was (Vera's prod walk, 2026-10-17).
 */
test("the live map carries the root layout's Simulated chip and the board's van names", async ({
  page,
}) => {
  await page.goto("/live-map");
  await expect(page.getByRole("heading", { level: 1, name: liveMap.heading })).toBeVisible();

  // 1. The one chip, in the bar the root layout renders, and none inside the page.
  const bar = page.getByRole("status", { name: demoBanner.ariaLabel });
  await expect(bar).toBeVisible();
  const chips = page.locator('[data-token="src-sim"]');
  await expect(chips).toHaveCount(1);
  await expect(chips).toContainText(sourceMode.SIMULATED);
  // The bar's own element holds the status role; the chip rides in the row around it.
  const chipInChrome = await chips.evaluate(
    (el) => el.closest("main") === null && document.querySelector("main") !== null,
  );
  expect(chipInChrome, "the Simulated chip is mounted by the page, not by the root layout").toBe(true);

  // 2. The vehicle list names the vans the board names, and names nothing else.
  const vehicles = page.getByRole("list", { name: fleetMap.vehiclesHeading });
  await expect(vehicles).toBeVisible();
  const map = page.getByRole("region", { name: liveMap.mapLabel });
  // The pane publishes what MapLibre has markers for on the map's own `idle` event, so wait for
  // it to be published rather than reading an empty attribute off a map that is still drawing.
  await expect(map).toHaveAttribute("data-vehicles-drawn", /V\d/, { timeout: 60_000 });
  const drawn = (await map.getAttribute("data-vehicles-drawn")) ?? "";
  // A card's title is its first span, and it is the van's own name — the same string the
  // marker's `text-field` carries, built by the same helper (src/components/map/style.ts).
  const onScreen = await vehicles.getByRole("listitem").evaluateAll((items) =>
    items.map((li) => li.querySelector("button > span")?.textContent?.trim() ?? ""),
  );
  const named = new Map(FLEET.map((v) => [v.label, vanTitle(v.description)]));
  expect(onScreen.length, "no vans in the list beside the map").toBeGreaterThan(0);
  for (const name of onScreen) {
    expect([...named.values()], `"${name}" is not a van the board knows`).toContain(name);
    // And no card is back to naming a van by the key that joins it to a run in the fixtures.
    expect(name, `"${name}" prints a fixture key`).not.toMatch(/\bV\d\b/);
  }
  // The vans the map drew are the vans the list offers: no marker without a row, §9. The
  // attribute carries ids, because that is the map's handle on a van rather than its name.
  expect(
    drawn.split(",").filter(Boolean).map((id) => named.get(id) ?? id).sort(),
  ).toEqual([...onScreen].sort());
});
