/**
 * THE LIVE MAP IN A REAL BROWSER — every element a founder can see or click, at 390 and 1440.
 *
 * Rewritten wholesale against the founder's mockup. What was here before drove #53's debug
 * screen — the "Fit all" button, the vehicle list with its GPS freshness pills and ETA windows,
 * the "Notification decisions" and "Injected faults" headings, the per-screen Pause button, and
 * van buttons named `/^V1 · /` — and every one of those is deleted from the build, so every one
 * of those assertions is deleted here (MOCKUP-TEST-CONTRACT.md "Specs to delete, not adapt",
 * and its current-specs table row 4: on-screen names are "Van 1 · Marcus L.", never `/\bV\d\b/`).
 *
 * LAYER 1 (looks and clicks) — the mockup decides. Every assertion below cites one of:
 *   /workspace/ppec-redesign/mockups/live-map.html
 *   /workspace/ppec-redesign/png/live-map.png        (1440)
 *   /workspace/ppec-redesign/png/live-map-390.png    (390)
 * If the build differs from the mockup the code is wrong, not the spec.
 *
 * LAYER 2 (behaviour) — the rule decides, and is named where it is used: Firia's goal-5 brief
 * (one chip per van, no ETAs, the Simulated chip, van colours from tokens) and Firia's 3:08 PM
 * ET ruling (front desk = Live map + Ramp iPad, landing on the map). The derivations themselves
 * are proved without a browser in src/modules/live-map/*.test.ts; what is proved here is that
 * they reach the DOM.
 *
 * THE CLOCK IS PINNED. Each chip is a moment of the simulated day, so `?at=<scenario second>`
 * fixes the instant instead of waiting for one to come round — the same test path the board has
 * for its own clock, through the same gate (`dateOverrideAllowed`: SYNTHETIC + DEMO_MODE +
 * an explicit E2E_DATE_OVERRIDE, and refused outright whenever VERCEL_ENV is set). The seconds
 * below are the ones src/modules/live-map/day.ts actually produces, and the unit test walks the
 * whole day to prove all four states exist at all.
 *
 * The server has no database (playwright.config.ts: "The run touches no database"), so the §9.1
 * gate reads the plan the board kept in this process — which is why every test that wants vans
 * saves one first (`savePlan`). That is not a fixture: it is the coordinator's own Save.
 */
import { mkdirSync } from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { demoBanner, demoDay, fill, liveMap, planRoutes, sourceMode } from "../src/ui/copy";
import { VAN_COLORS, isBlue } from "../src/ui/tokens";

const ARTIFACTS = path.resolve(__dirname, "..", "artifacts", "rework-livemap");

const PHONE = { width: 390, height: 844 };
const DESK = { width: 1440, height: 900 };

/**
 * Scenario seconds, chosen because of what the simulated day does at them (the states are
 * computed in src/modules/live-map/day.ts and walked in van-state.test.ts):
 *  - ALL_AT_STOP: every van is standing in a stop's geofence — the start of the runs.
 *  - ALL_ON_ROUTE: every van is moving, fresh fixes, on schedule.
 *  - MOCKUP: 1 on route · 1 late · 1 no GPS — the exact summary line png/live-map.png shows.
 */
const AT = { ALL_AT_STOP: 0, ALL_ON_ROUTE: 30, MOCKUP: 3600 } as const;

/** The map pane has drawn when MapLibre says what is on screen (src/modules/live-map/LiveMapPane.tsx). */
async function mapDrawn(page: Page) {
  const pane = page.getByRole("region", { name: liveMap.mapLabel });
  await expect(pane).toHaveAttribute("data-vans-drawn", /\d/, { timeout: 60_000 });
  return pane;
}

/**
 * Save a plan the way a coordinator does, so the §9.1 gate opens.
 *
 * Auto-plan then Save on the board — two real clicks on the real screen, not a seeded row. The
 * check that the gate is CLOSED before this happens is its own test below.
 */
