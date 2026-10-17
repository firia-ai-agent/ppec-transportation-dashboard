/**
 * The live map, in a real browser: the screen at /live-map, and the map pane on the live board
 * (SURF-01; AT-03, AT-10, AT-11, TEST-SEC-02).
 *
 * Two surfaces, one file, because they are one feature seen from two places and they share
 * every helper below. The screen at `/live-map` is the map on its own route — it was
 * `/map-preview` until Vera's review (2026-10-17) took "preview" out of every address, and the
 * old one is a 308 to this one (e2e/moved-addresses.spec.ts covers the redirect itself). The
 * pane on `/today` is the same fleet inside the board, which is where P-03 is taking it.
 *
 * MapLibre needs a real canvas and a style fetch, so the drawing checks are the one question
 * the unit tests in src/components/map/style.test.ts cannot answer: does the pane actually
 * draw? That run ends with a screenshot in artifacts/ so a design review has something to look
 * at. The board checks answer the other thing only a browser can: whether the screen actually
 * *moves* — does an event arrive, does a row change when it does, does the map sit beside the
 * rows without covering one, does hovering a row lift its marker, and does the amber bar appear
 * when the stream dies.
 *
 * The clock speed is the review and test path (`?speed=`, §6.2's own ×1/×10/×60): at ×10 the
 * demo morning's 180 s stale badge, its 600 s location-loss exception and its one damped window
 * all land inside a browser check instead of ten minutes later. Nothing else changes — a tick's
 * contents are the same at any speed, which is PRD §8's rule and src/domain/eta/scenario-clock's
 * one job.
 *
 * No database and no credentials: the server runs with the test-only synthetic session (see
 * playwright.config.ts and src/domain/access/map-view.ts), which grants a role and nothing else
 * and is refused outright on any deployment. The board it renders is the committed demo day.
 */
import { mkdirSync } from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import {
  board as boardCopy,
  demoBanner,
  fill,
  fleetMap,
  liveMap,
  liveUpdates,
  planRoutes,
  rampIpad,
  serviceDate,
  sourceMode,
} from "../src/ui/copy";
import { FLEET } from "../src/fixtures/fleet";
import { gpsFreshnessStates, legStates } from "../src/ui/states";
import {
  boxOf,
  expectDemoBarPinned,
  expectDemoControlStyling,
  expectNoInternalCodes,
  expectVioletOnlyOnDemoChrome,
  overlaps,
  shot,
} from "./helpers";

const ARTIFACTS = path.resolve(__dirname, "..", "artifacts");
const SCREENSHOT = path.join(ARTIFACTS, "live-map.png");

/** ×10: a scenario minute every six seconds. Fast enough to watch, slow enough to read. */
const TENX = "/today?speed=10";

/**
 * The §3 chip labels, as patterns — the age inside them is whatever the clock has reached.
 *
 * Every chip writes its label twice (src/ui/StateChip.tsx): once for the ear, prefixed "State:",
 * and once for the eye. Matching on `.first()` below takes the screen-reader copy, which is the
 * one §9 is about and the one that proves the chip is a chip rather than a bare word.
 */
const STALE = /Stale · .* · ETA texts paused/;
const NO_SIGNAL = /No signal · /;

/** A copy string, safe to drop into a pattern (the steps end in a full stop). */
const escapeForRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The map pane's own container, which publishes what it drew and what it ringed. */
const paneOf = (page: Page) => page.getByRole("region", { name: boardCopy.mapLabel });

/**
 * One ride row, by the van it is on and which half of the day it is.
 *
 * The morning on purpose: only the morning has a van on the road in the committed replay, so an
 * afternoon row of the same van is a plan — it carries a planned window and no position, which
 * is correct and is not what these checks are about.
 */
const rowsOfVan = (page: Page, van: string, ride: "AM" | "PM" = "AM") =>
  page.locator(`tr[data-van="${van}"][data-ride="${ride}"]`);

/** The "Arriving" cell: the child is a row header, so the six columns after it are the tds. */
const ARRIVING_CELL = 4;

/** The van the demo day sends duplicate, out-of-order and then no points at all (§18.2 step 8). */
const GAP_VAN = "V2";
/** The van the §18.2 step 7 stall belongs to, and whose downstream window moves. */
const STALL_VAN = "V1";
/** The van whose device is not linked to it (LOC-01): ingested, stored, drawn nowhere. */
const UNLINKED_VAN = "V4";

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

