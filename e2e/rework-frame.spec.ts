/**
 * THE REWORKED FRAME, MEASURED — every screen this role can reach, at the phone width and at
 * the founder's laptop.
 *
 * Vera's walk of PR #71 at 4bdd034 is the list this file answers, item by item, on a real
 * browser rather than in the source:
 *  - `/family-texts` answered 404 from a menu that linked to it — so nothing on the menu may
 *    404, and the three addresses that were missing are walked as well;
 *  - the menu itself had to be on every one of them, in the shape that width draws (the rail at
 *    1440, the bottom tab bar at 390) and with no hamburger anywhere;
 *  - "Simulated" was on the board 57 times and on the live map 4 — one visible chip per screen,
 *    and it is the one in the DEMO bar;
 *  - "Wed, Oct 14" was at the top of a board being looked at on the 17th;
 *  - "Restart demo day" must be in the DEMO bar and must not exist at all for the front desk;
 *  - Today's step strip has to be three cards that each open a screen this role can open;
 *  - and the thing the whole redesign is about: leaving a screen and coming back without the
 *    browser being the only way around — which is checked here by using the browser's Back
 *    button *deliberately* and finding the frame still there.
 *
 * One run is one role: `E2E_DEMO_ROLE` is read by the server process (playwright.config.ts), so
 * this file adapts to the role it was started as and the three roles are three runs. What it
 * walks is that role's own menu, from the same `navItemsFor` the rail filters with.
 *
 * No database and no credentials: the test-only synthetic session grants a role and nothing
 * else, and is refused outright on any deployment.
 */
import { mkdirSync } from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import type { StaffRole } from "../src/auth/core";
import { deriveReadiness, unreadFacts } from "../src/domain/day/readiness";
import { legAt, serviceDateAt } from "../src/domain/day/day-facts";
import { demoDay, flow, nav, sourceMode } from "../src/ui/copy";
import { navItemsFor } from "../src/ui/nav-items";
import { stepsFor } from "../src/ui/step-strip";
import { splitTabs } from "../src/ui/TabBar";
import { ARTIFACTS, expectDemoBarPinned } from "./helpers";

/** The role playwright.config.ts started the server as. Its default is the director. */
const ROLE = (process.env.E2E_DEMO_ROLE ?? "DIRECTOR") as StaffRole;

/** This role's menu, and what of it has a tab of its own below 768 (REDESIGN-SPEC §9.2). */
const MENU = navItemsFor(ROLE);
const TABS = splitTabs(MENU).tabs;

/**
 * The addresses walked on top of the menu. All three were a gap in the walk: `/whoami` rendered
 * with no frame at all, and `/family-texts` and `/approvals` did not exist — `/family-texts` as
 * a 404 behind a menu item, `/approvals` as the queue §9.2 reaches from it.
 */
const EXTRA = ["/whoami", "/family-texts", "/approvals"];

const ROUTES = [...MENU.map((item) => item.href), ...EXTRA];

const WIDTHS = [390, 1440] as const;

/**
 * The day this run's server reads, which is no day at all: the synthetic session is a role with
 * no site behind it (src/auth/caller.ts), so the readiness loader has nothing to read a centre's
 * rows for and answers with the unread day — Needed, Needed, Locked
 * (src/domain/day/day-facts.ts). Derived here through the same function the server uses rather
 * than written out, so this file cannot drift from it, and deterministic by the shape of the
 * session rather than by an environment variable a deployment could set.
 */
const READINESS = deriveReadiness(unreadFacts(serviceDateAt(), legAt()));
const STEPS = stepsFor(ROLE, READINESS);