async function savePlan(page: Page, leg: "AM" | "PM" = "AM") {
  await page.goto("/plan-routes");
  if (leg === "PM") {
    await page.getByRole("button", { name: planRoutes.directionButton.PM, exact: true }).click();
  }
  await page.getByRole("button", { name: planRoutes.heading, exact: true }).first().click();
  const save = page.locator('[data-save="true"]');
  await expect(save).toBeEnabled();
  // Wait for the save itself to land, not for a button's styling: the gate opens on the row the
  // endpoint wrote, and a click that has not reached the server yet has opened nothing.
  const [response] = await Promise.all([
    page.waitForResponse((r) => r.url().includes("/api/plan/save") && r.request().method() === "POST"),
    save.click(),
  ]);
  expect(response.status(), "the board could not save a plan").toBe(200);
}

/** The live map at one instant of the simulated day, with the plan already saved. */
async function openMap(page: Page, at: number = AT.MOCKUP) {
  await page.goto(`/live-map?leg=am&at=${at}`);
  await expect(page.getByRole("heading", { level: 1, name: liveMap.heading })).toBeVisible();
}

/* ══════════════════════════ 1440 — png/live-map.png ══════════════════════════ */

test.describe("the Live map at 1440", () => {
  test.use({ viewport: DESK });

  test("draws every element the founder can see, in the mockup's own words", async ({ page }) => {
    const failures: string[] = [];
    page.on("pageerror", (e) => failures.push(e.message));

    await savePlan(page);
    await openMap(page);

    // png/live-map.png: the DEMO bar is pinned across the top and says which world this is.
    await expect(page.getByRole("status", { name: demoBanner.ariaLabel })).toBeVisible();

    // live-map.html `.top`: the title, then the leg switch, then the three state counts.
    await expect(page.getByRole("heading", { level: 1, name: liveMap.heading })).toBeVisible();
    const legs = page.getByRole("group", { name: liveMap.legLabel });
    await expect(legs.getByRole("link", { name: planRoutes.directionButton.AM })).toBeVisible();
    await expect(legs.getByRole("link", { name: planRoutes.directionButton.PM })).toBeVisible();
    // The leg in the address is the one marked, and it is marked by more than colour (§9).
    await expect(legs.getByRole("link", { name: planRoutes.directionButton.AM })).toHaveAttribute(
      "aria-current",
      "page",
    );

    /*
     * png/live-map.png, top right: "1 on route · 1 late · 1 no GPS". The clock is pinned to the
     * second the simulated day is in exactly that state, so these are the mockup's own numbers
     * rather than whatever the run happened to be doing.
     */
    await expect(page.getByText(fill(liveMap.countOnRoute, { count: 1 }))).toBeVisible();
    await expect(page.getByText(fill(liveMap.countLate, { count: 1 }))).toBeVisible();
    await expect(page.getByText(fill(liveMap.countNoGps, { count: 1 }))).toBeVisible();

    // live-map.html `.sh`: the three filters above the list — All 3 / Late / No GPS.
    const filters = page.getByRole("group", { name: liveMap.filterLabel });
    await expect(filters.getByRole("button", { name: fill(liveMap.filterAll, { count: 3 }) })).toBeVisible();
    await expect(filters.getByRole("button", { name: liveMap.filterLate })).toBeVisible();
    await expect(filters.getByRole("button", { name: liveMap.filterNoGps })).toBeVisible();
    // "All" is the one the screen opens on (`.chip info` in the mockup, the others `.chip neu`).
    await expect(filters.getByRole("button", { name: fill(liveMap.filterAll, { count: 3 }) })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    /*
     * live-map.html `.side`: one row per van, each with its name, its driver, where it is going
     * next, how many kids are aboard, a progress bar and ONE state chip. The mockup writes the
     * name "Van 2 · Dee R." — a number and a person, never a V-code (contract row 4).
     */
    const vans = page.getByRole("list", { name: liveMap.vansHeading });
    await expect(vans).toBeVisible();
    const rows = vans.getByRole("button");
    await expect(rows).toHaveCount(3);
    for (const [i, row] of (await rows.all()).entries()) {
      const name = await row.getAttribute("aria-label");
      expect(name, `van ${i} has no accessible name`).toMatch(/^Van \d · \S/);
      expect(name).not.toMatch(/\bV\d\b/);
      /*
       * The stop line (live-map.html `.nx`): a place and a count of kids while there is
       * somewhere left to go — "Lantana Public Library · 2 kids" — and "All stops done" once
       * there is not. Never a time, in either form.
       */
      const line = (await row.innerText()).split("\n").find((l) => /kids?$|All stops done/.test(l));
      expect(line, `van ${i} has no stop line`).toBeTruthy();
      expect(line).toMatch(/(·\s+\d+ kids?$)|(^All stops done$)/);
      expect(line).not.toMatch(/\d{1,2}:\d{2}/);
      // Exactly one chip on the row, and it is one of the mockup's four.
      const chips = row.locator('[data-pill="true"]');
      await expect(chips).toHaveCount(1);
      expect(Object.values(liveMap.chips)).toContain((await chips.innerText()).trim());
      // The progress bar is named rather than silent (§9: never a graphic alone).
      await expect(row.getByRole("img", { name: /^Stop \d+ of \d+$/ })).toBeVisible();
    }

    // png/live-map.png bottom left of the list: the Auto texts feed, with 12-hour times.
    const feed = page.getByRole("region", { name: liveMap.feedHeading });
    await expect(feed.getByRole("heading", { name: liveMap.feedHeading })).toBeVisible();
    await expect(feed.getByText(/\d{1,2}:\d{2} (AM|PM)/).first()).toBeVisible();

    // live-map.html `.mapw` and `.legend`: the map, and the four marker meanings under it.
    await mapDrawn(page);
    const legend = page.getByRole("group", { name: liveMap.legendHeading });
    for (const chip of Object.values(liveMap.chips)) {
      await expect(legend.getByText(chip, { exact: true })).toBeVisible();
    }

    // live-map.html `.zoom`: the zoom control, bottom right of the map.
    await expect(page.locator(".maplibregl-ctrl-zoom-in")).toBeVisible();
    await expect(page.locator(".maplibregl-ctrl-zoom-out")).toBeVisible();

    // The global check (contract §Rules 6): nothing sticks out sideways at this width.
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      DESK.width,
    );

    mkdirSync(ARTIFACTS, { recursive: true });
    await page.screenshot({ path: path.join(ARTIFACTS, "live-map-1440.png") });
    expect(failures, `page errors: ${failures.join("; ")}`).toEqual([]);
  });

  test("filters the list to Late and to No GPS, and back to all three", async ({ page }) => {
    await savePlan(page);
    await openMap(page);
    const vans = page.getByRole("list", { name: liveMap.vansHeading });
    const filters = page.getByRole("group", { name: liveMap.filterLabel });
    await expect(vans.getByRole("button")).toHaveCount(3);

    // At this second the day has exactly one of each (png/live-map.png's own summary).
    await filters.getByRole("button", { name: liveMap.filterLate }).click();
    await expect(vans.getByRole("button")).toHaveCount(1);
    await expect(vans.getByRole("button")).toContainText(liveMap.chips.late);

    await filters.getByRole("button", { name: liveMap.filterNoGps }).click();
    await expect(vans.getByRole("button")).toHaveCount(1);
    await expect(vans.getByRole("button")).toContainText(liveMap.chips.noGps);

    await filters.getByRole("button", { name: fill(liveMap.filterAll, { count: 3 }) }).click();
    await expect(vans.getByRole("button")).toHaveCount(3);
  });

  /* live-map.html: clicking a van in the list selects it. A SELECTED van takes a BORDER, never
     a fill in its own colour — Firia, 2026-10-17 11:25 PM ET. */
  test("selecting a van gives it a border and no fill in its own colour", async ({ page }) => {
    await savePlan(page);
    await openMap(page);
    const row = page.getByRole("list", { name: liveMap.vansHeading }).getByRole("button").first();

    const before = await row.evaluate((el) => {
      const s = getComputedStyle(el);
      return { bg: s.backgroundColor, border: s.borderLeftColor, width: s.borderLeftWidth };
    });
    await row.click();
    await expect(row).toHaveAttribute("aria-pressed", "true");
    const after = await row.evaluate((el) => {
      const s = getComputedStyle(el);
      return { bg: s.backgroundColor, border: s.borderLeftColor, width: s.borderLeftWidth };
    });

    // The border changed: that is what "selected" looks like.
    expect(after.border, "a selected van must take a border").not.toBe(before.border);
    expect(parseFloat(after.width)).toBeGreaterThan(0);
    // And whatever the background became, it is not the van's own colour.
    const vanColours = Object.values(VAN_COLORS).map(hexToRgb);
    expect(vanColours, "a selected van must never be filled in its own colour").not.toContain(
      after.bg,
    );
  });

  test("collapses the map credits behind an (i) that opens them", async ({ page }) => {
    await savePlan(page);
    await openMap(page);
    await mapDrawn(page);

    /*
     * png/live-map.png has no licence strip across the bottom of the map, and ADR-008 / §5.1
     * require the credits to be present and never removed. Both at once: the text is in the
     * page from the first paint, collapsed, and the (i) opens it.
     */
    const credits = page.locator(".maplibregl-ctrl-attrib-inner");
    await expect(credits).toBeAttached();
    await expect(credits).toBeHidden();

    const toggle = page.getByLabel(liveMap.credits);
    await expect(toggle).toBeVisible();
    await toggle.click();
    await expect(credits).toBeVisible();
    await expect(credits).toContainText("OpenStreetMap");
    await toggle.click();
    await expect(credits).toBeHidden();
  });

  /*
   * Firia, 2026-10-17 11:25 PM ET: a van's square in the list, its line, its pin and its legend
   * swatch are ONE colour, from VAN_COLORS in src/ui/tokens.ts. Three of those four are in the
   * DOM; the pin is inside a WebGL canvas, so the pane publishes MapLibre's own paint for it.
   */
  test("gives each van its own colour from the tokens, in the list and on the map", async ({
    page,
  }) => {
    await savePlan(page);
    await openMap(page);
    const pane = await mapDrawn(page);

    const swatches = await page
      .locator("[data-van-swatch]")
      .evaluateAll((els) =>
        els.map((el) => ({
          number: Number(el.getAttribute("data-van-swatch")),
          colour: getComputedStyle(el).backgroundColor,
        })),
      );
    expect(swatches.length).toBe(3);
    const expected = [VAN_COLORS.van1, VAN_COLORS.van2, VAN_COLORS.van3].map(hexToRgb);
    for (const swatch of swatches) {
      expect(swatch.colour, `Van ${swatch.number}'s square`).toBe(expected[swatch.number - 1]);
    }

    // And the pin MapLibre drew for each van is the same literal.
    const drawn = (await pane.getAttribute("data-van-colors")) ?? "";
    expect(drawn, "the pane published no van colours").not.toBe("");
    for (const pair of drawn.split(",")) {
      const [number, colour] = pair.split(":");
      expect(colour.toUpperCase()).toBe(
        [VAN_COLORS.van1, VAN_COLORS.van2, VAN_COLORS.van3][Number(number) - 1],
      );
    }
  });

  /*
   * The other half of the same ruling: blue is van identity ONLY. Nothing in the chrome — the
   * rail, the header, a chip, a button, a filter — may be blue. tokens.test.ts holds it over the
   * token table; this holds it over the colours a browser actually computed.
   */
  test("paints no chrome blue: blue belongs to a van and nothing else", async ({ page }) => {
    await savePlan(page);
    await openMap(page);
    await mapDrawn(page);

    const offenders = await page.evaluate(() => {
      const out: { where: string; colour: string }[] = [];
      for (const el of Array.from(document.querySelectorAll("*"))) {
        // A van's own square, line and pin are the exception the ruling carves out.
        if ((el as HTMLElement).dataset?.vanSwatch !== undefined) continue;
        const s = getComputedStyle(el);
        for (const [prop, value] of [
          ["background", s.backgroundColor],
          ["color", s.color],
          ["border", s.borderTopColor],
        ] as const) {
          const m = value.match(/^rgba?\((\d+), (\d+), (\d+)/);
          if (!m) continue;
          if (value.startsWith("rgba") && value.endsWith(", 0)")) continue;
          out.push({ where: `${el.tagName}.${(el.className || "").toString().slice(0, 30)} ${prop}`, colour: value });
        }
      }
      return out;
    });

    const blue = offenders.filter((o) => isBlue(rgbToHex(o.colour)));
    expect(blue, `blue is van identity only (Firia, 11:25 PM ET): ${JSON.stringify(blue.slice(0, 5))}`)
      .toEqual([]);
  });

  /*
   * NO ETAs ANYWHERE (Firia's goal-5 brief; REDESIGN-SPEC §3 deletes the 13-field ETA line).
   * Asserted over the whole rendered text rather than over a list of elements, because the point
   * is that there is nowhere on this screen a time of arrival can be.
   */
  test("shows no ETA anywhere in the DOM", async ({ page }) => {
    await savePlan(page);
    await openMap(page);
    await mapDrawn(page);

    // The one place a clock time is allowed is the Auto texts feed (a text that was sent) and
    // the DEMO bar's own clock, which is the frame's. Everything else is read without them.
    const main = page.locator("main");
    const text = await main.innerText();

    expect(text, "an ETA window").not.toMatch(/\d{1,2}:\d{2}\s*[–-]\s*\d{1,2}:\d{2}/);
    expect(text, "a delta like +12 min").not.toMatch(/[+−-]\d+\s*min/);
    expect(text, 'the word "ETA"').not.toMatch(/\bETA\b/i);
    expect(text, '"last seen"').not.toMatch(/last seen/i);
    expect(text, '"On time", which is an ETA by another name').not.toMatch(/\bOn time\b/);
    // The van list itself carries no time of any kind.
    const list = await page.getByRole("list", { name: liveMap.vansHeading }).innerText();
    expect(list).not.toMatch(/\d{1,2}:\d{2}/);
  });

  /*
   * NO INTERNAL CODE ANYWHERE (MOCKUP-TEST-CONTRACT.md §Rules 6, the global check on every
   * screen and role; COPY-GUIDE §1–§2). This caught a real one: the Auto texts feed was printing
   * the route stop's family *key* — "F7 · Van 1" — where png/live-map.png reads "Kim P. · Van 2".
   */
  test("prints no internal code: not a V-code, not a family key, not a 24-hour time", async ({
    page,
  }) => {
    await savePlan(page);
    await openMap(page);
    await mapDrawn(page);
    const text = await page.locator("main").innerText();

    expect(text, "a V-code").not.toMatch(/\bV\d\b/);
    expect(text, "a family key").not.toMatch(/\bF\d{1,2}\b/);
    expect(text, "a child token").not.toMatch(/\bC\d{1,2}\b/);
    expect(text, "a provider code").not.toMatch(/\bP\d\b/);
    expect(text, "a 24-hour time").not.toMatch(/\b([01]\d|2[0-3]):[0-5]\d\b(?!\s*(AM|PM))/);
    expect(text, "a raw route id").not.toMatch(/\broute\d\b/);
    expect(text, "a stop key").not.toMatch(/\bS\d{1,2}\b/);

    // And every line of the feed that names somebody names a person, the way the mockup does.
    const feed = await page.getByRole("region", { name: liveMap.feedHeading }).innerText();
    expect(feed).toMatch(/\d{1,2}:\d{2} (AM|PM)/);
    expect(feed).not.toMatch(/\bF\d/);
  });

  /* The §7.1 / NFR-09 chip, which is the DEMO bar's and not this page's: one on the screen. */
  test("shows the Simulated chip once, in the DEMO bar, because the GPS is simulated", async ({
    page,
  }) => {
    await savePlan(page);
    await openMap(page);
    const chips = page.locator('[data-token="src-sim"]');
    await expect(chips).toHaveCount(1);
    await expect(chips).toContainText(sourceMode.SIMULATED);
    // It is in the frame, not in the screen: a page mounting a second one is the bug this caught.
    expect(
      await chips.evaluate((el) => el.closest("main") === null && document.querySelector("main") !== null),
    ).toBe(true);
  });
});

/* ══════════════════ the four chips, one scenario second at a time ══════════════════ */

/**
 * Firia's goal-5 brief: exactly one of On route, At stop, Late, No GPS. The derivation is proved
 * over the whole simulated day without a browser (src/modules/live-map/van-state.test.ts); these
 * drive the simulated source to each state and prove the chip reaches the screen.
 */
test.describe("one chip per van, and all four of them", () => {
  test.use({ viewport: DESK });

  const CASES = [
    { chip: liveMap.chips.atStop, at: AT.ALL_AT_STOP, note: "every van standing in a stop's geofence" },
    { chip: liveMap.chips.onRoute, at: AT.ALL_ON_ROUTE, note: "every van moving on a fresh fix" },
    { chip: liveMap.chips.late, at: AT.MOCKUP, note: "the stalled run, past the 10-minute threshold" },
    { chip: liveMap.chips.noGps, at: AT.MOCKUP, note: "the run whose GPS has gone quiet" },
  ];

  for (const { chip, at, note } of CASES) {
    test(`shows "${chip}" — ${note}`, async ({ page }) => {
      await savePlan(page);
      await openMap(page, at);
      const vans = page.getByRole("list", { name: liveMap.vansHeading });
      await expect(vans.getByText(chip, { exact: true }).first()).toBeVisible();
    });
  }

  test("never gives one van two chips, whatever the clock says", async ({ page }) => {
    await savePlan(page);
    for (const at of Object.values(AT)) {
      await openMap(page, at);
      const rows = await page
        .getByRole("list", { name: liveMap.vansHeading })
        .getByRole("button")
        .all();
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        await expect(row.locator('[data-pill="true"]')).toHaveCount(1);
      }
    }
  });
});