test.describe("the live board", () => {
  test("puts the map beside the rows, covering none of them, and folds away", async ({ page }) => {
    await page.goto("/today");
    await expect(page.getByRole("heading", { level: 1, name: boardCopy.heading })).toBeVisible();
    await expectDemoBarPinned(page);

    const pane = page.getByRole("region", { name: boardCopy.mapHeading });
    await expect(pane.getByRole("heading", { name: boardCopy.mapHeading })).toBeVisible();

    // §4.1: rows left, map right — the pane starts to the right of the table and overlaps no row.
    const table = await boxOf(page.locator("table"));
    const paneBox = await boxOf(pane);
    expect(paneBox.x, "the pane is to the right of the rows").toBeGreaterThan(table.x);
    expect(overlaps(table, paneBox), "the pane covers the rows").toBe(false);

    // §4.1 "collapsible": it folds, and the rows widen into the space it leaves.
    const hide = page.getByRole("button", { name: boardCopy.hideMap });
    await hide.click();
    await expect(page.getByRole("button", { name: boardCopy.showMap })).toBeVisible();
    await expect(paneOf(page)).toHaveCount(0);
    const widened = await boxOf(page.locator("table"));
    expect(widened.width).toBeGreaterThan(table.width);
    await page.getByRole("button", { name: boardCopy.showMap }).click();
    await expect(page.getByRole("button", { name: boardCopy.hideMap })).toBeVisible();

    await expectNoInternalCodes(page);
    console.log("screenshot:", await shot(page, "today-live-map"));
  });

  test("§4.1: pointing at a ride lifts its van, and opening one flies to it", async ({ page }) => {
    await page.goto("/today");
    const pane = paneOf(page);
    await expect(pane).toBeVisible();

    const row = rowsOfVan(page, GAP_VAN).first();
    await row.hover();
    // The ring is painted inside a WebGL canvas, so the pane publishes what it ringed.
    await expect(pane).toHaveAttribute("data-ringed-vehicle", GAP_VAN);

    // A different van under the pointer moves the ring with it.
    await rowsOfVan(page, STALL_VAN).first().hover();
    await expect(pane).toHaveAttribute("data-ringed-vehicle", STALL_VAN);

    // Hovering is not a camera move: nothing has been flown to yet.
    expect(await pane.getAttribute("data-camera-vehicle")).toBeNull();

    // Opening the ride is: the drawer opens and the camera goes to that van.
    await rowsOfVan(page, STALL_VAN).first().getByRole("button", { name: /^Open / }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(pane).toHaveAttribute("data-camera-vehicle", STALL_VAN);
  });

  test("the keyboard reaches the same link as the pointer (§9)", async ({ page }) => {
    await page.goto("/today");
    const pane = paneOf(page);
    await rowsOfVan(page, GAP_VAN).first().getByRole("button", { name: /^Open / }).focus();
    await expect(pane).toHaveAttribute("data-ringed-vehicle", GAP_VAN);
  });

  test("AT-03: one window moves, downstream, and the board says so once", async ({ page }) => {
    await page.goto(TENX);

    // Nothing has been told to anybody when the board opens.
    const pane = page.getByRole("region", { name: boardCopy.mapHeading });
    await expect(pane.getByText(boardCopy.updatesEmpty)).toBeVisible();

    const row = rowsOfVan(page, STALL_VAN).first();
    const windowCell = row.locator("td").nth(ARRIVING_CELL);
    const opening = (await windowCell.innerText()).trim();
    expect(opening).toMatch(/\d{1,2}:\d{2}–\d{1,2}:\d{2} [AP]M/);

    // The stall matures and the gate opens: one update, naming the place and the new window.
    const updates = pane.locator("li[data-update]");
    await expect(updates).toHaveCount(1, { timeout: 60_000 });
    const update = (await updates.first().innerText()).trim();
    expect(update).toContain(STALL_VAN);
    expect(update).toMatch(/\+\d+ min/);
    expect(update).toMatch(/new window \d{1,2}:\d{2}–\d{1,2}:\d{2} [AP]M/);

    // The row the family holds moved with it, and still shows a 10-minute window.
    await expect
      .poll(async () => (await windowCell.innerText()).trim(), { timeout: 60_000 })
      .not.toBe(opening);
    await expect(windowCell).toHaveText(/\d{1,2}:\d{2}–\d{1,2}:\d{2} [AP]M/);

    // Hysteresis: it is still one update a scenario minute later, not a stream of them.
    await page.waitForTimeout(6_000);
    await expect(updates).toHaveCount(1);
    // A family code is a key between engineers and never reaches a row.
    await expectNoInternalCodes(page);
    console.log("screenshot:", await shot(page, "today-live-window-moved"));
  });

  test("AT-11: the stale badge, the paused texts, then the exception and the step", async ({
    page,
  }) => {
    await page.goto(TENX);

    const rows = rowsOfVan(page, GAP_VAN);
    expect(await rows.count()).toBeGreaterThan(0);
    const row = rows.first();

    // 180 s: the badge is STALE and the row says the ETA texts are paused — with the window
    // the family holds still on it (§4.1: never hide data).
    await expect(row.getByText(STALE).first()).toBeVisible({ timeout: 60_000 });
    await expect(row.locator("td").nth(ARRIVING_CELL)).toHaveText(/ETA texts paused/);
    await expect(row.locator("td").nth(ARRIVING_CELL)).toHaveText(
      /\d{1,2}:\d{2}–\d{1,2}:\d{2} [AP]M/,
    );
    console.log("screenshot:", await shot(page, "today-live-stale"));

    /*
     * 600 s: no signal, the ride in Needs action, and the step that asks a person to find the
     * van — asserted as one state rather than as four assertions in a row, because it *is* one
     * state and it does not last: the committed run's positions come back a scenario minute
     * later (that recovery is itself the point of the fixture), so four sequential waits would
     * be four different instants and the last of them would land after the van is back.
     */
    /*
     * The child's label as the eye reads it. The row header holds two strings — the opener's
     * accessible name for the ear ("Open Noah O., morning ride") and the name itself for the
     * eye — so this takes the second one rather than the cell's whole text.
     */
    const child = (await row.locator('th span[aria-hidden="true"]').innerText()).trim();
    const lost = page
      .locator(`tr[data-van="${GAP_VAN}"][data-ride="AM"][data-group="NEEDS_ACTION"]`)
      .first();
    await expect
      .poll(async () => ((await lost.count()) > 0 ? await lost.innerText() : ""), {
        timeout: 60_000,
        intervals: [250],
      })
      .toMatch(
        new RegExp(
          `${NO_SIGNAL.source}[\\s\\S]*ETA texts paused[\\s\\S]*${escapeForRegExp(
            fill(boardCopy.nextSteps.FIND_VAN, { child }),
          )}`,
        ),
      );
    await expect(page.getByText(boardCopy.groups.NEEDS_ACTION).first()).toBeVisible();
    console.log("screenshot:", await shot(page, "today-live-location-lost"));

    // The points the seam refused are on screen as counts, so the rule is visible at all.
    const counts = page.locator(`li[data-van="${GAP_VAN}"]`);
    await expect(counts).toContainText(/positions used/);
    await expect(counts).toContainText(/duplicate/);
    await expect(counts).toContainText(/out of order/);

    // And the van whose device is not linked to it is named rather than drawn.
    await expect(page.locator(`li[data-silent-van="${UNLINKED_VAN}"]`)).toContainText(
      fill(boardCopy.mapSilent, { van: UNLINKED_VAN }),
    );
    const drawn = await paneOf(page).getAttribute("data-vehicles-drawn");
    if (drawn !== null && drawn.length > 0) expect(drawn.split(",")).not.toContain(UNLINKED_VAN);
  });

  test("AT-10: a van that arrives is never a child handed over, however long the clock runs", async ({
    page,
  }) => {
    await page.goto("/today?speed=60");
    // Let the whole committed morning play out: every arrival the geofence can see happens.
    await page.waitForTimeout(20_000);
    await expect(page.getByText(/handed off/i)).toHaveCount(0);
    await expect(page.getByText(legStates.COMPLETED_HANDOFF.label)).toHaveCount(0);
    // The arrival the map does report says what it is, in the §3 words.
    const arrived = page.getByText(/Arrived \(vehicle\)/);
    expect(await arrived.count()).toBeGreaterThan(0);
    console.log("screenshot:", await shot(page, "today-live-arrived-not-handoff"));
  });

  test("§2: the stream dying raises the amber bar and hides nothing", async ({ page }) => {
    // Refused from the first request, so nothing ever arrives: the board is the server's, and
    // the bar appears when the configured gap passes.
    await page.route("**/api/stream**", (route) => route.abort());
    await page.goto("/today");

    // The board is complete before any event: rows, windows and the map pane are all there.
    await expect(page.getByRole("button", { name: /^Open / }).first()).toBeVisible();
    await expect(page.getByRole("region", { name: boardCopy.mapHeading })).toBeVisible();

    const bar = page.getByRole("status", { name: liveUpdates.ariaLabel });
    await expect(bar).toHaveText(new RegExp(liveUpdates.downTitle), { timeout: 60_000 });
    await expect(bar).toContainText(liveUpdates.downBody);

    // Never hide data (§2): the rows are still readable underneath it.
    await expect(page.getByRole("button", { name: /^Open / }).first()).toBeVisible();
    await expect(page.getByText(/\d{1,2}:\d{2}–\d{1,2}:\d{2} [AP]M/).first()).toBeVisible();
    console.log("screenshot:", await shot(page, "today-live-updates-paused"));
  });

  test("ADR-002: a connection that fails is retried, and the board picks up where it was", async ({
    page,
  }) => {
    /*
     * The first subscription is refused outright; every later one is let through. That is the
     * reconnect the whole protocol is built around — the browser comes back on its own, with
     * the tick it last held in `Last-Event-ID` — proved at the one scale a browser check can
     * reach. The 290 s self-close takes the same path and is held by the route's own tests.
     */
    let attempts = 0;
    await page.route("**/api/stream**", (route) => {
      attempts += 1;
      return attempts === 1 ? route.abort() : route.continue();
    });

    await page.goto(TENX);
    // The board is there from the first paint, refused stream or not.
    await expect(page.getByRole("button", { name: /^Open / }).first()).toBeVisible();

    // The retry lands and the board starts moving: the header carries an age from the stream.
    const header = page.getByRole("region", { name: /Adapter freshness/ });
    await expect(header).toHaveText(/GPS · (Live|Last seen|Stale|No signal)/, { timeout: 60_000 });
    expect(attempts).toBeGreaterThan(1);
    // And the window the stall moves still arrives, so nothing was lost in the gap.
    await expect(
      page.getByRole("region", { name: boardCopy.mapHeading }).locator("li[data-update]"),
    ).toHaveCount(1, { timeout: 60_000 });
  });

  test("§2 / §10: the header's GPS pill carries a real age from the same stream", async ({
    page,
  }) => {
    await page.goto(TENX);
    const header = page.getByRole("region", { name: /Adapter freshness/ });
    // The §3 band vocabulary, not the interim word: this pill has an age now.
    await expect(header).toHaveText(/GPS · (Live|Last seen|Stale|No signal)/, { timeout: 60_000 });
    // The three adapters with no age still say so, which is the whole truth about them.
    for (const adapter of ["SMS", "Teams", "Agent"]) {
      await expect(header).toContainText(`${adapter} · Simulated`);
    }
    // The band walks with the van: the gap run takes the fleet's freshest age past 180 s only
    // if every van is stale, so this asserts the vocabulary rather than one band.
    expect(Object.values(gpsFreshnessStates).map((s) => s.label).join(" ")).toContain("Live");
  });

  test("TEST-SEC-02: zero *.googleapis.com, and no token in anything that leaves", async ({
    page,
  }) => {
    const seen: Array<{ method: string; url: string; body: string }> = [];
    page.on("request", (request) =>
      seen.push({
        method: request.method(),
        url: request.url(),
        body: request.postData() ?? "",
      }),
    );

    await page.goto(TENX);
    // Everything on the screen that could ask anything of the network: the stream, the map's
    // style and tiles, a hover, a selection, a fold and a re-open.
    await rowsOfVan(page, STALL_VAN).first().hover();
    await rowsOfVan(page, STALL_VAN).first().getByRole("button", { name: /^Open / }).click();
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: boardCopy.hideMap }).click();
    await page.getByRole("button", { name: boardCopy.showMap }).click();
    await page.waitForTimeout(5_000);

    // No routing provider and no geocoder: there is no *.googleapis.com request to make.
    expect(seen.filter((r) => /googleapis\.com/i.test(r.url)).map((r) => r.url)).toEqual([]);

    /*
     * One configured vendor host, and it is the basemap's (ADR-008). Everything else is this
     * origin: the board, the drawer and the pane are computed here, and the only routing data
     * in the build is the committed OSRM fixtures (ADR-007), so no coordinate is ever sent
     * anywhere to be routed.
     */
    const tileHost = new URL(
      process.env.NEXT_PUBLIC_MAP_TILE_URL ?? "https://tiles.openfreemap.org/styles/positron",
    ).host;
    const offSite = seen.filter((r) => !r.url.startsWith("http://127.0.0.1:"));
    for (const request of offSite) {
      expect(new URL(request.url).host, `${request.url} is not the configured map host`).toBe(
        tileHost,
      );
    }

    // Nothing posts: the live board is a subscription, not a conversation.
    expect(seen.filter((r) => r.body.length > 0).map((r) => `${r.method} ${r.url}`)).toEqual([]);

    // No token, child, place or vehicle is named in any request — including the stream's own
    // URL, which carries a clock speed and nothing else.
    const names = ["Noah O.", "Zoe B.", "Okeeheelee Park", "PPEC center", "C2", "F2", "V2", "DEV-"];
    for (const name of names) {
      const encoded = encodeURIComponent(name);
      const leaks = seen.filter(
        (r) => r.url.includes(name) || r.url.includes(encoded) || r.body.includes(name),
      );
      expect(leaks.map((r) => r.url), `${name} reached a request`).toEqual([]);
    }
    const streams = seen.filter((r) => r.url.includes("/api/stream"));
    expect(streams.length).toBeGreaterThan(0);
    for (const request of streams) {
      expect([...new URL(request.url).searchParams.keys()].sort()).toEqual(["speed"]);
    }

    console.log("screenshot:", await shot(page, "today-live-egress"));
  });
});

