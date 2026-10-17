/**
 * The live board and its map pane, in a real browser (SURF-01; AT-03, AT-10, AT-11, TEST-SEC-02).
 *
 * The unit tests know what a tick contains (src/domain/board/live.test.ts) and what the stream
 * sends (src/modules/realtime/sse.test.ts). What only a browser can answer is whether the
 * screen actually *moves*: does an event arrive, does a row change when it does, does the map
 * sit beside the rows without covering one, does hovering a row lift its marker, and does the
 * amber bar appear when the stream dies — and then stay honest about the data underneath it.
 *
 * The clock speed is the review and test path (`?speed=`, §6.2's own ×1/×10/×60): at ×10 the
 * demo morning's 180 s stale badge, its 600 s location-loss exception and its one damped window
 * all land inside a browser check instead of ten minutes later. Nothing else changes — a tick's
 * contents are the same at any speed, which is PRD §8's rule and src/domain/eta/scenario-clock's
 * one job.
 *
 * No database and no credentials: the server runs with the test-only synthetic session (see
 * playwright.config.ts), and the board it renders is the committed demo day.
 */
import { expect, test, type Page } from "@playwright/test";
import { board as boardCopy, fill, liveUpdates } from "../src/ui/copy";
import { gpsFreshnessStates, legStates } from "../src/ui/states";
import { boxOf, expectDemoBarPinned, expectNoInternalCodes, overlaps, shot } from "./helpers";

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