/* ══════════════════════ 390 — png/live-map-390.png ══════════════════════ */

test.describe("the Live map at 390", () => {
  test.use({ viewport: PHONE });

  test("puts the map on top and the vans in cards under it", async ({ page }) => {
    const failures: string[] = [];
    page.on("pageerror", (e) => failures.push(e.message));

    await savePlan(page);
    await openMap(page);
    const pane = await mapDrawn(page);

    // png/live-map-390.png: the title and the leg switch are in the header; the counts are NOT
    // drawn at this width (live-map.html `@media (max-width:480px){ .top>.chip{display:none} }`).
    await expect(page.getByRole("heading", { level: 1, name: liveMap.heading })).toBeVisible();
    await expect(
      page.getByRole("group", { name: liveMap.legLabel }).getByRole("link", {
        name: planRoutes.directionButton.AM,
      }),
    ).toBeVisible();
    await expect(page.getByText(fill(liveMap.countOnRoute, { count: 1 }))).toBeHidden();

    // The map is ABOVE the first van card, which is the whole of the phone layout.
    const mapBox = await pane.boundingBox();
    const firstVan = page.getByRole("list", { name: liveMap.vansHeading }).getByRole("button").first();
    const vanBox = await firstVan.boundingBox();
    expect(mapBox && vanBox && mapBox.y < vanBox.y, "the map must sit above the vans at 390").toBe(true);

    // The filters and the three cards are all there, and each card still carries one chip.
    const filters = page.getByRole("group", { name: liveMap.filterLabel });
    await expect(filters.getByRole("button", { name: liveMap.filterLate })).toBeVisible();
    const rows = page.getByRole("list", { name: liveMap.vansHeading }).getByRole("button");
    await expect(rows).toHaveCount(3);
    for (const row of await rows.all()) {
      expect(await row.getAttribute("aria-label")).toMatch(/^Van \d · \S/);
      await expect(row.locator('[data-pill="true"]')).toHaveCount(1);
      // §9: every row is a target a thumb can hit.
      const box = await row.boundingBox();
      expect(box!.height).toBeGreaterThanOrEqual(44);
    }

    // The phone tab bar is the menu at this width, and the map is the current tab.
    await expect(page.getByRole("link", { name: liveMap.heading })).toHaveAttribute(
      "aria-current",
      "page",
    );

    mkdirSync(ARTIFACTS, { recursive: true });
    await page.screenshot({ path: path.join(ARTIFACTS, "live-map-390.png") });
    expect(failures, `page errors: ${failures.join("; ")}`).toEqual([]);
  });

  test("keeps no ETA at 390 either", async ({ page }) => {
    await savePlan(page);
    await openMap(page);
    const text = await page.locator("main").innerText();
    expect(text).not.toMatch(/\bETA\b/i);
    expect(text).not.toMatch(/[+−-]\d+\s*min/);
  });
});

