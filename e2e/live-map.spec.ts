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
import type { StaffRole } from "../src/auth/core";
import { canSeeMapData } from "../src/domain/access/map-view";
import { demoBanner, fill, fleetMap, liveMap, sourceMode } from "../src/ui/copy";
import { FLEET } from "../src/fixtures/fleet";

/**
 * One run is one role (`E2E_DEMO_ROLE`, playwright.config.ts). Every staff role opens this
 * screen — the person at the door needs to see where the vans are — but they do not all see
 * the same screen: the notification decisions are the coordinator's and the director's, and the
 * injected-fault panel and the scenario clock are the director's alone. That matrix is
 * src/domain/access/map-view.ts, and it is what this file asks rather than assuming a director:
 * a panel this role's row does not carry is asserted *absent*, which is the half that matters
 * (the front desk must not be holding the notification queue).
 */
const ROLE = (process.env.E2E_DEMO_ROLE ?? "DIRECTOR") as StaffRole;
const SEES_DECISIONS = canSeeMapData(ROLE, "notificationDecisions");
const SEES_FAULTS = canSeeMapData(ROLE, "injectedFaults");
const HOLDS_CLOCK = canSeeMapData(ROLE, "clockControls");

const ARTIFACTS = path.resolve(__dirname, "..", "artifacts");
const SCREENSHOT = path.join(ARTIFACTS, "live-map.png");

test(`the live map renders the fleet map and saves a screenshot, as ${ROLE}`, async ({ page }) => {
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

  // §9: the map is never the only way to read the fleet. The list beside it is, and every
  // staff role gets it — the vans are what the screen is for.
  const vehicles = page.getByRole("list", { name: fleetMap.vehiclesHeading });
  await expect(vehicles).toBeVisible();
  expect(await vehicles.getByRole("listitem").count()).toBeGreaterThan(0);
  await expect(page.getByRole("button", { name: fleetMap.fitAll })).toBeVisible();

  /*
   * The two panels that are not every role's, each asserted the way round this role's row in
   * the matrix says: the notification queue (the coordinator and the director) and the demo's
   * injected faults (the director). "Absent" is the load-bearing half — the front desk at the
   * door has no business holding either, and a hidden panel is not an absent one.
   */
  const decisions = page.getByRole("heading", { name: liveMap.decisionsHeading });
  const faults = page.getByRole("heading", { name: liveMap.faultsHeading });
  await (SEES_DECISIONS ? expect(decisions).toBeVisible() : expect(decisions).toHaveCount(0));
  await (SEES_FAULTS ? expect(faults).toBeVisible() : expect(faults).toHaveCount(0));

  // Pause the scenario clock, so the screenshot is a still fleet rather than a blur. The clock's
  // controls are the director's, and they ride in the DEMO bar (src/ui/DemoClock.tsx).
  const pause = page.getByRole("button", { name: liveMap.pause, exact: true });
  if (HOLDS_CLOCK) await pause.click();
  else await expect(pause, `${ROLE} is being offered the scenario clock`).toHaveCount(0);
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
 *  2. **The board's own van names.** A coordinator reads "V1" on the Today board
 *     (`ride.vehicleLabel`) and has to find the same van here; the vehicle list is also the §9
 *     non-map way to read the fleet. The labels are taken from src/fixtures/fleet.ts, the
 *     board's own fixture, so a van renamed in one place and not the other fails here.
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
  const onScreen = await vehicles.getByRole("listitem").evaluateAll((items) =>
    items.map((li) => (li.textContent ?? "").split("·")[0].trim()),
  );
  const board = FLEET.map((v) => v.label);
  expect(onScreen.length, "no vans in the list beside the map").toBeGreaterThan(0);
  for (const label of onScreen) expect(board, `"${label}" is not a van the board knows`).toContain(label);
  // And each card reads "<van> · <what it is>", the same two parts the fixtures carry.
  for (const vehicle of FLEET.filter((v) => onScreen.includes(v.label))) {
    await expect(
      page.getByRole("button", {
        name: fill(fleetMap.vehicleRow, { id: vehicle.label, description: vehicle.description }),
        exact: false,
      }),
    ).toBeVisible();
  }
  // The vans the map drew are the vans the list offers: no marker without a row, §9.
  expect(drawn.split(",").filter(Boolean).sort()).toEqual([...onScreen].sort());
});