/**
 * Vera's bar for this screen, in the browser (2026-10-17).
 *
 * Four things, and each of them is about what the screen *says* rather than about what the data
 * is: the marker carries the van's name and its state in words, clicking a van opens the board's
 * own drawer with the van's stops in pickup order, a van with no fix stays where it was last
 * seen and says when that was, and there is one day on screen with the DEMO bar and the
 * Simulated chip above it and no control that would change it.
 *
 * Three of the four are *inside a WebGL canvas*, where the DOM can see nothing at all — so the
 * pane publishes what it drew (`data-vehicle-states`, `data-faded-vehicles`, read off the
 * rendered features on `idle`, see src/components/map/FleetMap.tsx) and these read that. The
 * words are then asserted twice over, on the canvas's own published state and on the van list
 * beside it, which is the same marker's DOM half.
 */
test.describe("Vera's bar: what a van's marker says", () => {
  /** The four states a marker can be in (src/ui/van-state.ts). */
  const STATES = ["ON_THE_WAY", "LATE", "STOPPED", "NO_FIX"];
  /** The words for them. "Stopped 3 min" and "Late 8 min" carry §5.1's clock. */
  const WORDS = String.raw`On the way|Late \d+ min|Stopped \d+ min|Last seen \d{1,2}:\d{2} [AP]M`;
  /**
   * What follows "State: " on the chip's own line — the screen-reader copy, which is the half
   * §9 is about and the proof that the state is a chip with an icon rather than a bare word
   * (src/ui/StateChip.tsx writes the label twice, once for the ear and once for the eye).
   */
  const WORDS_ANNOUNCED = new RegExp(`^(${WORDS})$`);

  /** The van's own button in the list beside the canvas: the marker, in the DOM. */
  const vanRow = (page: Page, van: string) => page.locator(`button[data-van="${van}"]`);

  /**
   * Everything a marker is saying, read in **one** pass over the DOM.
   *
   * The clock is running while these checks look, and a van walks through its states as the
   * morning goes: the §18.2 step 7 stall starts and ends, the step 8 gap opens and closes. Read
   * in two steps — the pane's published attribute, then the van's row — the clock can move
   * between them and the second step is about a different instant than the first. One
   * `evaluate` is one instant, and every assertion below is made against it.
   */
  const atOneInstant = (page: Page) =>
    page.evaluate(() => {
      const pane = document.querySelector<HTMLElement>("[data-vehicles-drawn]");
      const rows = [...document.querySelectorAll<HTMLElement>("button[data-van]")];
      return {
        drawn: (pane?.dataset.vehiclesDrawn ?? "").split(",").filter(Boolean),
        faded: (pane?.dataset.fadedVehicles ?? "").split(",").filter(Boolean),
        /** `V1=STOPPED,V2=ON_THE_WAY` — what the canvas says it drew, per van. */
        states: pane?.dataset.vehicleStates ?? "",
        /** The same vans' rows in the list beside it, as text. */
        words: Object.fromEntries(rows.map((row) => [row.dataset.van ?? "", row.innerText])) as
          Record<string, string>,
        /** And the state each of those rows was rendered for. */
        rowStates: Object.fromEntries(
          rows.map((row) => [row.dataset.van ?? "", row.dataset.vanState ?? ""]),
        ) as Record<string, string>,
      };
    });

  test("names the van and says its state, as an icon and a word", async ({ page }) => {
    await page.goto("/today");
    const pane = paneOf(page);
    await expect(pane).toHaveAttribute("data-vehicles-drawn", /V/, { timeout: 60_000 });

    const now = await atOneInstant(page);
    const states = Object.fromEntries(
      [...now.states.matchAll(/([^,=]+)=([A-Z_]+)/g)].map((m) => [m[1], m[2]]),
    );
    const vans = Object.keys(states);
    expect(vans.length).toBeGreaterThan(0);

    for (const van of vans) {
      // On the canvas: one of the four states, and never an empty marker.
      expect(STATES, `${van} is drawn in state ${states[van]}`).toContain(states[van]);

      /*
       * In the DOM: the van's name, and the same state as a chip — which is an icon plus a
       * label, announced "State: …" for the ear (src/ui/StateChip.tsx). That is the whole of
       * "as icon and word", on the half of the marker a screen reader can reach.
       */
      expect(now.rowStates[van], `${van}'s row and its marker disagree`).toBe(states[van]);
      expect(now.words[van]).toContain(van);
      const announced = /State: ([^\n]+)/.exec(now.words[van] ?? "")?.[1] ?? "";
      expect(announced, `${van}'s chip announces nothing a reader could use`).toMatch(
        WORDS_ANNOUNCED,
      );
      // …and the eye gets the same words, which is the other half of the chip.
      expect(now.words[van]).toContain(announced);
    }
    console.log("screenshot:", await shot(page, "today-live-marker-states"));
  });

  test("says lateness in words, so it is never the colour alone", async ({ page }) => {
    // ×10: the §18.2 step 7 stall matures, the gate moves the downstream window, and the van's
    // own rides fall behind the plan — which is when a marker starts saying how late it is. It
    // then catches up again, so the state is a window in the morning rather than an end state,
    // and it is asserted at one instant (see `atOneInstant`).
    await page.goto(TENX);
    await expect(paneOf(page)).toHaveAttribute("data-vehicles-drawn", /V/, { timeout: 60_000 });

    await expect
      .poll(
        async () => {
          const now = await atOneInstant(page);
          const late = [...now.states.matchAll(/([^,=]+)=LATE/g)].map((m) => m[1]);
          if (late.length === 0) return null;
          // The minutes are in the words on the marker's own row, not only in its tone.
          return late.every((van) => /Late \d+ min/.test(now.words[van] ?? "")) ? late : null;
        },
        { timeout: 90_000, intervals: [100] },
      )
      .not.toBeNull();
    console.log("screenshot:", await shot(page, "today-live-marker-late"));
  });

  test("opens the board's own drawer, with the van's stops in pickup order", async ({ page }) => {
    await page.goto("/today");
    const pane = paneOf(page);
    await expect(pane).toHaveAttribute("data-vehicles-drawn", /V/, { timeout: 60_000 });
    const van = (await paneOf(page).getAttribute("data-vehicles-drawn"))?.split(",")[0] as string;

    /*
     * Selecting the van the way the marker does: the canvas click and this button are the same
     * callback in the pane (`selectVehicle` in src/components/map/FleetMap.tsx), which is also
     * what §9 is about — the map is never the only way to reach anything.
     */
    await vanRow(page, van).click();

    // The board's own drawer, not a popup: the dialog opens, and the canvas has none.
    const drawerPanel = page.getByRole("dialog");
    await expect(drawerPanel).toBeVisible();
    await expect(page.locator(".maplibregl-popup")).toHaveCount(0);

    // The van's stops are in it, in the order the van calls at them.
    const stops = drawerPanel.locator(`ol[data-van="${van}"] li[data-stop]`);
    expect(await stops.count()).toBeGreaterThan(1);
    const names = await stops.allInnerTexts();
    expect(names.every((text) => text.trim().length > 0)).toBe(true);
    // The camera went to that van too, so the two halves of the screen agree.
    await expect(pane).toHaveAttribute("data-camera-vehicle", van);
    await expectNoInternalCodes(page);
    console.log("screenshot:", await shot(page, "today-live-van-drawer"));
  });

  test("leaves a van with no fix faded where it was last seen, and says when", async ({ page }) => {
    /*
     * ×10 rather than ×60, and everything read in **one** pass over the DOM.
     *
     * The gap is about a scenario minute wide — the van's positions stop arriving, its age walks
     * past 600 s, and then the committed run starts reporting again, which is itself part of the
     * fixture. Read in two steps (the pane's attribute, then the van's row) the clock can move
     * between them and the second step is about a van that has its signal back; at ×10 the
     * window is seconds wide and one `evaluate` is one instant.
     */
    await page.goto(TENX);
    await expect(paneOf(page)).toHaveAttribute("data-vehicles-drawn", /V/, { timeout: 60_000 });

    /** The pane's own account of what it drew, and the words beside it, at one instant. */
    const atOneInstant = () =>
      page.evaluate(() => {
        const pane = document.querySelector<HTMLElement>("[data-vehicles-drawn]");
        const rows = [...document.querySelectorAll<HTMLElement>("button[data-van]")];
        return {
          drawn: (pane?.dataset.vehiclesDrawn ?? "").split(",").filter(Boolean),
          faded: (pane?.dataset.fadedVehicles ?? "").split(",").filter(Boolean),
          states: pane?.dataset.vehicleStates ?? "",
          words: Object.fromEntries(
            rows.map((row) => [row.dataset.van ?? "", row.innerText]),
          ) as Record<string, string>,
        };
      });

    await expect
      .poll(
        async () => {
          const now = await atOneInstant();
          if (now.faded.length === 0) return null;
          const consistent = now.faded.every(
            (van) =>
              // Still on the map, at the last position anybody reported — a van nobody has
              // heard from is neither moved along its route nor taken off the map…
              now.drawn.includes(van) &&
              now.states.includes(`${van}=NO_FIX`) &&
              // …and its words are a clock time rather than an age.
              /Last seen \d{1,2}:\d{2} [AP]M/.test(now.words[van] ?? ""),
          );
          return consistent ? now.faded : null;
        },
        { timeout: 90_000, intervals: [100] },
      )
      .not.toBeNull();

    // The van whose device is not linked to it is a different case and stays off the map
    // altogether (LOC-01): there is no last known position for it to be faded at.
    const drawn = (await paneOf(page).getAttribute("data-vehicles-drawn")) ?? "";
    expect(drawn.split(",")).not.toContain(UNLINKED_VAN);
    console.log("screenshot:", await shot(page, "today-live-marker-no-fix"));
  });

  test("shows one day — the demo day — with the DEMO bar and the Simulated chip over it", async ({
    page,
  }) => {
    await page.goto("/today");
    await expect(paneOf(page)).toBeVisible();

    // §7 / §7.1 / NFR-09: the bar is pinned at the top and carries the Simulated chip…
    await expectDemoBarPinned(page);
    // …and the demo violet paints those two things and nothing else on this screen (D-5).
    await expectVioletOnlyOnDemoChrome(page);

    // One date, and it says which kind of day it is — asserted on the board's own date line
    // rather than anywhere on the page, because since #59 the header's demo-clock button reads
    // "Start demo day" (`scenarioClock.start`), and a bare text match for the phase would find
    // that control as happily as the label. The line is the one that carries the date.
    await expect(page.locator("time")).toHaveCount(1);
    const dateLine = page.locator("p").filter({ has: page.locator("time") });
    await expect(dateLine).toHaveCount(1);
    await expect(dateLine).toContainText(serviceDate.phases.LIVE);

    // The clock on screen is the scenario clock, reading the tick the board is being walked on.
    const clock = page.getByRole("banner").getByText(/^\d{1,2}:\d{2} [AP]M$/);
    await expect(clock.first()).toBeVisible({ timeout: 60_000 });

    // And nothing offers another day: no field, no picker, no option list, no link, no arrows.
    await expect(page.locator('input[type="date"]')).toHaveCount(0);
    await expect(page.locator("select")).toHaveCount(0);
    await expect(page.locator('a[href*="date="]')).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Previous day|Next day/ })).toHaveCount(0);

    // Nor is there any stock map chrome: no Leaflet, and no default blue pin anywhere.
    await expect(page.locator('[class*="leaflet"]')).toHaveCount(0);
    await expect(page.locator('img[src*="marker-icon"]')).toHaveCount(0);
    console.log("screenshot:", await shot(page, "today-live-one-day"));
  });
});