/* ══════════════════════ locked until a plan is saved (§9.1, §9.5) ══════════════════════ */

test.describe("locked until a plan is saved", () => {
  for (const [name, viewport] of [["1440", DESK], ["390", PHONE]] as const) {
    test(`shows "No routes yet" over the map and no vans at ${name}`, async ({ page }) => {
      await page.setViewportSize(viewport);
      // Deliberately NO savePlan(): this is the screen on a day nobody has planned.
      await page.goto("/live-map?leg=pm");
      await expect(page.getByRole("heading", { level: 1, name: liveMap.heading })).toBeVisible();

      // §9.5: the card is over the map, never instead of it.
      await expect(page.getByText(liveMap.lockedHeading)).toBeVisible();
      await expect(page.getByRole("region", { name: liveMap.mapLabel })).toBeVisible();
      await expect(page.locator("main").getByRole("link", { name: liveMap.lockedAction })).toBeVisible();

      // And there is no fleet on a day nobody planned.
      await expect(
        page.getByRole("list", { name: liveMap.vansHeading }).getByRole("button"),
      ).toHaveCount(0);
      await expect(page.getByText(fill(liveMap.countOnRoute, { count: 0 }))).toBeAttached();
    });
  }

  /*
   * The transition, walked on the AFTERNOON and not the morning.
   *
   * The saved plan lives in this one server process for the whole run (there is no database to
   * reset), so a test that wanted the morning to start locked would depend on running before
   * every other test in this file. The afternoon is saved by nothing else, so this walk is true
   * whatever order it runs in — which is the only kind of test worth having here.
   */
  test("unlocks once the board has saved a plan for that leg", async ({ page }) => {
    await page.setViewportSize(DESK);
    await page.goto("/live-map?leg=pm");
    await expect(page.getByText(liveMap.lockedHeading)).toBeVisible();

    await savePlan(page, "PM");

    await page.goto(`/live-map?leg=pm&at=${AT.MOCKUP}`);
    await expect(page.getByRole("heading", { level: 1, name: liveMap.heading })).toBeVisible();
    await expect(page.getByText(liveMap.lockedHeading)).toHaveCount(0);
    await expect(
      page.getByRole("list", { name: liveMap.vansHeading }).getByRole("button"),
    ).toHaveCount(3);
  });

  /*
   * The gate is per leg (§9.1): saving one leg does not open the other. Asserted from the
   * morning's side, so it does not care whether the afternoon walk above has run — saving the
   * morning here and reading the morning back proves the save reached that leg and only it.
   */
  test("gates each leg on its own plan", async ({ page }) => {
    await page.setViewportSize(DESK);
    await savePlan(page, "AM");
    await page.goto(`/live-map?leg=am&at=${AT.MOCKUP}`);
    await expect(page.getByText(liveMap.lockedHeading)).toHaveCount(0);
    await expect(
      page.getByRole("list", { name: liveMap.vansHeading }).getByRole("button"),
    ).toHaveCount(3);
  });
});