const slug = (href: string) => href.replace(/^\//, "") || "home";

/** This run's screenshots, one folder, named `<role>-<route>-<width>.png`. */
async function shotOf(page: Page, href: string, width: number): Promise<string> {
  const dir = path.join(ARTIFACTS, "rework-frame");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${ROLE.toLowerCase()}-${slug(href)}-${width}.png`);
  await page.screenshot({ path: file });
  return file;
}

/**
 * Text a person can actually see, matched.
 *
 * `innerText` is the wrong instrument for this: the §7.1 source chip and the board's per-record
 * sources write "Source: Simulated" for a screen reader in a clipped `.srOnly` span, and a
 * count taken off `innerText` reads those as being on the screen. So this walks the text nodes
 * and drops any inside an `.srOnly`, inside a `display: none` box (the bar's "Synthetic data"
 * below 768, the rail at phone width) or in a box the layout gave no size to.
 *
 * `aria-hidden` is deliberately *not* a reason to skip: the source chip's visible label is
 * aria-hidden precisely because the screen-reader text beside it already says it, so an
 * aria-hidden subtree is often the half a person actually reads. What is being counted here is
 * what the eye sees, which is the opposite question from what a screen reader hears.
 */
async function visibleMatches(page: Page, pattern: string): Promise<string[]> {
  return page.evaluate((source) => {
    const re = new RegExp(source, "g");
    const out: string[] = [];
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walk.nextNode(); node; node = walk.nextNode()) {
      const text = node.textContent ?? "";
      const found = text.match(re);
      if (!found) continue;
      let el: HTMLElement | null = node.parentElement;
      let hidden = false;
      while (el) {
        if (el.classList.contains("srOnly")) {
          hidden = true;
          break;
        }
        const style = getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden") {
          hidden = true;
          break;
        }
        el = el.parentElement;
      }
      if (!hidden && (node.parentElement?.getClientRects().length ?? 0) > 0) out.push(...found);
    }
    return out;
  }, pattern);
}

/**
 * The frame, at this width: one brand, one identity, the menu this width draws — and not the
 * other one — and nothing to open to find it. Returns the menu, because every caller's next
 * question is about what is in it.
 */
async function expectFrame(page: Page, width: number, where: string) {
  const rail = page.getByRole("navigation", { name: nav.landmarkLabel });
  const brand = page.locator("[data-rail-brand]");
  const railAccount = page.locator("[data-rail-account]");
  const headerAccount = page.locator("header details");
  /*
   * WHERE THE IDENTITY AND THE BRAND ARE, and that there is one of each (REDESIGN-SPEC §9.2,
   * Firia 7:55 PM ET). At 1280 and up the rail carries both — the brand block at its head, the
   * account block at its foot — and the white header that used to duplicate them is gone, so
   * the rail runs full height as the mockup draws it. Below 1280 the rail has no room for
   * words, so the header is back with the name and the account menu that holds Sign out.
   */
  if (width >= 1280) {
    await expect(brand, `no brand block on ${where} at ${width}`).toBeVisible();
    await expect(railAccount, `no account block on ${where} at ${width}`).toBeVisible();
    await expect(headerAccount, `a second identity on ${where} at ${width}`).toBeHidden();
  } else {
    await expect(page.locator("header").first(), `no header on ${where} at ${width}`).toBeVisible();
    await expect(headerAccount, `no account menu on ${where} at ${width}`).toBeVisible();
    await expect(railAccount, `a second identity on ${where} at ${width}`).toBeHidden();
  }
  const bar = page.locator("[data-tab-bar]");
  // The hamburger and its drawer are deleted (Firia, 2026-10-17 3:08 PM ET), at every width.
  await expect(page.getByRole("button", { name: /menu/i }), `a hamburger on ${where}`).toHaveCount(0);
  await expect(page.locator("[data-nav-drawer]"), `a drawer on ${where}`).toHaveCount(0);
  if (width < 768) {
    await expect(bar, `no tab bar on ${where} at ${width}`).toBeVisible();
    await expect(rail, `the desk rail is on screen at ${width} as well`).toBeHidden();
    return bar;
  }
  await expect(rail, `no menu on ${where} at ${width}`).toBeVisible();
  await expect(bar, `the phone tab bar is on screen at ${width} as well`).toBeHidden();
  return rail;
}

for (const width of WIDTHS) {
  test.describe(`the reworked frame, as ${ROLE} at ${width}px`, () => {
    test.use({ viewport: { width, height: width < 768 ? 844 : 900 } });

    test("every screen this role reaches has the frame, one chip, and no fixture date", async ({
      page,
    }) => {
      expect(MENU.length, `${ROLE} has no menu at all`).toBeGreaterThan(0);

      for (const href of ROUTES) {
        const response = await page.goto(href);
        const status = response?.status();
        /*
         * Nothing on the menu 404s — the founder's rule, and the thing `/family-texts` broke on
         * production. The three extras are held to it too: a role that may not open one is
         * redirected to its own home (§9.3), which is a 200 on the screen it lands on, never a
         * 404 and never a dead end.
         */
        expect(status, `${href} answered ${status}`).not.toBe(404);
        await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

        const where = new URL(page.url()).pathname;
        const menu = await expectFrame(page, width, where);
        await expect(menu.getByRole("link")).toHaveCount(width < 768 ? TABS.length : MENU.length);

        // The one DEMO bar, pinned, with the one §7.1 chip riding in it.
        await expectDemoBarPinned(page);

        /*
         * EXACTLY ONE VISIBLE "Simulated" — the chip in the bar. The board used to carry 56
         * more down its right-hand edge and the live map three under the vans; the per-record
         * source is screen-reader text now, so the requirement (NFR-09: every record carries
         * its source) and the review (one chip per screen) are both met.
         */
        const simulated = await visibleMatches(page, sourceMode.SIMULATED);
        expect(simulated, `visible "Simulated" on ${where} at ${width}`).toHaveLength(1);

        /*
         * NO FIXTURE DATE. The scenario replays a seeded Wednesday and every screen prints the
         * day the demo is being given on instead (src/ui/service-date.ts). "Oct 14" is the one
         * that was on screen; the assertion is the general one, so next week's is caught too.
         */
        expect(await visibleMatches(page, "Oct\\s+14"), `a fixture date on ${where}`).toEqual([]);

        /*
         * THE DEMO'S ONE CONTROL, and who may see it. The front desk never does — not hidden in
         * CSS, not in the DOM — and `POST /api/demo/reset` refuses them besides
         * (src/app/api/demo/reset/route.test.ts). It is one role's control, so for the others
         * all that is claimed is that neither label is loose on the screen.
         */
        const restart = page.locator("[data-demo-restart]");
        if (ROLE === "FRONT_DESK") {
          await expect(restart, `the front desk is being offered the reset on ${where}`).toHaveCount(0);
          expect(await page.locator("body").innerText()).not.toMatch(
            /Restart demo day|Start demo day/,
          );
        } else if (ROLE === "DIRECTOR") {
          // In the bar, at the trailing end, and reading exactly the one label.
          await expect(restart).toHaveText(demoDay.restart);
          expect(
            await restart.evaluate((el) => {
              const bar = document.querySelector('[role="status"][aria-label="DEMO"]')?.parentElement;
              return bar?.contains(el) ?? false;
            }),
            "the restart is not inside the DEMO bar",
          ).toBe(true);
        }
        // Whoever is looking, there is no second one and no "Start demo day" left anywhere.
        expect(await visibleMatches(page, "Start demo day")).toEqual([]);
        await expect(restart).toHaveCount(ROLE === "DIRECTOR" ? 1 : 0);

        console.log("screenshot:", await shotOf(page, where, width));
      }
    });

    /**
     * TODAY'S STEP STRIP: three cards, each saying what its own step actually stands at, and
     * never a link this role would be bounced from (REDESIGN-SPEC §9.2).
     *
     * The states here are the ones a shell with no database shows — Needed, Needed, Locked —
     * because that is what this run is: a role with no site behind it, so the readiness loader
     * reads nothing and says so rather than claiming anything is done. That makes the whole
     * strip deterministic without a seed and without a flag.
     *
     * A front desk sees all three cards and can open one, so the two they cannot open are plain
     * text rather than links to a 403 — which is why the hrefs are checked against the access
     * table's own answer, through the same function the page renders from.
     */
    test("the step strip is three steps, each saying where that step stands", async ({ page }) => {
      test.skip(!MENU.some((item) => item.href === "/today"), "Today is not on this role's menu");
      await page.goto("/today");
      const strip = page.getByRole("navigation", { name: flow.stepsAria });
      await expect(strip).toBeVisible();
      await expect(strip.locator("li")).toHaveCount(3);

      /*
       * THE SHOT OF THE STRIP, taken here — on Today, before anything is clicked. It used to be
       * taken at the end of this test, after the walk below had clicked through to the last
       * step, so the file called "today-steps" was a picture of the live map (Vera's read of
       * the artifacts). One shot of the strip, then one per destination, each named after what
       * is in it.
       */
      console.log("screenshot:", await shotOf(page, "/today-steps", width));

      // Every card says its step, its state and the one line its own data gives it.
      for (const step of STEPS) {
        const card = strip.locator(`[data-step="${step.key}"]`);
        await expect(card, `no ${step.key} card`).toHaveCount(1);
        await expect(card).toHaveAttribute("data-state", step.state);
        await expect(card).toContainText(step.label);
        await expect(card).toContainText(step.detail);
      }

      // The first card that is not done is the one marked as the step to take next, and it is
      // marked once — a strip with three "do this next" markers says nothing at all.
      const current = strip.locator('[aria-current="step"]');
      await expect(current).toHaveCount(1);
      await expect(current).toHaveAttribute(
        "data-step",
        STEPS.find((step) => step.current)!.key,
      );

      const linkable = STEPS.filter((step) => step.linked);
      const links = strip.getByRole("link");
      await expect(links).toHaveCount(linkable.length);
      const hrefs = await links.evaluateAll((els) => els.map((el) => el.getAttribute("href") ?? ""));
      expect(hrefs).toEqual(linkable.map((step) => step.href));

      /*
       * Each link goes where it says, inside the frame — and for a Locked card "where it says"
       * is the step it is waiting on: the live map's card opens Plan routes while nothing is
       * saved, and its accessible name says so rather than surprising the click.
       */
      for (const step of linkable) {
        await page.goto("/today");
        await strip.getByRole("link", { name: step.ariaLabel }).click();
        await page.waitForURL(`**${step.href}`);
        expect(new URL(page.url()).pathname).toBe(step.href);
        await expectFrame(page, width, step.href);
        console.log("screenshot:", await shotOf(page, `/step-${step.key}`, width));
      }
    });

    /**
     * THE WAY BACK. The founder's complaint was that the browser's Back button was the only way
     * out of three screens; the menu is the way out now, and Back has to work as well — a
     * screen that loses its frame when you come back to it is the same dead end one click later.
     */
    test("a menu item opens, and Back lands on the screen it left, with the frame on it", async ({
      page,
    }) => {
      const from = MENU[0].href;
      const to = TABS.find((item) => item.href !== from);
      expect(to, `${ROLE} has only one destination`).toBeDefined();

      await page.goto(from);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      const menu = await expectFrame(page, width, from);
      await menu.getByRole("link", { name: to!.label }).click();
      await page.waitForURL(`**${to!.href}`);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await expectFrame(page, width, to!.href);

      await page.goBack();
      await page.waitForURL(`**${from}`);
      expect(new URL(page.url()).pathname, "Back did not land on the screen it left").toBe(from);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await expectFrame(page, width, from);
    });
  });
}

/**
 * The phone's "More" tab, and the rules that make it a tab rather than the deleted hamburger:
 * the primary tabs stay on screen, the sheet is in the frame, every row is a §9 target, and it
 * closes on a selection, on Escape and on a tap outside, with focus managed both ways.
 *
 * Only for a role whose menu is longer than the bar's five slots — the front desk has two
 * destinations, so there is nothing to overflow and no tab to find.
 */
test.describe(`the phone's More tab, as ${ROLE}`, () => {
  test.use({ viewport: { width: 390, height: 844 } });

  const OVERFLOW = splitTabs(MENU).overflow;

  test("opens the rest of the menu in the frame, and closes three ways", async ({ page }) => {
    test.skip(OVERFLOW.length === 0, `${ROLE}'s menu fits the bar, so there is no More tab`);
    await page.goto(MENU[0].href);
    const bar = page.locator("[data-tab-bar]");
    const more = bar.locator("[data-more-tab]");

    // The four tabs beside it are on screen without a tap: that is the whole difference.
    await expect(bar.getByRole("link")).toHaveCount(TABS.length);
    await expect(more).toBeVisible();
    await expect(more).toHaveAttribute("aria-expanded", "false");
    expect((await more.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);

    // 1. It opens, and every row in it is this role's own destination and a §9 target.
    await more.click();
    const sheet = page.locator("[data-more-sheet]");
    await expect(sheet).toBeVisible();
    await expect(more).toHaveAttribute("aria-expanded", "true");
    const rows = sheet.getByRole("link");
    await expect(rows).toHaveCount(OVERFLOW.length);
    expect(await rows.evaluateAll((els) => els.map((el) => el.getAttribute("href") ?? ""))).toEqual(
      OVERFLOW.map((item) => item.href),
    );
    for (const row of await rows.all()) {
      expect((await row.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
    }
    // Focus went into it, so the next Tab is inside the sheet rather than past it (§9).
    expect(await sheet.evaluate((el) => el.contains(document.activeElement))).toBe(true);
    console.log("screenshot:", await shotOf(page, "/more-sheet", 390));

    // 2. Escape closes it and puts the focus back on the tab that opened it.
    await page.keyboard.press("Escape");
    await expect(sheet).toHaveCount(0);
    await expect(more).toBeFocused();

    // 3. A tap outside closes it.
    await more.click();
    await expect(sheet).toBeVisible();
    await page.mouse.click(195, 300);
    await expect(sheet).toHaveCount(0);

    // 4. Picking something closes it, and goes there — inside the frame, bar and all.
    await more.click();
    await sheet.getByRole("link", { name: OVERFLOW[0].label }).click();
    await page.waitForURL(`**${OVERFLOW[0].href}`);
    await expect(page.locator("[data-more-sheet]")).toHaveCount(0);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expectFrame(page, 390, OVERFLOW[0].href);
    // ...and the bar says where you are, even for a destination that has no tab of its own.
    await expect(bar.locator("[data-more-tab]")).toHaveAttribute("aria-current", "page");
  });
});