/**
 * The live map on a phone: the demo controls are a named group, and everything you can press is
 * a target (Vera's prod walk item 4, Veri S3; §9's ≥44 px console target).
 *
 * 390 px is the narrowest width this console is walked at, and it is where the screen's two
 * failures showed: the five clock buttons were loose in the row beside the clock readout with no
 * name on the group, and the two links out to the sibling screens were inline text — a 20 px
 * line, which is the one thing on the page a thumb cannot reliably hit. Measured rather than
 * eyeballed, because both are box sizes, and taken at this width because this is where the §9
 * floor actually binds: at 1440 the same buttons have a whole row to spread into.
 */
test.describe("at 390px, on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("names the demo controls and makes every control and link a 44 px target", async ({
    page,
  }) => {
    await page.goto("/live-map");
    await expect(page.getByRole("heading", { level: 1, name: liveMap.heading })).toBeVisible();

    /*
     * The group, by its accessible name: `aria-labelledby` points at the visible label, so one
     * locator proves both halves of the ruling — the group is named "Demo speed", and the words
     * a screen reader is given are the words on the screen (src/ui/DemoControls.tsx).
     */
    const group = page.getByRole("group", { name: liveMap.demoSpeedLegend });
    await expect(group).toBeVisible();
    await expect(page.getByText(liveMap.demoSpeedLegend, { exact: true })).toBeVisible();

    /*
     * And it is demo chrome, not the screen's own — measured, not read off the markup, because
     * what the ruling is about is what a reviewer sees: the bar's violet fill, the bar's ink,
     * and the chosen multiplier inverting that pair with a check mark beside it. It is the same
     * helper the plan screen's scenario toggle is held to (e2e/plan-routes.spec.ts).
     */
    const bar = page.locator('[data-demo-control="true"]');
    await expect(bar).toHaveCount(1);
    await expect(bar).toContainText(liveMap.demoSpeedLegend);
    await expectDemoControlStyling(bar);

    /*
     * All five controls, inside that one group: pause, the three §6.2 multipliers, restart. The
     * names come from copy.ts, so a renamed button fails here rather than silently dropping out
     * of the check.
     */
    const controls = [
      liveMap.pause,
      ...[1, 10, 60].map((factor) => fill(liveMap.speed, { factor })),
      liveMap.restart,
    ];
    for (const name of controls) {
      const control = group.getByRole("button", { name, exact: true });
      await expect(control, `${name} is not in the Demo speed group`).toBeVisible();
      const box = await boxOf(control);
      expect(box.width, `${name} is ${box.width}px wide`).toBeGreaterThanOrEqual(44);
      expect(box.height, `${name} is ${box.height}px tall`).toBeGreaterThanOrEqual(44);
    }
    // Nothing is left outside it: the five are the whole set of clock controls on the page.
    await expect(group.getByRole("button")).toHaveCount(controls.length);

    /*
     * The page's own two links — the only way to reach the ramp iPad and the planning screen
     * from here, and a 20 px line of text until this item. The DIRECTOR role this run signs in
     * as opens both (src/auth/access.ts), so both are on screen to be measured.
     */
    for (const screen of [rampIpad.heading, planRoutes.heading]) {
      const link = page.getByRole("link", {
        name: fill(liveMap.openScreen, { page: screen }),
        exact: true,
      });
      await expect(link).toBeVisible();
      const box = await boxOf(link);
      expect(box.width, `the ${screen} link is ${box.width}px wide`).toBeGreaterThanOrEqual(44);
      expect(box.height, `the ${screen} link is ${box.height}px tall`).toBeGreaterThanOrEqual(44);
    }

    // The violet is still spent on the bar, the chip and this control, measured at this width.
    await expectVioletOnlyOnDemoChrome(page);
    console.log("screenshot:", await shot(page, "live-map-390"));
  });
});