/* ══════════════════════ the front desk (Firia, 2026-10-17 3:08 PM ET) ══════════════════════ */

/**
 * > "Front desk gets two tabs, Live map (their home) and Ramp iPad."
 *
 * A separate server, because the role is the server's (`E2E_DEMO_ROLE`). The access-table half
 * of this is asserted without a browser in src/modules/live-map/roles.test.ts; this is the walk.
 */
test.describe("the front desk", () => {
  test.use({ viewport: DESK });

  test.skip(
    process.env.E2E_DEMO_ROLE !== "FRONT_DESK",
    "run with E2E_DEMO_ROLE=FRONT_DESK (see artifacts/rework-livemap/PR-BODY.md)",
  );

  test("lands on the Live map, with a menu of exactly Live map and Ramp iPad", async ({ page }) => {
    // Their home is the map: asking for the app at all puts them on it, with no toast.
    await page.goto("/");
    await expect(page).toHaveURL(/\/live-map/);
    await expect(page.getByRole("heading", { level: 1, name: liveMap.heading })).toBeVisible();
    await expect(page.locator("[data-notice]")).toHaveCount(0);

    // Two menu items, in order, and the account block is not one of them.
    const menu = page.locator("nav a:not([data-rail-account])");
    const hrefs = await menu.evaluateAll((as) =>
      as.map((a) => a.getAttribute("href")).filter((h) => h && !h.startsWith("#")),
    );
    expect([...new Set(hrefs)]).toEqual(["/live-map", "/ramp-ipad"]);
  });

  test("gets no scenario or demo controls on it", async ({ page }) => {
    await page.goto("/live-map?leg=am");
    await expect(page.getByRole("heading", { level: 1, name: liveMap.heading })).toBeVisible();

    // The clock's controls are a demo control, and this role does not hold them
    // (src/domain/access/map-view.ts `clockControls`).
    for (const label of [liveMap.pause, liveMap.play, liveMap.restart]) {
      await expect(page.getByRole("button", { name: label, exact: true })).toHaveCount(0);
    }
    await expect(page.getByRole("button", { name: /^×\d+$/ })).toHaveCount(0);
    // And Restart demo day is the director's (POST /api/demo/reset is 403 for everyone else).
    await expect(page.getByRole("button", { name: demoDay.restart })).toHaveCount(0);
  });
});

/* ───────────────────────────── helpers ───────────────────────────── */

/** `#1D4ED8` → `rgb(29, 78, 216)`, which is what `getComputedStyle` hands back. */
function hexToRgb(hex: string): string {
  const h = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((o) => parseInt(h.slice(o, o + 2), 16));
  return `rgb(${r}, ${g}, ${b})`;
}

/** `rgb(29, 78, 216)` → `#1D4ED8`, so the shared `isBlue` classifier can judge it. */
function rgbToHex(value: string): string {
  const m = value.match(/^rgba?\((\d+), (\d+), (\d+)/);
  if (!m) return "#000000";
  return `#${[1, 2, 3].map((i) => Number(m[i]).toString(16).padStart(2, "0")).join("")}`;
}
